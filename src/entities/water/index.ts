/**
 * threejs-water — public API surface.
 *
 * Only symbols exported from this file are intended for consumers.
 * Internal modules under simulation/, rendering/, materials/, core/, etc.
 * must not be imported directly by applications.
 */

export { Pond } from './objects/Pond';
export { REFERENCE_WATER_LOOK } from './core/Constants';

export type {
  WaterOptions,
  ResolvedWaterOptions,
} from './types/WaterOptions';

export type {
  Ripple,
  RipplePosition,
  CreateRippleOptions,
} from './types/Ripple';

/** Library scaffold + Phase 1–4 water implementation. */
export const VERSION = '0.1.0';
