import RAPIER from "@dimforge/rapier3d-compat";
import { getWorld } from "./world";
import { TERRAIN_CONFIG } from "../terrain/createLargeTerrain";

/**
 * Efficient heightfield collider for the procedural terrain.
 */
export function createTerrainHeightfieldCollider(
	heights: Float32Array,
	nrows: number,
	ncols: number
): RAPIER.Collider {
	const world = getWorld();
	const { size } = TERRAIN_CONFIG;

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

	return collider;
}
