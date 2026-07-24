import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { getWorld } from "./world";

/**
 * Build a fixed Rapier trimesh from a Three.js mesh (world-space vertices).
 * Required so raycast vehicle wheels have ground to hit.
 */
export function createIslandCollider(mesh: THREE.Mesh): RAPIER.Collider {
	const world = getWorld();
	mesh.updateMatrixWorld(true);

	const geometry = mesh.geometry.index
		? mesh.geometry.toNonIndexed()
		: mesh.geometry.clone();

	const position = geometry.attributes.position;
	const vertexCount = position.count;
	const vertices = new Float32Array(vertexCount * 3);
	const _v = new THREE.Vector3();

	for (let i = 0; i < vertexCount; i++) {
		_v.fromBufferAttribute(position, i);
		_v.applyMatrix4(mesh.matrixWorld);
		vertices[i * 3] = _v.x;
		vertices[i * 3 + 1] = _v.y;
		vertices[i * 3 + 2] = _v.z;
	}

	const indices = new Uint32Array(vertexCount);
	for (let i = 0; i < vertexCount; i++) {
		indices[i] = i;
	}

	const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
	const collider = world.createCollider(
		RAPIER.ColliderDesc.trimesh(vertices, indices)
			.setFriction(1.0)
			.setRestitution(0),
		body
	);

	geometry.dispose();
	return collider;
}
