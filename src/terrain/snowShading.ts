import * as THREE from "three";
import { snowUniforms } from "./snowMask";

/**
 * Shared snow shading term.
 *
 * Terrain, grass, foliage and stones each reach the GPU by a different route —
 * onBeforeCompile string surgery, a hand-written shader, CustomShaderMaterial —
 * so the *math* is centralised here as one GLSL chunk they all include. If snow
 * looked subtly different on rocks than on the ground it would read as a bug,
 * and four copies of a smoothstep is how that happens.
 */
export const SNOW_GLSL = /* glsl */ `
uniform sampler2D uSnowMask;
uniform float uSnowExtent;
uniform vec3 uSnowColor;
uniform float uSnowStrength;

vec2 snowMaskUV(vec3 worldPos) {
  return worldPos.xz / uSnowExtent + 0.5;
}

float snowMaskAt(vec3 worldPos) {
  vec2 uv = snowMaskUV(worldPos);
  // Outside the mask is bare ground, not clamped-edge snow smeared to infinity.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture2D(uSnowMask, uv).r * uSnowStrength;
}

/**
 * Coverage weighted by how upward-facing the surface is. This is what makes a
 * tint read as snow rather than white paint: snow rests on tops and never on
 * undersides or steep faces, so the silhouette stays dark where it should.
 */
float snowAt(vec3 worldPos, float upness) {
  return snowMaskAt(worldPos) * smoothstep(0.25, 0.72, upness);
}
`;

/** Uniform bag to merge into any shader that includes SNOW_GLSL. */
export function snowShaderUniforms() {
	return {
		uSnowMask: snowUniforms.uSnowMask,
		uSnowExtent: snowUniforms.uSnowExtent,
		uSnowColor: snowUniforms.uSnowColor,
		uSnowStrength: snowUniforms.uSnowStrength,
	};
}

/** Marks a material as already patched, so repeat calls are free. */
const SNOW_PATCH_FLAG = "snowPatched";

/**
 * Add snow to a stock Three.js material (terrain Phong, stone GLB Standard).
 *
 * Patching the *shared* material is correct rather than a compromise: because
 * the mask is sampled per fragment by world position, one patched material
 * renders snowy and bare instances correctly at the same time. Sharing helps
 * here — patch once, every instance behaves locally.
 */
export function applySnowToMaterial(material: THREE.Material) {
	// Temporarily disabled for WebGPU migration
}
