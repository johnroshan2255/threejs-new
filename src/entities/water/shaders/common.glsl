// Shared GLSL utilities (prepended by materials / simulation).

#ifndef WATER_COMMON_GLSL
#define WATER_COMMON_GLSL

float fresnelSchlick(float cosTheta, float f0) {
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}

// Convert depth-buffer value to view-space Z (Three.js / WebGL convention: negative in front of camera).
float perspectiveDepthToViewZ(float depth, float near, float far) {
  return (near * far) / ((far - near) * depth - far);
}

// Beer-Lambert style underwater absorption.
vec3 absorbWater(vec3 color, float depth, vec3 absorption) {
  float d = max(depth, 0.0);
  return color * exp(-absorption * d);
}

// Cheap procedural value noise for surface detail.
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

vec2 animatedRippleOffset(vec2 uv, float time) {
  float n1 = valueNoise(uv * 3.0 + time * 0.15);
  float n2 = valueNoise(uv * 5.0 - time * 0.22);
  return vec2(n1, n2) * 2.0 - 1.0;
}

#endif
