import {
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  type Texture,
  Vector2,
  type WebGLRenderer,
} from 'three';
import type { CreateRippleOptions, Ripple } from '../types/Ripple';
import type { ResolvedWaterOptions } from '../types/WaterOptions';
import disturbanceFrag from '../shaders/disturbance.frag?raw';
import simulationFrag from '../shaders/simulation.frag?raw';
import simulationVert from '../shaders/simulation.vert?raw';
import { Disturbance } from './Disturbance';
import { HeightField } from './HeightField';

/**
 * Owns ripple propagation and water simulation state.
 *
 * Runs heightfield steps and queues disturbances. Does not own materials
 * or scene cameras.
 */
export class RippleSimulation {
  private readonly heightField: HeightField;
  private readonly disturbance: Disturbance;
  private readonly pending: Ripple[] = [];
  private readonly damping: number;
  private readonly speed: number;
  private readonly texelSize: Vector2;

  private readonly simScene = new Scene();
  private readonly simCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private simMaterial: ShaderMaterial | null = null;
  private disturbanceMaterial: ShaderMaterial | null = null;
  private quad: Mesh | null = null;
  private ready = false;
  private cleared = false;

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
    this.texelSize = new Vector2(1 / options.resolution, 1 / options.resolution);
  }

  /** Prepare GPU resources. */
  initialize(): void {
    this.heightField.initialize();

    this.simMaterial = new ShaderMaterial({
      uniforms: {
        uHeightMap: { value: null },
        uTexelSize: { value: this.texelSize.clone() },
        uDamping: { value: this.damping },
        uSpeed: { value: this.speed },
      },
      vertexShader: simulationVert,
      fragmentShader: simulationFrag,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.disturbanceMaterial = new ShaderMaterial({
      uniforms: {
        uHeightMap: { value: null },
        uCenter: { value: new Vector2() },
        uRadius: { value: 0.02 },
        uStrength: { value: 0.2 },
      },
      vertexShader: simulationVert,
      fragmentShader: disturbanceFrag,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.quad = new Mesh(new PlaneGeometry(2, 2), this.simMaterial);
    this.quad.frustumCulled = false;
    this.simScene.add(this.quad);
    this.ready = true;
  }

  /**
   * Advance the wave simulation by `delta` seconds.
   */
  step(renderer: WebGLRenderer, _delta: number): void {
    if (!this.ready || !this.simMaterial || !this.disturbanceMaterial || !this.quad) {
      return;
    }

    if (!this.cleared) {
      this.heightField.clear(renderer);
      this.cleared = true;
    }

    const read = this.heightField.read;
    const write = this.heightField.write;
    if (!read || !write) {
      return;
    }

    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;

    // Apply pending ripple stamps.
    for (const ripple of this.pending) {
      this.quad.material = this.disturbanceMaterial;
      this.disturbanceMaterial.uniforms.uHeightMap.value = this.heightField.readTexture;
      this.disturbanceMaterial.uniforms.uCenter.value.set(ripple.uv.u, ripple.uv.v);
      this.disturbanceMaterial.uniforms.uRadius.value = ripple.radius;
      this.disturbanceMaterial.uniforms.uStrength.value = ripple.strength;

      renderer.setRenderTarget(this.heightField.write);
      renderer.autoClear = true;
      renderer.render(this.simScene, this.simCamera);
      this.heightField.swap();
    }
    this.pending.length = 0;

    // Wave propagation substeps.
    const substeps = 3;
    this.quad.material = this.simMaterial;
    for (let i = 0; i < substeps; i += 1) {
      this.simMaterial.uniforms.uHeightMap.value = this.heightField.readTexture;
      renderer.setRenderTarget(this.heightField.write);
      renderer.autoClear = true;
      renderer.render(this.simScene, this.simCamera);
      this.heightField.swap();
    }

    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);
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
    this.simMaterial?.dispose();
    this.disturbanceMaterial?.dispose();
    this.quad?.geometry.dispose();
    this.heightField.dispose();
    this.simMaterial = null;
    this.disturbanceMaterial = null;
    this.quad = null;
    this.ready = false;
  }
}
