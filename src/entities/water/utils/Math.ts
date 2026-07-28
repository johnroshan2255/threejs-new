/**
 * Pure math helpers for the water system.
 * Must not touch WebGL state.
 */

/** Clamp `value` to `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Map local pond XZ into heightfield UV.
 *
 * Assumes a PlaneGeometry that was rotated with `rotateX(-PI/2)` onto the XZ
 * plane (Three.js default UV: +X → +U, original +Y → +V becomes world −Z → +V).
 */
export function worldToUv(
  x: number,
  z: number,
  width: number,
  height: number,
): { u: number; v: number } {
  return {
    u: clamp(x / width + 0.5, 0, 1),
    // Flip V: after rotateX(-PI/2), +Z maps to low V.
    v: clamp(0.5 - z / height, 0, 1),
  };
}

