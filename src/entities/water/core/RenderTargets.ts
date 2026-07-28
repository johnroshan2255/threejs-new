import {
  type RenderTargetOptions,
  type Texture,
  WebGLRenderTarget,
} from 'three';

/**
 * Factory and lifecycle helper for WebGL render targets.
 *
 * Used by simulation ping-pong buffers and reflection / refraction passes.
 * Does not know about ponds or ripple math.
 */
export class RenderTargets {
  private readonly targets = new Set<WebGLRenderTarget>();

  /** Create and track a render target. */
  create(
    width: number,
    height: number,
    options?: RenderTargetOptions,
  ): WebGLRenderTarget {
    const target = new WebGLRenderTarget(width, height, options);
    this.targets.add(target);
    return target;
  }

  /** Resize a tracked target. */
  resize(target: WebGLRenderTarget, width: number, height: number): void {
    target.setSize(width, height);
  }

  /** Dispose a single target and stop tracking it. */
  disposeOne(target: WebGLRenderTarget): void {
    target.dispose();
    this.targets.delete(target);
  }

  /** Dispose all tracked targets. */
  dispose(): void {
    for (const target of this.targets) {
      target.dispose();
    }
    this.targets.clear();
  }

  /** Convenience accessor for a target's colour texture. */
  static texture(target: WebGLRenderTarget): Texture {
    return target.texture;
  }
}
