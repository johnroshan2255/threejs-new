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
 * Rock shell material. DoubleSide so a stray back-face never reads as a hole in
 * the tunnel wall; normals come from the SDF gradient, so shading is correct
 * from either side.
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
