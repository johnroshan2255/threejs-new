import { Fn, clamp, dot, exp, float, floor, fract, max, mix, pow, sin, vec2 } from 'three/tsl';

/**
 * Shared water shading utilities, as TSL functions.
 *
 * The WebGL build kept these in `common.glsl` and prepended the string to every
 * shader that needed them. Nodes replace the textual include with an actual
 * import: same single definition, but the compiler now checks the call sites.
 */

export const fresnelSchlick = /*#__PURE__*/ Fn(([cosTheta, f0]: [any, any]) =>
  f0.add(f0.oneMinus().mul(pow(clamp(cosTheta, 0.0, 1.0).oneMinus(), 5.0)))
);

/**
 * Depth-buffer value to view-space Z (three.js convention: negative in front of
 * the camera).
 */
export const perspectiveDepthToViewZ = /*#__PURE__*/ Fn(
  ([depth, near, far]: [any, any, any]) =>
    near.mul(far).div(far.sub(near).mul(depth).sub(far))
);

/** Beer-Lambert style underwater absorption. */
export const absorbWater = /*#__PURE__*/ Fn(
  ([color, depth, absorption]: [any, any, any]) =>
    color.mul(exp(absorption.mul(max(depth, 0.0)).negate()))
);

/** Cheap procedural value noise for surface detail. */
export const hash21 = /*#__PURE__*/ Fn(([p]: [any]) =>
  fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453))
);

export const valueNoise = /*#__PURE__*/ Fn(([p]: [any]) => {
  const i: any = floor(p).toVar();
  const f: any = fract(p).toVar();
  const a = hash21(i);
  const b = hash21(i.add(vec2(1.0, 0.0)));
  const c = hash21(i.add(vec2(0.0, 1.0)));
  const d = hash21(i.add(vec2(1.0, 1.0)));
  // Smoothstep-style interpolant: f * f * (3 - 2f).
  const u: any = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  return mix(a, b, u.x)
    .add(c.sub(a).mul(u.y).mul(u.x.oneMinus()))
    .add(d.sub(b).mul(u.x).mul(u.y));
});

export const animatedRippleOffset = /*#__PURE__*/ Fn(
  ([p, time]: [any, any]) => {
    const n1 = valueNoise(p.mul(3.0).add(time.mul(0.15)));
    const n2 = valueNoise(p.mul(5.0).sub(time.mul(0.22)));
    return vec2(n1 as any, n2 as any).mul(2.0).sub(1.0);
  }
);
