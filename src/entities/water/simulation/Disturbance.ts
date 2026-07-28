import type { CreateRippleOptions, Ripple } from '../types/Ripple';
import {
  DEFAULT_RIPPLE_RADIUS,
  DEFAULT_RIPPLE_STRENGTH,
} from '../core/Constants';
import { getRippleXZ } from '../utils/Helpers';
import { clamp, worldToUv } from '../utils/Math';

/**
 * Builds normalized ripple stamp parameters from world-space options.
 *
 * Pure data transform — does not touch the GPU.
 */
export class Disturbance {
  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {}

  /**
   * Convert a public ripple request into simulation UV space.
   */
  create(options: CreateRippleOptions): Ripple {
    const { x, z } = getRippleXZ(options.position);
    const { u, v } = worldToUv(x, z, this.width, this.height);

    const worldRadius = options.radius ?? DEFAULT_RIPPLE_RADIUS;
    const radiusUv = clamp(
      worldRadius / Math.max(this.width, this.height),
      0.005,
      0.5,
    );

    return {
      uv: { u, v },
      strength: options.strength ?? DEFAULT_RIPPLE_STRENGTH,
      radius: radiusUv,
    };
  }
}
