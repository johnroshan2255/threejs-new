import type { Vector2, Vector3 } from 'three';

/**
 * World-space position accepted by ripple APIs.
 * Y is ignored for a horizontal pond (XZ plane).
 */
export type RipplePosition = Vector3 | Vector2 | { x: number; z: number };

/**
 * Parameters for injecting a single disturbance into the heightfield.
 */
export interface CreateRippleOptions {
  /** World-space hit position on / above the water plane. */
  position: RipplePosition;

  /** Impulse strength. Defaults applied by Pond / Disturbance. */
  strength?: number;

  /** Stamp radius in world units. */
  radius?: number;
}

/**
 * Normalized ripple impulse used internally by the simulation layer.
 */
export interface Ripple {
  /** UV coordinates in the heightfield [0, 1]. */
  uv: { u: number; v: number };

  /** Impulse strength. */
  strength: number;

  /** Stamp radius in UV space. */
  radius: number;
}
