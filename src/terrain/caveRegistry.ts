import * as THREE from "three";
import { caveDistance, type CaveNode, type CaveSpec } from "./caveShape";

export type CaveRecord = {
	/** Creating op id — also the edit-mode entity id. */
	id: string;
	nodes: CaveNode[];
	mesh: THREE.Mesh;
	bounds: THREE.Box3;
	/**
	 * Full teardown (mesh, geometry, collider). Must be idempotent: a world switch
	 * tears caves down here while the editor still holds handles to the same caves.
	 */
	dispose: () => void;
};

const records = new Map<string, CaveRecord>();
let version = 0;

/**
 * Bumped on every add / remove. Consumers that cache derived arrays (terrain
 * raycast lists, colliders) compare against this instead of subscribing.
 */
export function getCaveVersion(): number {
	return version;
}

export function registerCave(record: CaveRecord) {
	records.set(record.id, record);
	version++;
}

export function unregisterCave(id: string): CaveRecord | null {
	const record = records.get(id) ?? null;
	if (record) {
		records.delete(id);
		version++;
	}
	return record;
}

/**
 * Drop every cave and free its mesh and collider.
 *
 * Called on world switch: without it the new world inherits the old world's
 * ground queries and leaks its trimesh bodies into the physics world.
 */
export function clearCaves() {
	if (!records.size) return;
	// Snapshot first — dispose callbacks unregister themselves.
	const all = [...records.values()];
	records.clear();
	version++;
	for (const record of all) record.dispose();
}

export function hasCaves(): boolean {
	return records.size > 0;
}

export function getCaveRecords(): CaveRecord[] {
	return [...records.values()];
}

export function getCaveMeshes(): THREE.Mesh[] {
	const list: THREE.Mesh[] = [];
	for (const r of records.values()) list.push(r.mesh);
	return list;
}

export function getCaveSpecs(): CaveSpec[] {
	const list: CaveSpec[] = [];
	for (const r of records.values()) list.push({ nodes: r.nodes });
	return list;
}

/**
 * Signed distance to the nearest cave void — negative inside a tunnel.
 * Cheap enough for per-frame use: bounds-rejects before touching the spine.
 */
export function caveDistanceAt(x: number, y: number, z: number): number {
	let best = Infinity;
	for (const r of records.values()) {
		// The void never reaches the padded region edge, so a bounds miss is a miss.
		if (
			x < r.bounds.min.x ||
			x > r.bounds.max.x ||
			y < r.bounds.min.y ||
			y > r.bounds.max.y ||
			z < r.bounds.min.z ||
			z > r.bounds.max.z
		) {
			continue;
		}
		const d = caveDistance(r.nodes, x, y, z);
		if (d < best) best = d;
	}
	return best;
}

/**
 * True when a point is inside cave space. `margin` widens the test — used by the
 * out-of-bounds check so standing on a tunnel floor still counts as "in the cave".
 */
export function isInsideCave(x: number, y: number, z: number, margin = 0): boolean {
	return caveDistanceAt(x, y, z) < margin;
}
