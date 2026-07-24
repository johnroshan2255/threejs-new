import * as THREE from "three";
import CustomShaderMaterial from "three-custom-shader-material/vanilla";
import { FOLIAGE_VERTEX_SHADER } from "./foliageShader";

/** Shared wind clock — call updateFoliageWind(dt) once per frame. */
export const foliageWind = {
	u_windTime: { value: 0 },
	u_windSpeed: { value: 1 },
};

export function updateFoliageWind(dt: number) {
	foliageWind.u_windTime.value += foliageWind.u_windSpeed.value * dt;
}

export type FoliageMaterialOptions = {
	leafColor?: THREE.ColorRepresentation;
	alphaMap: THREE.Texture;
	effectBlend?: number;
	inflate?: number;
	foliageScale?: number;
	windSpeed?: number;
};

export type FoliageMaterial = CustomShaderMaterial & {
	color: THREE.Color;
};

/**
 * Exact foliage material from the douges.dev / CodeSandbox tree demo
 * (three-custom-shader-material + same vertex wind shader).
 */
export function createFoliageMaterial(
	options: FoliageMaterialOptions
): FoliageMaterial {
	const {
		leafColor = "#3f6d21",
		alphaMap,
		effectBlend = 1,
		inflate = 0,
		foliageScale = 1,
		windSpeed = 1,
	} = options;

	const uniforms = {
		u_effectBlend: { value: effectBlend },
		u_inflate: { value: inflate },
		u_scale: { value: foliageScale },
		u_windSpeed: { value: windSpeed },
		u_windTime: foliageWind.u_windTime,
	};

	// Match demo: Color('#3f6d21').convertLinearToSRGB()
	const color = new THREE.Color(leafColor).convertLinearToSRGB();

	const material = new CustomShaderMaterial({
		baseMaterial: THREE.MeshStandardMaterial,
		vertexShader: FOLIAGE_VERTEX_SHADER,
		uniforms,
		alphaMap,
		alphaTest: 0.35,
		color,
		side: THREE.FrontSide,
		shadowSide: THREE.FrontSide,
		roughness: 1,
		metalness: 0,
	}) as FoliageMaterial;

	material.userData.foliageUniforms = uniforms;
	return material;
}

export function setFoliageLeafColor(
	material: THREE.Material,
	color: THREE.ColorRepresentation
) {
	const mat = material as FoliageMaterial;
	if (mat.color) {
		mat.color.copy(new THREE.Color(color).convertLinearToSRGB());
	}
}
