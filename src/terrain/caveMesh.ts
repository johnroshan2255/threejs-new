import * as THREE from "three";
import {
	isMouthColumn,
	maxCaveRadius,
	punchDilate,
	type CaveSpec,
	type HeightSampler,
} from "./caveShape";
import {
	buildCaveMeshData,
	type CaveMeshData,
	type CaveMeshRequest,
} from "./caveMeshCore";

export type CaveGeometryResult = {
	geometry: THREE.BufferGeometry;
	voxelSize: number;
	bounds: THREE.Box3;
	triangles: number;
};

/** Wrap mesher output (main thread or worker) into a renderable geometry. */
export function geometryFromCaveMeshData(data: CaveMeshData): CaveGeometryResult {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
	geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
	// Read by the rock shader to fade the mouth into terrain colour.
	geometry.setAttribute(
		"aTerrainBlend",
		new THREE.BufferAttribute(data.terrainBlend, 1)
	);
	geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	geometry.computeBoundsTree();

	return {
		geometry,
		voxelSize: data.voxelSize,
		bounds: new THREE.Box3(
			new THREE.Vector3(data.bounds.minX, data.bounds.minY, data.bounds.minZ),
			new THREE.Vector3(data.bounds.maxX, data.bounds.maxY, data.bounds.maxZ)
		),
		triangles: data.triangles,
	};
}

/** Synchronous mesh + wrap. Used as the fallback when the worker is unavailable. */
export function buildCaveGeometry(req: CaveMeshRequest): CaveGeometryResult | null {
	const data = buildCaveMeshData(req);
	return data ? geometryFromCaveMeshData(data) : null;
}

/**
 * Remove terrain triangles over every cave mouth so the ground plane no longer
 * caps the opening. The heights array is untouched — it stays the authoring source
 * of truth; only the rendered / raycast index changes.
 *
 * Returns the number of triangles removed.
 */
import { terrainHolesWorker } from "../workers/terrainHolesClient";

export async function punchTerrainHoles(
	geometry: THREE.BufferGeometry,
	caves: CaveSpec[],
	heights: Float32Array,
	nrows: number,
	ncols: number,
	size: number,
	cellSize = 0
): Promise<number> {
	const base = ensureBaseIndex(geometry);
	if (!base) return 0;

	const position = geometry.attributes.position as THREE.BufferAttribute | undefined;
	if (!position) return 0;

	const active = caves.filter((c) => c.nodes.length > 0);
	if (!active.length) {
		applyIndex(geometry, base);
		return 0;
	}

	const request = {
		baseIndex: base,
		positions: position.array as Float32Array,
		caves: active.map(c => ({ nodes: c.nodes })),
		heights,
		nrows,
		ncols,
		size,
		cellSize
	};

	try {
		const result = await terrainHolesWorker.run(request);
		if (result) {
			applyIndex(geometry, result.newIndex);
			return result.removedCount;
		}
	} catch (error) {
		console.warn("[cave] terrainHoles worker failed", error);
		// If worker fails, fallback to old sync method? Or just don't punch.
		// For now we just don't punch holes if worker completely fails.
	}
	
	applyIndex(geometry, base);
	return 0;
}

/** Put every punched triangle back (before a fresh replay of edit ops). */
export function restoreTerrainHoles(geometry: THREE.BufferGeometry) {
	const base = geometry.userData.caveBaseIndex as Uint32Array | undefined;
	if (!base) return;
	applyIndex(geometry, base);
}

function ensureBaseIndex(geometry: THREE.BufferGeometry): Uint32Array | null {
	const cached = geometry.userData.caveBaseIndex as Uint32Array | undefined;
	if (cached) return cached;
	const index = geometry.getIndex();
	if (!index) return null;
	const base = new Uint32Array(index.count);
	for (let i = 0; i < index.count; i++) base[i] = index.getX(i);
	geometry.userData.caveBaseIndex = base;
	return base;
}

function applyIndex(geometry: THREE.BufferGeometry, index: Uint32Array) {
	geometry.setIndex(new THREE.BufferAttribute(index, 1));
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	// The BVH indexes triangles, so a changed index invalidates it — stale trees
	// keep reporting hits on triangles that no longer exist (mouth stays solid).
	geometry.disposeBoundsTree();
	geometry.computeBoundsTree();
}
