import {
  ClampToEdgeWrapping,
  Color,
  FloatType,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  type Texture,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { RenderTargets } from '../core/RenderTargets';

/**
 * GPU heightfield storage (ping-pong render targets).
 *
 * Owns simulation buffers and exposes read/write textures.
 * Does not run the wave equation — that lives in {@link RippleSimulation}.
 */
export class HeightField {
  readonly resolution: number;

  private readonly renderTargets: RenderTargets;
  private readTarget: WebGLRenderTarget | null = null;
  private writeTarget: WebGLRenderTarget | null = null;
  private readonly _clearColor = new Color();

  constructor(resolution: number, renderTargets: RenderTargets = new RenderTargets()) {
    this.resolution = resolution;
    this.renderTargets = renderTargets;
  }

  /** Allocate ping-pong float targets (data buffers, not color images). */
  initialize(): void {
    if (this.readTarget && this.writeTarget) {
      return;
    }

    const options = {
      type: FloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    } as const;

    this.readTarget = this.renderTargets.create(this.resolution, this.resolution, options);
    this.writeTarget = this.renderTargets.create(this.resolution, this.resolution, options);

    for (const target of [this.readTarget, this.writeTarget]) {
      target.texture.generateMipmaps = false;
      target.texture.colorSpace = NoColorSpace;
    }
  }

  /** Clear both buffers to a flat surface. */
  clear(renderer: WebGLRenderer): void {
    if (!this.readTarget || !this.writeTarget) {
      return;
    }

    const previous = renderer.getRenderTarget();
    renderer.getClearColor(this._clearColor);
    const previousAlpha = renderer.getClearAlpha();

    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.readTarget);
    renderer.clear(true, true, true);
    renderer.setRenderTarget(this.writeTarget);
    renderer.clear(true, true, true);

    renderer.setClearColor(this._clearColor, previousAlpha);
    renderer.setRenderTarget(previous);
  }

  /** Texture currently holding the latest heights. */
  get readTexture(): Texture | null {
    return this.readTarget ? RenderTargets.texture(this.readTarget) : null;
  }

  get read(): WebGLRenderTarget | null {
    return this.readTarget;
  }

  /** Target that the next simulation pass should write into. */
  get write(): WebGLRenderTarget | null {
    return this.writeTarget;
  }

  /** Swap read/write after a simulation step. */
  swap(): void {
    const previous = this.readTarget;
    this.readTarget = this.writeTarget;
    this.writeTarget = previous;
  }

  /** Release GPU resources. */
  dispose(): void {
    this.renderTargets.dispose();
    this.readTarget = null;
    this.writeTarget = null;
  }
}
