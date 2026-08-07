import {
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  type Camera,
  type Scene,
  type Texture,
  UnsignedIntType,
  type RenderTarget,
} from 'three';
import { RenderTargets } from '../core/RenderTargets';
import { freezeSceneShadows, restoreSceneShadows } from './shadowFreeze';

/**
 * Renders the scene (with water hidden) for underwater / refraction sampling.
 * Also writes a depth texture used for clear-water depth colouring.
 */
export class RefractionPass {
  private readonly renderTargets: RenderTargets;
  private target: RenderTarget | null = null;

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
    });
    this.target.texture.generateMipmaps = false;
    this.target.texture.colorSpace = LinearSRGBColorSpace;
  }

  /**
   * Render scene contents used for refraction.
   *
   * Same camera as the beauty pass, but the shadow freeze still applies: the
   * node renderer keys shadow updates on (light, camera, frame), and this render
   * happens on the same frame — leaving it unfrozen would redraw the maps once
   * more before the main pass gets to reuse them.
   */
  render(
    renderer: any,
    scene: Scene,
    camera: Camera,
    waterVisible: { visible: boolean },
  ): void {
    if (!this.target) {
      return;
    }

    const prevTarget = renderer.getRenderTarget();
    const wasVisible = waterVisible.visible;
    waterVisible.visible = false;
    const frozen = freezeSceneShadows(scene);

    renderer.setRenderTarget(this.target);
    if (renderer.autoClear === false) {
      renderer.clear();
    }
    renderer.render(scene, camera);

    restoreSceneShadows(frozen);
    waterVisible.visible = wasVisible;
    renderer.setRenderTarget(prevTarget);
  }

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
    // setSize() already disposes the target, which destroys the depth attachment
    // along with it; the backend recreates it from these dimensions on next use.
    // Marking it `needsUpdate` as well asks for an *upload* into a texture that
    // no longer exists — on WebGPU that is a hard validation error, and it takes
    // the frame with it. Under WebGL the flag was merely redundant.
    this.target.setSize(width, height);
    if (this.target.depthTexture) {
      this.target.depthTexture.image.width = width;
      this.target.depthTexture.image.height = height;
    }
  }

  dispose(): void {
    this.target?.depthTexture?.dispose();
    this.renderTargets.dispose();
    this.target = null;
  }
}
