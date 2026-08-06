import {
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  MeshBasicMaterial,
  type Texture,
  Vector2,
  type WebGLRenderer,
  type WebGLRenderTarget,
  ShaderMaterial,
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
  private simMaterial: any | null = null;
  private disturbanceMaterial: any | null = null;
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

    this.simMaterial = new MeshBasicMaterial({ color: 0x000000 });
    this.disturbanceMaterial = new MeshBasicMaterial({ color: 0x000000 });

    this.quad = new Mesh(new PlaneGeometry(2, 2), this.simMaterial);
    this.quad.frustumCulled = false;
    this.simScene.add(this.quad);
    this.ready = true;
  }

  /**
   * Advance the wave simulation by `delta` seconds.
   */
  step(renderer: any, _delta: number): void {
    return;
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
