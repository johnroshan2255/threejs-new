import {
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  type Camera,
  type Scene,
  type Texture,
  UnsignedIntType,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { RenderTargets } from '../core/RenderTargets';

/**
 * Renders the scene (with water hidden) for underwater / refraction sampling.
 * Also writes a depth texture used for clear-water depth colouring.
 */
export class RefractionPass {
  private readonly renderTargets: RenderTargets;
  private target: WebGLRenderTarget | null = null;

  constructor(renderTargets: RenderTargets = new RenderTargets()) {
    this.renderTargets = renderTargets;
  }

  /** Allocate the refraction RT + depth texture. */
  initialize(width: number, height: number): void {
    if (this.target) {
      this.setSize(width, height);
      return;
    }

    const depthTexture = new DepthTexture(width, height);
    depthTexture.type = UnsignedIntType;

    this.target = this.renderTargets.create(width, height, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      depthTexture,
    }) as any;
    this.target.texture.generateMipmaps = false;
    this.target.texture.colorSpace = LinearSRGBColorSpace;
  }

  /**
   * Render scene contents used for refraction.
   */
  render(renderer: any, scene: any, camera: any, waterVisible: { visible: boolean }): void { return; }

  get texture(): Texture | null {
    return this.target?.texture ?? null;
  }

  get depthTexture(): Texture | null {
    return this.target?.depthTexture ?? null;
  }

  setSize(width: number, height: number): void {
    if (!this.target) {
      return;
    }
    this.target.setSize(width, height);
    if (this.target.depthTexture) {
      this.target.depthTexture.image.width = width;
      this.target.depthTexture.image.height = height;
      this.target.depthTexture.needsUpdate = true;
    }
  }

  dispose(): void {
    this.target?.depthTexture?.dispose();
    this.renderTargets.dispose();
    this.target = null;
  }
}
