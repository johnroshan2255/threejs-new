import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import {
	Fn,
	cameraProjectionMatrix,
	cos,
	instancedDynamicBufferAttribute,
	materialColor,
	mix,
	modelPosition,
	modelViewMatrix,
	modelWorldMatrix,
	normalLocal,
	normalize,
	positionLocal,
	remap,
	sin,
	uniform,
	uv,
	varying,
	vec2,
	vec3,
	vec4,
} from "three/tsl";
import { snowAt } from "../../terrain/snowShading";
import { snowUniforms } from "../../terrain/snowMask";

/** Shared wind clock — call updateFoliageWind(dt) once per frame. */
export const foliageWind = {
	u_windTime: uniform(0),
	u_windSpeed: uniform(1),
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

export type FoliageMaterial = MeshStandardNodeMaterial & {
	color: THREE.Color;
};

type FoliageUniforms = {
	u_effectBlend: any;
	u_inflate: any;
	u_scale: any;
	u_windSpeed: any;
	u_windTime: any;
};

/**
 * Whether foliage created from here uses alpha-to-coverage for its leaf cutouts.
 *
 * Unlike grass, foliage is already opaque and alpha-tested, so this only softens
 * the cutout edges — there is no queue change and nothing to trade. Held as
 * module state because trees are built per-world: a world switch after the
 * setting changed must produce materials that already agree with it.
 */
let foliageAlphaToCoverage = false;

/**
 * Point foliage at (or away from) alpha-to-coverage, retuning anything already
 * built under `root`.
 *
 * Traverses rather than keeping a registry of live materials: trees are rebuilt
 * on every world switch, and a registry would retain the discarded ones — these
 * materials each hold a compiled program.
 */
export function setFoliageAlphaToCoverage(
	enabled: boolean,
	root?: THREE.Object3D
) {
	foliageAlphaToCoverage = enabled;
	if (!root) return;
	root.traverse((object) => {
		const material = (object as THREE.Mesh).material;
		if (!material) return;
		const list = Array.isArray(material) ? material : [material];
		for (const m of list) {
			// The uniforms bag is what marks a material as ours.
			if (!m.userData?.foliageUniforms) continue;
			if (m.alphaToCoverage === enabled) continue;
			m.alphaToCoverage = enabled;
			m.needsUpdate = true;
		}
	});
}

/**
 * Build the leaf-card vertex transform and the snow tint.
 *
 * This is the douges.dev tree shader, which writes clip space directly rather
 * than displacing a local position — the leaf cards are billboarded in *view*
 * space and then rotated about view Z for the wind. `vertexNode` is the node
 * equivalent of CSM's `csm_PositionRaw`: it replaces the MVP outright, and
 * everything downstream (shadow pass included) follows it.
 *
 * `instanceMatrix` is what separates the two ways trees reach the screen. Wind
 * phase and snow coverage are per *tree*, not per vertex: foliage cards are
 * billboarded and wind-rotated, so a per-vertex world position would make the
 * canopy sway out of step with itself and the snow crawl across it. For an
 * InstancedMesh that per-tree anchor lives in the instance matrix's translation
 * column; for a plain Mesh it is just the object's world position.
 */
function buildFoliageNodes(
	material: MeshStandardNodeMaterial,
	u: FoliageUniforms,
	instanceMatrix: THREE.InstancedBufferAttribute | null
) {
	// Column-major mat4: elements 12..14 are the translation. Three itself reads
	// instance matrices exactly this way (see BufferAttributeNode's mat4 path).
	let instanceOrigin: any = modelPosition;
	if (instanceMatrix) {
		const translation: any = instancedDynamicBufferAttribute(
			instanceMatrix,
			"vec3",
			16,
			12
		);
		instanceOrigin = modelWorldMatrix.mul(vec4(translation, 1)).xyz;
	}

	// Read in the fragment stage too, so it has to survive the stage boundary.
	const vTreeOrigin: any = varying(instanceOrigin, "vFoliageTreeOrigin");

	material.vertexNode = Fn(() => {
		// Leaf cards fan outward from the blob using their own UVs.
		const offset = vec2(
			remap(uv().x, 0.0, 1.0, -1.0, 1.0),
			remap(uv().y, 0.0, 1.0, -1.0, 1.0)
		)
			// Invert so the offset is positioned towards the camera.
			.mul(vec2(-1.0, 1.0));
		const scaledOffset: any = normalize(offset as any).mul(u.u_scale);
		const inflated: any = vec3(scaledOffset.x, scaledOffset.y, 0.0).add(
			normalLocal.mul(u.u_inflate)
		);

		// positionLocal already carries the instance transform, so this is
		// view * model * instance * position — the shader's `mVM * position`.
		const viewPos = modelViewMatrix.mul(vec4(positionLocal, 1.0)).toVar();
		viewPos.addAssign(vec4(mix(vec3(0.0), inflated, u.u_effectBlend), 0.0));

		// Wind: rotate about view Z, biased so the top of the canopy leads.
		const boundedYNormal = remap(normalLocal.y, -1.0, 1.0, 0.0, 1.0);
		const posXZ = vTreeOrigin.x.add(vTreeOrigin.z);
		const power = u.u_windSpeed.div(5.0).mul(-0.5);
		const topFacing = remap(
			sin(u.u_windTime.add(posXZ)),
			-1.0,
			1.0,
			0.0,
			power
		);
		const bottomFacing = remap(
			cos(u.u_windTime.add(posXZ)),
			-1.0,
			1.0,
			0.0,
			0.05
		);
		const radians = mix(bottomFacing, topFacing, boundedYNormal);

		const c = cos(radians);
		const s = sin(radians);
		const swayed = vec4(
			viewPos.x.mul(c).add(viewPos.y.mul(s)),
			viewPos.x.mul(s).negate().add(viewPos.y.mul(c)),
			viewPos.z,
			viewPos.w
		);

		return cameraProjectionMatrix.mul(swayed);
	})();

	/**
	 * Snow on the canopy. Uses the full upness term (unlike grass), because
	 * foliage normals point outward from the blob — so snow lands on top and the
	 * underside stays dark, which is what keeps the tree reading as a tree.
	 *
	 * Trees only ever rotate about Y and scale uniformly, so the local normal's Y
	 * already is the world upness.
	 */
	material.colorNode = mix(
		materialColor,
		snowUniforms.uSnowColor,
		snowAt(vTreeOrigin, normalLocal.y)
	);
}

/**
 * Exact foliage material from the douges.dev / CodeSandbox tree demo, ported
 * from three-custom-shader-material to TSL.
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

	const uniforms: FoliageUniforms = {
		u_effectBlend: uniform(effectBlend),
		u_inflate: uniform(inflate),
		u_scale: uniform(foliageScale),
		u_windSpeed: uniform(windSpeed),
		u_windTime: foliageWind.u_windTime,
	};

	// Match demo: Color('#3f6d21').convertLinearToSRGB()
	const color = new THREE.Color(leafColor).convertLinearToSRGB();

	const material = new MeshStandardNodeMaterial({
		alphaMap,
		alphaTest: 0.35,
		alphaToCoverage: foliageAlphaToCoverage,
		color,
		side: THREE.FrontSide,
		shadowSide: THREE.FrontSide,
		roughness: 1,
		metalness: 0,
	}) as FoliageMaterial;

	material.userData.foliageUniforms = uniforms;
	buildFoliageNodes(material, uniforms, null);
	return material;
}

/**
 * Re-target a foliage material at an InstancedMesh's transforms.
 *
 * Separate from creation because the attribute only exists once the mesh does,
 * and the mesh needs the material to be constructed. Safe to call before the
 * first frame — it just rebuilds the node graph.
 */
export function setFoliageInstanceSource(
	material: THREE.Material,
	instanceMatrix: THREE.InstancedBufferAttribute
) {
	const mat = material as FoliageMaterial;
	const uniforms = mat.userData?.foliageUniforms as FoliageUniforms | undefined;
	if (!uniforms) return;
	buildFoliageNodes(mat, uniforms, instanceMatrix);
	mat.needsUpdate = true;
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
