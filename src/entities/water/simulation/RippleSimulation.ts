import { type Texture, Vector2 } from 'three';
import type { StorageTexture } from 'three/webgpu';
import {
  Fn,
  clamp,
  distance,
  exp,
  float,
  globalId,
  ivec2,
  max,
  pow,
  smoothstep,
  textureLoad,
  textureStore,
  uniform,
  vec2,
  vec4,
} from 'three/tsl';
import type { CreateRippleOptions, Ripple } from '../types/Ripple';
import type { ResolvedWaterOptions } from '../types/WaterOptions';
import { HeightField } from './HeightField';
import { Disturbance } from './Disturbance';

/** 8x8 covers a 256² field in 1024 workgroups — a good occupancy fit. */
const WORKGROUP = [8, 8] as const;

/**
 * Owns ripple propagation and water simulation state.
 *
 * Runs heightfield steps and queues disturbances. Does not own materials
 * or scene cameras.
 *
 * The wave equation is a compute dispatch, not a draw. It reads a neighbourhood
 * and writes one texel — there is no geometry, no rasterisation and no blending
 * involved, so a render pass was pure overhead: four of them per frame, each
 * with its own attachments and pipeline state. Compute also lets the sim write
 * a storage texture directly instead of bouncing through a colour attachment.
 *
 * Kernels are built once per ping-pong direction rather than rebound each step.
 * A storage binding is baked into the pipeline, so swapping the textures on one
 * kernel would force a rebuild every frame; two kernels alternating costs one
 * extra pipeline and no rebuilds.
 */
export class RippleSimulation {
  private readonly heightField: HeightField;
  private readonly disturbance: Disturbance;
  private readonly pending: Ripple[] = [];
  private readonly damping: number;
  private readonly speed: number;
  private readonly resolution: number;

  private stepKernels: [any, any] | null = null;
  private disturbKernels: [any, any] | null = null;
  /** 0 = read A / write B, 1 = the reverse. Mirrors HeightField's swap. */
  private phase = 0;
  private ready = false;

  private readonly uCenter = uniform(new Vector2());
  private readonly uRadius = uniform(0.02);
  private readonly uStrength = uniform(0.2);

  constructor(
    options: Pick<
      ResolvedWaterOptions,
      'width' | 'height' | 'resolution' | 'damping' | 'speed'
    >,
  ) {
    this.heightField = new HeightField(options.resolution);
    this.disturbance = new Disturbance(options.width, options.height);
    this.damping = options.damping;
    this.speed = options.speed;
    this.resolution = options.resolution;
  }

  /** Prepare GPU resources. */
  initialize(): void {
    this.heightField.initialize();
    const a = this.heightField.read;
    const b = this.heightField.write;
    if (!a || !b) return;

    this.stepKernels = [this.buildStep(a, b), this.buildStep(b, a)];
    this.disturbKernels = [this.buildDisturb(a, b), this.buildDisturb(b, a)];
    this.ready = true;
  }

  /** Neighbour fetch, clamped to the edge so the border behaves like the old sampler. */
  private sample(src: StorageTexture, coord: any, dx: number, dy: number) {
    const last = this.resolution - 1;
    const c: any = (clamp as any)(coord.add(ivec2(dx, dy)), ivec2(0, 0), ivec2(last, last));
    return textureLoad(src, c);
  }

  private buildStep(src: StorageTexture, dst: StorageTexture) {
    const uDamping = uniform(this.damping);
    const uSpeed = uniform(this.speed);
    const res = this.resolution;

    return Fn(() => {
      const coord: any = ivec2(globalId.xy);

      // R = current height, G = previous height
      const center: any = this.sample(src, coord, 0, 0).toVar();
      const left = this.sample(src, coord, -1, 0).r;
      const right = this.sample(src, coord, 1, 0).r;
      const down = this.sample(src, coord, 0, -1).r;
      const up = this.sample(src, coord, 0, 1).r;

      const laplacian = left.add(right).add(down).add(up).mul(0.25).sub(center.r);
      const next = center.r
        .mul(2.0)
        .sub(center.g)
        .add(laplacian.mul(uSpeed))
        .mul(uDamping)
        .toVar();
      next.assign(clamp(next, -2.0, 2.0));

      // Soft edge absorb so waves die at borders.
      const p = vec2(coord).add(0.5).div(float(res));
      const edge = smoothstep(0.0, 0.04, p.x)
        .mul(smoothstep(1.0, 0.96, p.x))
        .mul(smoothstep(0.0, 0.04, p.y))
        .mul(smoothstep(1.0, 0.96, p.y));
      next.mulAssign(edge);

      textureStore(dst, coord, vec4(next, center.r, 0.0, 1.0)).toWriteOnly();
    })().compute([res, res] as any, [...WORKGROUP] as any);
  }

  private buildDisturb(src: StorageTexture, dst: StorageTexture) {
    const res = this.resolution;

    return Fn(() => {
      const coord: any = ivec2(globalId.xy);
      const data: any = this.sample(src, coord, 0, 0).toVar();
      const p = vec2(coord).add(0.5).div(float(res));

      const dist = distance(p, this.uCenter);
      const stamp = exp(
        pow(dist.div(max(this.uRadius, float(1e-4))), 2.0).negate(),
      ).mul(this.uStrength);

      textureStore(dst, coord, vec4(data.r.sub(stamp), data.g, 0.0, 1.0)).toWriteOnly();
    })().compute([res, res] as any, [...WORKGROUP] as any);
  }

  /**
   * Advance the wave simulation by `delta` seconds.
   */
  step(renderer: any, _delta: number): void {
    if (!this.ready || !this.stepKernels || !this.disturbKernels) {
      return;
    }

    // Apply pending ripple stamps.
    for (const ripple of this.pending) {
      this.uCenter.value.set(ripple.uv.u, ripple.uv.v);
      this.uRadius.value = ripple.radius;
      this.uStrength.value = ripple.strength;
      renderer.compute(this.disturbKernels[this.phase]);
      this.advance();
    }
    this.pending.length = 0;

    // Wave propagation substeps.
    for (let i = 0; i < 3; i += 1) {
      renderer.compute(this.stepKernels[this.phase]);
      this.advance();
    }
  }

  private advance(): void {
    this.heightField.swap();
    this.phase = this.phase === 0 ? 1 : 0;
  }

  /** Queue a world-space ripple for the next simulation step. */
  addDisturbance(options: CreateRippleOptions): void {
    this.pending.push(this.disturbance.create(options));
  }

  /** Latest heightfield texture for the water material. */
  get heightTexture(): Texture | null {
    return this.heightField.readTexture;
  }

  dispose(): void {
    this.pending.length = 0;
    this.heightField.dispose();
    this.stepKernels = null;
    this.disturbKernels = null;
    this.ready = false;
  }
}
