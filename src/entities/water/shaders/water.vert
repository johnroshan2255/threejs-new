varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vViewPosition;
varying vec4 vReflectCoord;
varying vec4 vScreenPos;
varying float vHeight;
varying float vShore;

attribute float aShore;

uniform sampler2D uHeightMap;
uniform float uHasHeightMap;
uniform float uHeightScale;
uniform mat4 uTextureMatrix;

void main() {
  vUv = uv;
  vShore = aShore;

  // Sample height for shading varyings; keep geometry mostly flat (stable VTF-less look)
  // with a light vertex offset for larger waves.
  float height = texture2D(uHeightMap, uv).r * uHeightScale * uHasHeightMap;
  vHeight = height;
  vec3 displaced = position + normal * height * 0.35;

  vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
  vWorldPosition = worldPosition.xyz;
  vReflectCoord = uTextureMatrix * worldPosition;

  vec4 mvPosition = viewMatrix * worldPosition;
  vViewPosition = -mvPosition.xyz;

  gl_Position = projectionMatrix * mvPosition;
  vScreenPos = gl_Position;
}
