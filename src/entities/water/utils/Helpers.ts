import type { RipplePosition } from '../types/Ripple';

/**
 * General helpers that do not belong in math or rendering layers.
 */

/** Extract XZ from a ripple position variant. */
export function getRippleXZ(position: RipplePosition): { x: number; z: number } {
  if ('z' in position) {
    return { x: position.x, z: position.z };
  }

  // Vector2 uses y as the second horizontal axis in 2D APIs.
  return { x: position.x, z: position.y };
}

/** No-op marker for unfinished phase implementations. */
export function notImplemented(feature: string): never {
  throw new Error(`[threejs-water] ${feature} is not implemented yet.`);
}
