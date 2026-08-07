/**
 * Exact vertex shader from the douges.dev tree demo (CSM csm_PositionRaw output).
 * Updated to support InstancedMesh.
 */
export const FOLIAGE_VERTEX_SHADER = /* glsl */ `
uniform float u_effectBlend;
uniform float u_inflate;
uniform float u_scale;
uniform float u_windSpeed;
uniform float u_windTime;

/** Snow lookup data — see terrain/snowShading.ts for the matching fragment side. */
varying vec3 vSnowWorldPos;
varying float vSnowUpness;

float inverseLerp(float v, float minValue, float maxValue) {
  return (v - minValue) / (maxValue - minValue);
}

float remap(float v, float inMin, float inMax, float outMin, float outMax) {
  float t = inverseLerp(v, inMin, inMax);
  return mix(outMin, outMax, t);
}

mat4 rotateZ(float radians) {
  float c = cos(radians);
  float s = sin(radians);

  return mat4(
    c, -s, 0, 0,
    s, c, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  );
}

vec4 applyWind(vec4 v) {
#if OPTIMIZE_TREE == 1
  return v;
#else
  float boundedYNormal = remap(normal.y, -1.0, 1.0, 0.0, 1.0);
  
#ifdef USE_INSTANCING
  vec4 instanceWorldPos = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
#else
  vec4 instanceWorldPos = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
#endif

  float posXZ = instanceWorldPos.x + instanceWorldPos.z;
  float power = u_windSpeed / 5.0 * -0.5;

  float topFacing = remap(sin(u_windTime + posXZ), -1.0, 1.0, 0.0, power);
  float bottomFacing = remap(cos(u_windTime + posXZ), -1.0, 1.0, 0.0, 0.05);
  float radians = mix(bottomFacing, topFacing, boundedYNormal);

  return rotateZ(radians) * v;
#endif
}

vec2 calcInitialOffsetFromUVs() {
  vec2 offset = vec2(
    remap(uv.x, 0.0, 1.0, -1.0, 1.0),
    remap(uv.y, 0.0, 1.0, -1.0, 1.0)
  );

  // Invert the vertex offset so it's positioned towards the camera.
  offset *= vec2(-1.0, 1.0);
  offset = normalize(offset) * u_scale;

  return offset;
}

vec3 inflateOffset(vec3 offset) {
  return offset + normal.xyz * u_inflate;
}

void main() {
  vec2 vertexOffset = calcInitialOffsetFromUVs();

  vec3 inflatedVertexOffset = inflateOffset(vec3(vertexOffset, 0.0));

#ifdef USE_INSTANCING
  mat4 mVM = viewMatrix * modelMatrix * instanceMatrix;
  // Whole-tree mask lookup: one sample per instance, not per leaf card. Foliage
  // cards are billboarded and wind-rotated, so a per-vertex world position would
  // make coverage crawl across the canopy as it sways.
  vSnowWorldPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#else
  mat4 mVM = modelViewMatrix;
  vSnowWorldPos = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#endif

  // Trees only ever rotate about Y and scale uniformly, so the object-space
  // normal's Y already is the world upness — no normal matrix needed.
  vSnowUpness = normal.y;

  vec4 worldViewPosition = mVM * vec4(position, 1.0);

  worldViewPosition += vec4(mix(vec3(0.0), inflatedVertexOffset, u_effectBlend), 0.0);

  worldViewPosition = applyWind(worldViewPosition);

  csm_PositionRaw = projectionMatrix * worldViewPosition;
}
`;

/**
 * Snow on the canopy. Uses the full upness term (unlike grass), because foliage
 * normals point outward from the blob — so snow lands on top and the underside
 * stays dark, which is what keeps the tree reading as a tree.
 */
export const FOLIAGE_FRAGMENT_SHADER = /* glsl */ `
varying vec3 vSnowWorldPos;
varying float vSnowUpness;

void main() {
  float snow = snowAt(vSnowWorldPos, vSnowUpness);
  csm_DiffuseColor.rgb = mix(csm_DiffuseColor.rgb, uSnowColor, snow);
}
`;

