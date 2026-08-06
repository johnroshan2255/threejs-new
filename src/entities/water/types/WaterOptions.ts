import type { Camera, ColorRepresentation, Scene, Vector3 } from 'three';

/**
 * Construction options for {@link Pond}.
 *
 * Only `width` and `height` are required. Remaining fields fall back to defaults.
 */
export interface WaterOptions {
  /** World-space width of the water plane (X axis). */
  width: number;

  /** World-space depth/length of the water plane (Z axis). Named `height` for API familiarity. */
  height: number;

  /** Plane geometry subdivisions per axis. */
  segments?: number;

  /** Heightfield simulation resolution (pixels per side). */
  resolution?: number;

  /** Wave energy decay per simulation step. */
  damping?: number;

  /** Wave propagation speed. */
  speed?: number;

  /** Base water colour (light turquoise tint — see threejs-water). */
  color?: ColorRepresentation;

  /** Surface opacity (0–1). */
  opacity?: number;

  /** Reflection blend strength (0–1). */
  reflectivity?: number;

  /**
   * How clear the water is (0 = murky/tinted, 1 = very clear).
   * Controls absorption strength and how much of the bottom shows through.
   */
  clarity?: number;

  /**
   * Softness of the circular shore edge (0 = hard cut, 1 = wide soft blend).
   * Only applies when `circular` is true.
   */
  shoreSoftness?: number;

  /** Shore foam / bright-edge intensity (0–1). */
  shoreFoam?: number;

  /** Overall surface brightness multiplier (typical 0.9–1.3). */
  brightness?: number;

  /** Sun direction for specular highlights (will be normalized). */
  sunDirection?: Vector3 | { x: number; y: number; z: number };

  /**
   * Clip the water surface to a circle (natural pond) instead of a square plane.
   */
  circular?: boolean;

  /**
   * Optional custom water surface (already in local XZ, Y-up).
   * When set, this replaces the default plane; width/height still size the ripple sim.
   */
  geometry?: import('three').BufferGeometry;

  /**
   * Host WebGL renderer. Required for reflection / refraction / GPU simulation.
   */
  renderer?: any;

  /** Scene used by reflection / refraction passes. */
  scene?: Scene;

  /** Camera used by reflection / refraction passes. */
  camera?: Camera;
}

/**
 * Fully resolved options after defaults are applied.
 */
export type ResolvedWaterOptions = Required<
  Omit<WaterOptions, 'renderer' | 'scene' | 'camera' | 'sunDirection' | 'geometry'>
> &
  Pick<WaterOptions, 'renderer' | 'scene' | 'camera' | 'sunDirection' | 'geometry'>;
