uniform vec3 uColor;
uniform float uOpacity;
uniform float uReflectivity;
uniform float uTime;
uniform sampler2D uReflectionMap;
uniform sampler2D uRefractionMap;
uniform sampler2D uDepthMap;
uniform sampler2D uHeightMap;
uniform float uHasHeightMap;
uniform float uHasReflectionMap;
uniform float uHasRefractionMap;
uniform float uHasDepthMap;
uniform float uDistortionScale;
uniform vec3 uSunDirection;
uniform vec2 uTexelSize;
uniform float uCameraNear;
uniform float uCameraFar;
uniform vec3 uAbsorption;
uniform float uMaxDepth;
uniform float uCircular;
uniform float uClarity;
uniform float uShoreSoftness;
uniform float uShoreFoam;
uniform float uBrightness;

varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vViewPosition;
varying vec4 vReflectCoord;
varying vec4 vScreenPos;
varying float vHeight;

vec3 normalFromHeightMap(vec2 uv) {
  float hL = texture2D(uHeightMap, uv - vec2(uTexelSize.x, 0.0)).r;
  float hR = texture2D(uHeightMap, uv + vec2(uTexelSize.x, 0.0)).r;
  float hD = texture2D(uHeightMap, uv - vec2(0.0, uTexelSize.y)).r;
  float hU = texture2D(uHeightMap, uv + vec2(0.0, uTexelSize.y)).r;
  return normalize(vec3((hL - hR) * 8.0, 1.0, (hD - hU) * 8.0));
}

void main() {
  float radial = length(vUv - vec2(0.5));
  float shore = 1.0;
  float shoreMask = 0.0;

  if (uCircular > 0.5) {
    // Wider soft rim when shoreSoftness is high (0 → thin, 1 → ~0.18 UV).
    float rimWidth = mix(0.04, 0.18, uShoreSoftness);
    float outer = 0.5;
    float inner = max(0.15, outer - rimWidth);

    if (radial > outer) {
      discard;
    }

    shore = 1.0 - smoothstep(inner, outer, radial);
    // Foam ring concentrated near the grass edge.
    shoreMask = smoothstep(inner, mix(inner, outer, 0.55), radial)
      * (1.0 - smoothstep(mix(inner, outer, 0.7), outer, radial));
  }

  vec3 viewDir = normalize(vViewPosition);

  vec2 wave = animatedRippleOffset(vUv * 2.5, uTime) * 0.04;
  vec3 normal = normalize(vec3(wave.x, 1.0, wave.y));
  if (uHasHeightMap > 0.5) {
    normal = normalize(mix(normal, normalFromHeightMap(vUv), 0.95));
  }

  // Soften distortion near shore so the edge stays readable.
  vec2 distortion = normal.xz * uDistortionScale * mix(0.35, 1.0, shore);

  vec2 reflectUv = vReflectCoord.xy / max(vReflectCoord.w, 1e-4);
  reflectUv += distortion;
  reflectUv = clamp(reflectUv, vec2(0.002), vec2(0.998));

  vec3 reflection = vec3(0.55, 0.75, 0.95);
  if (uHasReflectionMap > 0.5) {
    reflection = texture2D(uReflectionMap, reflectUv).rgb;
  }

  vec2 screenUv = vScreenPos.xy / max(vScreenPos.w, 1e-4);
  screenUv = screenUv * 0.5 + 0.5;
  screenUv += distortion * 0.85;
  screenUv = clamp(screenUv, vec2(0.002), vec2(0.998));

  vec3 underwater = vec3(0.55, 0.5, 0.35);
  if (uHasRefractionMap > 0.5) {
    underwater = texture2D(uRefractionMap, screenUv).rgb;
  }

  float waterDepth = 1.2;
  if (uHasDepthMap > 0.5) {
    float rawDepth = texture2D(uDepthMap, screenUv).x;
    if (rawDepth < 0.999) {
      float sceneViewZ = perspectiveDepthToViewZ(rawDepth, uCameraNear, uCameraFar);
      float surfaceEyeZ = length(vViewPosition);
      float sceneEyeZ = -sceneViewZ;
      waterDepth = clamp(sceneEyeZ - surfaceEyeZ, 0.02, uMaxDepth);
    } else {
      waterDepth = 0.2;
    }
  }

  // Clarity: high = show more bottom, weaker tint.
  float clarity = clamp(uClarity, 0.0, 1.0);
  float absorbScale = mix(0.85, 0.2, clarity);
  vec3 absorbed = absorbWater(underwater, waterDepth * absorbScale, uAbsorption);
  float depthNorm = clamp(waterDepth / max(uMaxDepth, 0.001), 0.0, 1.0);

  vec3 refraction = mix(underwater, absorbed, mix(0.45, 0.12, clarity) + depthNorm * mix(0.3, 0.12, clarity));
  refraction = mix(refraction, underwater, mix(0.15, 0.45, clarity));
  refraction = mix(refraction, refraction + uColor * 0.12, mix(0.45, 0.2, clarity));

  // Near shore, bias even more toward seeing the terrain.
  refraction = mix(refraction, underwater, shoreMask * 0.55);

  // Calculate world-space view direction for proper Fresnel
  vec3 worldViewDir = normalize(cameraPosition - vWorldPosition);
  float ndotv = max(dot(normal, worldViewDir), 0.0);
  float fresnel = fresnelSchlick(ndotv, mix(0.015, 0.1, uReflectivity));
  float mixFactor = clamp(fresnel * fresnel, 0.0, 0.55) * mix(1.0, 0.65, shoreMask);

  vec3 color = mix(refraction, reflection, mixFactor);
  color *= uBrightness;

  vec3 halfDir = normalize(worldViewDir + normalize(uSunDirection));
  float spec = pow(max(dot(normal, halfDir), 0.0), 220.0);
  color += vec3(1.0) * spec * 0.45;

  float foam = uHasHeightMap > 0.5
    ? smoothstep(0.04, 0.14, abs(vHeight) + length(normal.xz) * 0.08)
    : 0.0;

  float shoreFoam = shoreMask * uShoreFoam;
  color = mix(color, vec3(0.92, 0.97, 1.0), max(foam * 0.22, shoreFoam));

  // Soft alpha falloff at the circular rim (blends into grass).
  float alpha = mix(0.97, 1.0, mixFactor) * shore;
  gl_FragColor = vec4(color, alpha);
}
