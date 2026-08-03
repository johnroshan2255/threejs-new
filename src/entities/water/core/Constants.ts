import type { ResolvedWaterOptions } from '../types/WaterOptions';

/** Default plane subdivisions per axis. */
export const DEFAULT_SEGMENTS = 64;

/** Default heightfield resolution (pixels per side). */
export const DEFAULT_SIMULATION_RESOLUTION = 256;

/**
 * World length of one base wave cycle (metres).
 *
 * The look was tuned on a 20 m pond showing 2.5 cycles, so 20 / 2.5 = 8. Wave
 * tiling is derived from this and the pond's world size; a fixed UV tiling
 * stretches waves on large ponds until the surface reads as a flat plane.
 */
export const WAVE_PERIOD_METERS = 8;

/**
 * Simulation texels per metre on the reference pond (256 px over 20 m).
 * Keeps ripple detail the same physical size as ponds grow.
 */
export const REFERENCE_TEXELS_PER_METER = DEFAULT_SIMULATION_RESOLUTION / 20;

/** Height-derivative gain tuned at {@link REFERENCE_TEXELS_PER_METER}. */
export const REFERENCE_SLOPE_GAIN = 8;

/** Cap on slope compensation once simulation resolution is maxed out. */
export const MAX_SLOPE_GAIN = 24;

/** Default wave damping coefficient. */
export const DEFAULT_DAMPING = 0.992;

/** Default wave propagation speed. */
export const DEFAULT_SPEED = 0.9;

/** Default water colour (hex) — clear turquoise (threejs-water). */
export const DEFAULT_WATER_COLOR = 0x66c8d8;

/**
 * Look used by the threejs-water demo pond — apply to island + editor basins.
 */
export const REFERENCE_WATER_LOOK = {
	color: 0x8fdceb as const,
	opacity: 1 as const,
	reflectivity: 0.22 as const,
	damping: 0.993 as const,
	speed: 0.85 as const,
	clarity: 0.9 as const,
	shoreSoftness: 0.75 as const,
	// 0.5 blended the rim half way to near-white, which reads as a bright ring
	// rather than surf. Kept subtle so it brightens the shore without owning it.
	shoreFoam: 0.18 as const,
	brightness: 1.15 as const,
};

/** Default surface opacity. */
export const DEFAULT_OPACITY = 1.0;

/** Default reflection blend strength. */
export const DEFAULT_REFLECTIVITY = 0.55;

/** Default ripple impulse strength. */
export const DEFAULT_RIPPLE_STRENGTH = 0.15;

/** Default ripple stamp radius in world units. */
export const DEFAULT_RIPPLE_RADIUS = 0.85;

/** Clip water to a circle by default? Off — enable per pond for natural lakes. */
export const DEFAULT_CIRCULAR = false;

/** Default clarity (0 murky → 1 crystal). */
export const DEFAULT_CLARITY = 0.85;

/** Default circular shore soft-edge width (0 hard → 1 wide). */
export const DEFAULT_SHORE_SOFTNESS = 0.65;

/** Default shore foam intensity. */
export const DEFAULT_SHORE_FOAM = 0.45;

/** Default brightness lift. */
export const DEFAULT_BRIGHTNESS = 1.12;

/**
 * Defaults merged into user {@link WaterOptions} (excluding host scene hooks).
 */
export const DEFAULT_WATER_OPTIONS: Omit<
	ResolvedWaterOptions,
	'width' | 'height' | 'renderer' | 'scene' | 'camera' | 'sunDirection' | 'geometry'
> = {
	segments: DEFAULT_SEGMENTS,
	resolution: DEFAULT_SIMULATION_RESOLUTION,
	damping: DEFAULT_DAMPING,
	speed: DEFAULT_SPEED,
	color: DEFAULT_WATER_COLOR,
	opacity: DEFAULT_OPACITY,
	reflectivity: DEFAULT_REFLECTIVITY,
	circular: DEFAULT_CIRCULAR,
	clarity: DEFAULT_CLARITY,
	shoreSoftness: DEFAULT_SHORE_SOFTNESS,
	shoreFoam: DEFAULT_SHORE_FOAM,
	brightness: DEFAULT_BRIGHTNESS,
};
