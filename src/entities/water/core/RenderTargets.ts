import {
  type RenderTargetOptions,
  type Texture,
  RenderTarget,
} from 'three';

/**
 * Factory and lifecycle helper for WebGL render targets.
 *
 * Used by simulation ping-pong buffers and reflection / refraction passes.
 * Does not know about ponds or ripple math.
 */
export class RenderTargets {
  private readonly targets = new Set<RenderTarget>();

  /** Create and track a render target. */
  create(
    width: number,
    height: number,
    options?: RenderTargetOptions,
  ): RenderTarget {
    const target = new RenderTarget(width, height, options);
    this.targets.add(target);
    return target;
  }

  /** Resize a tracked target. */
  resize(target: RenderTarget, width: number, height: number): void {
    target.setSize(width, height);
  }

  /** Dispose a single target and stop tracking it. */
  disposeOne(target: RenderTarget): void {
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
  static texture(target: RenderTarget): Texture {
    return target.texture;
  }
}
