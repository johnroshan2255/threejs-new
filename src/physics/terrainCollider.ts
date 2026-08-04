import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { getWorld } from "./world";
import { TERRAIN_CONFIG } from "../terrain/createLargeTerrain";
import { hasCaves } from "../terrain/caveRegistry";
import { createTrimeshCollider } from "./caveCollider";

export type TerrainColliderHandle = {
	body: RAPIER.RigidBody;
	collider: RAPIER.Collider;
	dispose: () => void;
};

/**
 * Efficient heightfield collider for the procedural terrain.
 */
export function createTerrainHeightfieldCollider(
	heights: Float32Array,
	nrows: number,
	ncols: number,
	size: number = TERRAIN_CONFIG.size
): TerrainColliderHandle {
	const world = getWorld();

	const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

	// Rapier heightfield scale: full extent on X/Z, Y is height multiplier (heights already in world units).
	const collider = world.createCollider(
		RAPIER.ColliderDesc.heightfield(nrows, ncols, heights, {
			x: size,
			y: 1,
			z: size,
		})
			.setFriction(1.0)
			.setRestitution(0),
		body
	);

	return {
		body,
		collider,
		dispose: () => {
			world.removeRigidBody(body);
		},
	};
}

/**
 * Ground collider for the active terrain.
 *
 * Prefers the heightfield — it is far cheaper for the vehicle's wheel raycasts.
 * Falls back to a trimesh built from the punched mesh once caves exist, because a
 * heightfield has no way to express the hole a cave mouth needs.
 */
export function createTerrainCollider(
	mesh: THREE.Mesh | null,
	heights: Float32Array,
	nrows: number,
	ncols: number,
	size: number = TERRAIN_CONFIG.size
): TerrainColliderHandle {
	if (mesh && hasCaves()) {
		const trimesh = createTrimeshCollider(mesh);
		if (trimesh) return trimesh;
	}
	return createTerrainHeightfieldCollider(heights, nrows, ncols, size);
}
