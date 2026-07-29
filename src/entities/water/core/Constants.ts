import type { ResolvedWaterOptions } from '../types/WaterOptions';

/** Default plane subdivisions per axis. */
export const DEFAULT_SEGMENTS = 64;

/** Default heightfield resolution (pixels per side). */
export const DEFAULT_SIMULATION_RESOLUTION = 256;

/** Default wave damping coefficient. */
export const DEFAULT_DAMPING = 0.992;

/** Default wave propagation speed. */
export const DEFAULT_SPEED = 0.9;

/** Default water colour (hex) — matches island terrain. */
export const DEFAULT_WATER_COLOR = 0x5e875e;

/** Default pond-bottom colour — matches the island terrain. */
export const DEFAULT_BOTTOM_COLOR = 0x5e875e;

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
  'width' | 'height' | 'renderer' | 'scene' | 'camera' | 'sunDirection'
> = {
  segments: DEFAULT_SEGMENTS,
  resolution: DEFAULT_SIMULATION_RESOLUTION,
  damping: DEFAULT_DAMPING,
  speed: DEFAULT_SPEED,
  color: DEFAULT_WATER_COLOR,
  bottomColor: DEFAULT_BOTTOM_COLOR,
  opacity: DEFAULT_OPACITY,
  reflectivity: DEFAULT_REFLECTIVITY,
  circular: DEFAULT_CIRCULAR,
  clarity: DEFAULT_CLARITY,
  shoreSoftness: DEFAULT_SHORE_SOFTNESS,
  shoreFoam: DEFAULT_SHORE_FOAM,
  brightness: DEFAULT_BRIGHTNESS,
};
