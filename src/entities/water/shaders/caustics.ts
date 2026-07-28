/**
 * GPU caustics from the water heightfield (simplified differential-area look).
 * Projects bright focusing patterns used on the pool floor/walls.
 */
export const causticsVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const causticsFrag = /* glsl */ `
uniform sampler2D uHeightMap;
uniform vec2 uTexelSize;
uniform vec3 uLightDir;
uniform float uIntensity;

varying vec2 vUv;

void main() {
  float hC = texture2D(uHeightMap, vUv).r;
  float hL = texture2D(uHeightMap, vUv - vec2(uTexelSize.x, 0.0)).r;
  float hR = texture2D(uHeightMap, vUv + vec2(uTexelSize.x, 0.0)).r;
  float hD = texture2D(uHeightMap, vUv - vec2(0.0, uTexelSize.y)).r;
  float hU = texture2D(uHeightMap, vUv + vec2(0.0, uTexelSize.y)).r;

  vec3 normal = normalize(vec3(hL - hR, 0.15, hD - hU));
  vec3 L = normalize(uLightDir);

  // Refract light through the surface toward the floor.
  vec3 refracted = refract(-L, normal, 0.75);
  // Focus intensity ~ how parallel neighbouring refracted rays are (area proxy).
  float focus = 1.0 - clamp(length(refracted.xz) * 2.5, 0.0, 1.0);
  float laplacian = abs(hL + hR + hD + hU - 4.0 * hC);
  float caustic = pow(focus, 2.0) * (0.35 + laplacian * 18.0);
  caustic = clamp(caustic * uIntensity, 0.0, 4.0);

  gl_FragColor = vec4(vec3(caustic), 1.0);
}
`;
