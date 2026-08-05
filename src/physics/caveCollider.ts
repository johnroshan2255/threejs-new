import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { getWorld } from "./world";
import type { TerrainColliderHandle } from "./terrainCollider";

const _v = new THREE.Vector3();

/**
 * Fixed trimesh collider from an indexed mesh, in world space.
 *
 * Used for cave shells and for terrain once it has mouth holes — a Rapier
 * heightfield is a complete grid and cannot represent a hole, so a punched
 * terrain has to become a trimesh or players simply cannot enter the cave.
 */
export function createTrimeshCollider(
	mesh: THREE.Mesh,
	options?: { friction?: number; restitution?: number }
): TerrainColliderHandle | null {
	const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
	const index = geometry?.getIndex();
	const position = geometry?.attributes.position as
		| THREE.BufferAttribute
		| undefined;
	if (!geometry || !index || !position || index.count < 3) return null;

	mesh.updateMatrixWorld(true);
	const vertices = new Float32Array(position.count * 3);
	for (let i = 0; i < position.count; i++) {
		_v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
		vertices[i * 3] = _v.x;
		vertices[i * 3 + 1] = _v.y;
		vertices[i * 3 + 2] = _v.z;
	}

	const indices = new Uint32Array(index.count);
	for (let i = 0; i < index.count; i++) indices[i] = index.getX(i);

	const world = getWorld();
	const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
	const collider = world.createCollider(
		RAPIER.ColliderDesc.trimesh(vertices, indices)
			.setFriction(options?.friction ?? 1.0)
			.setRestitution(options?.restitution ?? 0),
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
