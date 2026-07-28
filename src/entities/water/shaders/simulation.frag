uniform sampler2D uHeightMap;
uniform vec2 uTexelSize;
uniform float uDamping;
uniform float uSpeed;

varying vec2 vUv;

void main() {
  // R = current height, G = previous height
  vec2 center = texture2D(uHeightMap, vUv).rg;

  float left = texture2D(uHeightMap, vUv - vec2(uTexelSize.x, 0.0)).r;
  float right = texture2D(uHeightMap, vUv + vec2(uTexelSize.x, 0.0)).r;
  float down = texture2D(uHeightMap, vUv - vec2(0.0, uTexelSize.y)).r;
  float up = texture2D(uHeightMap, vUv + vec2(0.0, uTexelSize.y)).r;

  float laplacian = (left + right + down + up) * 0.25 - center.r;
  float newHeight = center.r * 2.0 - center.g + laplacian * uSpeed;
  newHeight *= uDamping;
  newHeight = clamp(newHeight, -2.0, 2.0);

  // Soft edge absorb so waves die at borders.
  float edge = smoothstep(0.0, 0.04, vUv.x) * smoothstep(1.0, 0.96, vUv.x)
    * smoothstep(0.0, 0.04, vUv.y) * smoothstep(1.0, 0.96, vUv.y);
  newHeight *= edge;

  gl_FragColor = vec4(newHeight, center.r, 0.0, 1.0);
}
