import * as THREE from "three";
import {
	isMouthColumn,
	maxCaveRadius,
	PUNCH_DILATE,
	type CaveSpec,
	type HeightSampler,
} from "./caveShape";
import {
	buildCaveMeshData,
	MOUTH_DILATE,
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
export function punchTerrainHoles(
	geometry: THREE.BufferGeometry,
	caves: CaveSpec[],
	sampleHeight: HeightSampler
): number {
	const base = ensureBaseIndex(geometry);
	if (!base) return 0;

	const position = geometry.attributes.position as THREE.BufferAttribute | undefined;
	if (!position) return 0;

	const active = caves.filter((c) => c.nodes.length > 0);
	if (!active.length) {
		applyIndex(geometry, base);
		return 0;
	}

	// Terrain has ~129k triangles at stock resolution, so reject on a flat XZ box
	// before evaluating any SDF — otherwise every re-punch walks the whole spine.
	const regions = active.map((cave) => {
		const pad = maxCaveRadius(cave.nodes) + 1.5;
		let minX = Infinity;
		let maxX = -Infinity;
		let minZ = Infinity;
		let maxZ = -Infinity;
		for (const n of cave.nodes) {
			minX = Math.min(minX, n.x);
			maxX = Math.max(maxX, n.x);
			minZ = Math.min(minZ, n.z);
			maxZ = Math.max(maxZ, n.z);
		}
		return {
			nodes: cave.nodes,
			minX: minX - pad,
			maxX: maxX + pad,
			minZ: minZ - pad,
			maxZ: maxZ + pad,
		};
	});

	const kept: number[] = [];
	let removed = 0;
	for (let t = 0; t < base.length; t += 3) {
		const i0 = base[t]!;
		const i1 = base[t + 1]!;
		const i2 = base[t + 2]!;
		// Remove a triangle only when ALL THREE corners lie in the mouth region. The
		// shell keeps apron on an any-corner rule, so its coverage strictly contains
		// this hole and the seam cannot open a gap.
		let punch = false;
		for (const region of regions) {
			let anyInside = false;
			for (const vi of [i0, i1, i2]) {
				const vx = position.getX(vi);
				const vz = position.getZ(vi);
				if (
					vx >= region.minX &&
					vx <= region.maxX &&
					vz >= region.minZ &&
					vz <= region.maxZ &&
					isMouthColumn(region.nodes, sampleHeight, vx, vz, PUNCH_DILATE)
				) {
					anyInside = true;
					break;
				}
			}
			if (!anyInside) {
				const cx = (position.getX(i0) + position.getX(i1) + position.getX(i2)) / 3;
				const cz = (position.getZ(i0) + position.getZ(i1) + position.getZ(i2)) / 3;
				if (
					cx >= region.minX &&
					cx <= region.maxX &&
					cz >= region.minZ &&
					cz <= region.maxZ &&
					isMouthColumn(region.nodes, sampleHeight, cx, cz, PUNCH_DILATE)
				) {
					anyInside = true;
				}
			}
			if (anyInside) {
				punch = true;
				break;
			}
		}
		if (punch) {
			removed++;
			continue;
		}
		kept.push(i0, i1, i2);
	}

	applyIndex(geometry, new Uint32Array(kept));
	return removed;
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
