import { Mesh, PlaneGeometry, type BufferGeometry, type Texture, Vector3 } from 'three';
import { DEFAULT_WATER_OPTIONS } from '../core/Constants';
import { WaterMaterial } from '../materials/WaterMaterial';
import { WaterRenderer } from '../rendering/WaterRenderer';
import { RippleSimulation } from '../simulation/RippleSimulation';
import type { CreateRippleOptions, RipplePosition } from '../types/Ripple';
import type { ResolvedWaterOptions, WaterOptions } from '../types/WaterOptions';
import { getRippleXZ } from '../utils/Helpers';

/**
 * Public façade for the water system.
 *
 * Coordinates simulation, rendering passes, and the water material.
 * Does not contain rendering or simulation implementation details.
 */
export class Pond {
  /** Mesh to add to the consumer's scene. */
  readonly mesh: Mesh;

  private readonly options: ResolvedWaterOptions;
  private readonly simulation: RippleSimulation;
  private readonly material: WaterMaterial;
  private readonly waterRenderer: WaterRenderer;
  private elapsed = 0;
  private readonly _localRipple = new Vector3();

  constructor(options: WaterOptions) {
    this.options = {
      ...DEFAULT_WATER_OPTIONS,
      ...options,
      width: options.width,
      height: options.height,
    };

    this.material = new WaterMaterial({
      color: this.options.color,
      opacity: this.options.opacity,
      reflectivity: this.options.reflectivity,
      resolution: this.options.resolution,
      circular: this.options.circular,
      clarity: this.options.clarity,
      shoreSoftness: this.options.shoreSoftness,
      shoreFoam: this.options.shoreFoam,
      brightness: this.options.brightness,
      sunDirection: options.sunDirection,
    });
    this.material.initialize();

    this.simulation = new RippleSimulation({
      width: this.options.width,
      height: this.options.height,
      resolution: this.options.resolution,
      damping: this.options.damping,
      speed: this.options.speed,
    });
    this.simulation.initialize();

    this.waterRenderer = new WaterRenderer(this.material, this.options.resolution);

    const passWidth = this.options.renderer?.domElement.width || 1024;
    const passHeight = this.options.renderer?.domElement.height || 1024;
    this.waterRenderer.initialize(passWidth, passHeight);

    const geometry: BufferGeometry =
      options.geometry ??
      (() => {
        const plane = new PlaneGeometry(
          this.options.width,
          this.options.height,
          this.options.segments,
          this.options.segments,
        );
        plane.rotateX(-Math.PI / 2);
        return plane;
      })();

    const material = this.material.threeMaterial;
    if (!material) {
      throw new Error('[threejs-water] WaterMaterial failed to initialize.');
    }

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    if (geometry.boundingSphere) {
      geometry.boundingSphere.radius =
        Math.hypot(this.options.width, this.options.height) * 0.5 + 10;
    }

    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'Pond';
    this.mesh.frustumCulled = true;
  }

  /** Latest heightfield texture (for custom effects / debug). */
  get heightTexture(): Texture | null {
    return this.simulation.heightTexture;
  }

  /** Caustic intensity map generated each frame from the heightfield. */
  get causticsTexture(): Texture | null {
    return this.waterRenderer.causticsTexture;
  }

  /**
   * Advance simulation, update material, and optionally run reflection / refraction / caustics.
   * Pass `full: false` for cheap time-only ticks (many editor water tiles).
   */
  update(delta: number, options?: { full?: boolean }): void {
    this.elapsed += delta;

    const full = options?.full !== false;
    const { renderer, scene, camera } = this.options;

    if (full && renderer) {
      this.simulation.step(renderer, delta);
    }

    this.material.setTime(this.elapsed);
    if (full) {
      this.material.setHeightMap(this.simulation.heightTexture);
    }

    if (full && renderer && scene && camera) {
      this.waterRenderer.render(
        renderer,
        scene,
        camera,
        this.mesh,
        this.simulation.heightTexture,
      );
    }
  }

  /** Resize reflection / refraction targets (call from the host on window resize). */
  setSize(width: number, height: number): void {
    this.waterRenderer.setSize(width, height);
  }

  /** 0 = murky, 1 = crystal clear. */
  setClarity(value: number): void {
    this.material.setClarity(value);
  }

  /** 0 = hard circular edge, 1 = wide soft shore blend. */
  setShoreSoftness(value: number): void {
    this.material.setShoreSoftness(value);
  }

  /** Shore foam / bright rim intensity (0–1). */
  setShoreFoam(value: number): void {
    this.material.setShoreFoam(value);
  }

  /** Overall brightness multiplier. */
  setBrightness(value: number): void {
    this.material.setBrightness(value);
  }

  /** Sun direction for specular highlights. */
  setSunDirection(dir: Vector3 | { x: number; y: number; z: number }): void {
    this.material.setSunDirection(dir);
  }

  /**
   * Inject a ripple at a world-space position.
   * Accepts a `Vector3` or a full {@link CreateRippleOptions} object.
   * Hit points are converted into the pond mesh's local space so ripples
   * appear under the cursor.
   */
  createRipple(positionOrOptions: RipplePosition | CreateRippleOptions): void {
    const options: CreateRippleOptions =
      this.isCreateRippleOptions(positionOrOptions)
        ? positionOrOptions
        : { position: positionOrOptions };

    const { x, z } = getRippleXZ(options.position);
    const y =
      'y' in options.position && typeof options.position.y === 'number'
        ? options.position.y
        : this.mesh.position.y;

    this._localRipple.set(x, y, z);
    this.mesh.worldToLocal(this._localRipple);

    this.simulation.addDisturbance({
      ...options,
      position: { x: this._localRipple.x, z: this._localRipple.z },
    });
  }

  /** Release GPU and CPU resources owned by this pond. */
  dispose(): void {
    this.simulation.dispose();
    this.waterRenderer.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }

  private isCreateRippleOptions(
    value: RipplePosition | CreateRippleOptions,
  ): value is CreateRippleOptions {
    return (
      typeof value === 'object' &&
      value !== null &&
      'position' in value &&
      (value as CreateRippleOptions).position !== undefined
    );
  }
}
