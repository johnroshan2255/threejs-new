import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";

const _localForward = new THREE.Vector3(0, 0, -1);
const _worldForward = new THREE.Vector3();
const _quat = new THREE.Quaternion();

/** Chassis -Z is the front of the car (matches wheel layout). */
export function getCarGroundForward(body: RAPIER.RigidBody): THREE.Vector3 {
	getCarForward3D(body);
	_worldForward.y = 0;

	if (_worldForward.lengthSq() < 1e-6) {
		return _worldForward.set(0, 0, -1);
	}

	return _worldForward.normalize();
}

export function getCarForward3D(body: RAPIER.RigidBody): THREE.Vector3 {
	const r = body.rotation();
	_quat.set(r.x, r.y, r.z, r.w);
	_worldForward.copy(_localForward).applyQuaternion(_quat);

	if (_worldForward.lengthSq() < 1e-6) {
		return _worldForward.set(0, 0, -1);
	}

	return _worldForward.normalize();
}
