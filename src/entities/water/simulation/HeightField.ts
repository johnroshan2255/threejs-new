import {
  ClampToEdgeWrapping,
  FloatType,
  NearestFilter,
  RGBAFormat,
  type Texture,
} from 'three';
import { StorageTexture } from 'three/webgpu';

/**
 * GPU heightfield storage (ping-pong storage textures).
 *
 * Owns simulation buffers and exposes read/write textures.
 * Does not run the wave equation — that lives in {@link RippleSimulation}.
 *
 * These are `StorageTexture`s rather than render targets because the simulation
 * is a compute dispatch, not a draw. A render target would drag along a whole
 * render pass — attachments, viewport, pipeline state — to run what is really
 * just a stencil over a 2D array.
 */
export class HeightField {
  readonly resolution: number;

  private readTexture_: StorageTexture | null = null;
  private writeTexture_: StorageTexture | null = null;
  private originalTextures_: [StorageTexture, StorageTexture] | null = null;

  constructor(resolution: number) {
    this.resolution = resolution;
  }

  /** Allocate the ping-pong pair. */
  initialize(): void {
    if (this.readTexture_ && this.writeTexture_) {
      return;
    }

    this.readTexture_ = this.createTexture();
    this.writeTexture_ = this.createTexture();
    this.originalTextures_ = [this.readTexture_, this.writeTexture_];
  }

  private createTexture(): StorageTexture {
    const tex = new StorageTexture(this.resolution, this.resolution);
    // R = current height, G = previous height. Float so the wave integrator does
    // not quantise, and nearest because neighbouring texels are discrete samples
    // of the simulation grid, not an image to be smoothed.
    tex.type = FloatType;
    tex.format = RGBAFormat;
    tex.minFilter = NearestFilter;
    tex.magFilter = NearestFilter;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    return tex;
  }

  /**
   * Storage textures start zeroed by the backend, which is already a flat
   * surface — there is nothing to clear.
   */
  clear(_renderer: unknown): void {}

  /** Texture currently holding the latest heights. */
  get readTexture(): Texture | null {
    return this.readTexture_;
  }

  get allTextures(): [Texture, Texture] | null {
    return this.originalTextures_;
  }

  get read(): StorageTexture | null {
    return this.readTexture_;
  }

  /** Target that the next simulation pass should write into. */
  get write(): StorageTexture | null {
    return this.writeTexture_;
  }

  /** Swap read/write after a simulation step. */
  swap(): void {
    const tmp = this.readTexture_;
    this.readTexture_ = this.writeTexture_;
    this.writeTexture_ = tmp;
  }

  dispose(): void {
    this.readTexture_?.dispose();
    this.writeTexture_?.dispose();
    this.readTexture_ = null;
    this.writeTexture_ = null;
  }
}
