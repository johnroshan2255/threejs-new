import * as THREE from "three";
import { buildCaveGeometry, geometryFromCaveMeshData } from "../../terrain/caveMesh";
import type { CaveGeometryResult } from "../../terrain/caveMesh";
import type { CaveMeshRequest } from "../../terrain/caveMeshCore";
import { registerCave, unregisterCave } from "../../terrain/caveRegistry";
import type { CaveNode } from "../../terrain/caveShape";
import { createTrimeshCollider } from "../../physics/caveCollider";
import type { TerrainColliderHandle } from "../../physics/terrainCollider";
import { caveMeshWorker } from "../../workers/caveMeshClient";

export type CaveHandle = {
	id: string;
	mesh: THREE.Mesh;
	nodes: CaveNode[];
	voxelSize: number;
	triangles: number;
	collider: TerrainColliderHandle | null;
	dispose: () => void;
};

let sharedRockMaterial: THREE.MeshPhongMaterial | null = null;
/**
 * Ground colour the mouth fades into. Lives outside the material so a world
 * switch can retint every existing cave without rebuilding shaders.
 */
const terrainTint = { value: new THREE.Color(0x1d360c) };

/** Match the mouths to the active world's terrain colour. */
export function setCaveTerrainColor(color: THREE.ColorRepresentation) {
	terrainTint.value.set(color);
}

/**
 * Rock shell material. DoubleSide so a stray back-face never reads as a hole in
 * the tunnel wall; normals come from the SDF gradient, so shading is correct
 * from either side.
 *
 * The mesher tags each vertex with how close it is to daylight, and the shader
 * fades those toward terrain colour. Without it the shell's ground apron meets
 * the grass as a hard brown ring — a real mouth has the ground cover thinning
 * into the rock instead.
 */
function rockMaterial(): THREE.MeshPhongMaterial {
	if (!sharedRockMaterial) {
		sharedRockMaterial = new THREE.MeshPhongMaterial({
			color: 0x5d564e,
			specular: 0x141210,
			shininess: 6,
			side: THREE.DoubleSide,
		});
		sharedRockMaterial.name = "cave-rock";
		sharedRockMaterial.onBeforeCompile = (shader) => {
			shader.uniforms.uTerrainColor = terrainTint;
			shader.vertexShader = shader.vertexShader.replace(
				"void main() {",
				`attribute float aTerrainBlend;
varying float vTerrainBlend;
void main() {
	vTerrainBlend = aTerrainBlend;`
			);
			shader.fragmentShader = shader.fragmentShader
				.replace(
					"void main() {",
					`uniform vec3 uTerrainColor;
varying float vTerrainBlend;
void main() {`
				)
				// After <color_fragment>, diffuseColor holds the final albedo — tint it
				// there so lighting still runs over the blended colour.
				.replace(
					"#include <color_fragment>",
					`#include <color_fragment>
	diffuseColor.rgb = mix(diffuseColor.rgb, uTerrainColor, clamp(vTerrainBlend, 0.0, 1.0));`
				);
		};
	}
	return sharedRockMaterial;
}

/**
 * Build a cave shell from its spine and register it as walkable ground.
 *
 * Geometry is emitted in world space, so the mesh keeps an identity transform —
 * moving it would desync the mesh from the SDF the registry queries, which is why
 * caves are not transformable entities.
 */
export async function createCave(options: {
	id: string;
	nodes: CaveNode[];
	heights: Float32Array;
	nrows: number;
	ncols: number;
	size: number;
	withCollider?: boolean;
}): Promise<CaveHandle | null> {
	const request: CaveMeshRequest = {
		nodes: options.nodes,
		heights: options.heights,
		nrows: options.nrows,
		ncols: options.ncols,
		size: options.size,
	};

	let built: CaveGeometryResult | null;
	try {
		// heights is NOT transferred — the main thread keeps owning it for sculpting
		// and the heightfield collider.
		const data = await caveMeshWorker.run(request);
		built = data ? geometryFromCaveMeshData(data) : null;
	} catch (error) {
		console.warn("[cave] worker unavailable, meshing on main thread", error);
		built = buildCaveGeometry(request);
	}
	if (!built) return null;

	const mesh = new THREE.Mesh(built.geometry, rockMaterial());
	mesh.name = `cave-${options.id}`;
	mesh.castShadow = false;
	mesh.receiveShadow = true;
	mesh.updateMatrixWorld(true);

	const collider =
		options.withCollider === false ? null : createTrimeshCollider(mesh);

	// Idempotent: a world switch disposes via the registry while EditApplier still
	// holds this handle, so dispose() can legitimately be called twice.
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		unregisterCave(options.id);
		collider?.dispose();
		mesh.removeFromParent();
		built.geometry.disposeBoundsTree?.();
		built.geometry.dispose();
	};

	registerCave({
		id: options.id,
		nodes: options.nodes,
		mesh,
		bounds: built.bounds,
		dispose,
	});

	return {
		id: options.id,
		mesh,
		nodes: options.nodes,
		voxelSize: built.voxelSize,
		triangles: built.triangles,
		collider,
		dispose,
	};
}
