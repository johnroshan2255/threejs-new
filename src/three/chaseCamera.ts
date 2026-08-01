import type { PerspectiveCamera } from "three";
import * as THREE from "three";
import type { CarEntity } from "../entities/car/createCar";
import { getCarGroundForward } from "../entities/car/cameraDrive";
import type { ChaseCameraInput } from "./chaseCameraInput";
import type { HumanEntity } from "../entities/human/HumanEntity";

const CAM_HEIGHT = 2.8;
const CAM_LOOK_AHEAD = 5;
const CAM_SMOOTH = 9;

const _carPos = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _targetCam = new THREE.Vector3();
const _lookAt = new THREE.Vector3();

export function updateChaseCamera(
	camera: PerspectiveCamera,
	car: CarEntity,
	input: ChaseCameraInput,
	dt: number
): void {
	_carPos.copy(car.mesh.position);
	_forward.copy(getCarGroundForward(car.body));

	const carYaw = Math.atan2(_forward.x, _forward.z);

	// Auto-center camera if car is moving and user isn't dragging
	if (!input.isDragging) {
		const v = car.body.linvel();
		const speed = Math.hypot(v.x, v.z);
		if (speed > 1.0) {
			// Gently lerp relative yaw back to 0
			input.yaw *= Math.exp(-2.0 * dt);
		}
	}

	const camYaw = carYaw + input.yaw;
	const pitch = input.pitch;

	const horizDist = input.distance * Math.cos(pitch);
	const lift = input.distance * Math.sin(pitch);

	_targetCam.set(
		_carPos.x - Math.sin(camYaw) * horizDist,
		_carPos.y + lift + CAM_HEIGHT,
		_carPos.z - Math.cos(camYaw) * horizDist
	);

	const blend = 1 - Math.exp(-CAM_SMOOTH * dt);
	camera.position.lerp(_targetCam, blend);

	const lookAheadDist = CAM_LOOK_AHEAD * Math.max(0, Math.cos(input.yaw));
	_lookAt.copy(_carPos).addScaledVector(_forward, lookAheadDist);
	_lookAt.y = _carPos.y + 1.1;

	camera.lookAt(_lookAt);
}

const _humanPos = new THREE.Vector3();
const _humanTargetCam = new THREE.Vector3();
const _humanEuler = new THREE.Euler();
const _aimDir = new THREE.Vector3();
const _aimRight = new THREE.Vector3();
const _aimUp = new THREE.Vector3(0, 1, 0);

export type HumanCameraOptions = {
	/** GTA ADS: hold RMB — over-shoulder free look; crosshair = screen center. */
	aimMode?: boolean;
};

/**
 * Third-person human camera.
 * aimMode (RMB): GTA-style over-shoulder ADS — mouse yaw/pitch aims;
 * HUD crosshair stays at screen center and marks camera forward.
 */
export function updateHumanCamera(
	camera: PerspectiveCamera,
	human: HumanEntity,
	input: ChaseCameraInput,
	dt: number,
	options: HumanCameraOptions = {}
): void {
	_humanPos.copy(human.mesh.position);
	const aimMode = Boolean(options.aimMode);

	if (aimMode) {
		// Fully mouse-driven aim (no auto-recenter fighting the crosshair)
		const yaw = input.yaw + Math.PI;
		const pitch = input.pitch;

		// Forward from yaw/pitch. Positive pitch = look down (matches chase-cam orbit).
		_aimDir.set(
			Math.sin(yaw) * Math.cos(pitch),
			-Math.sin(pitch),
			Math.cos(yaw) * Math.cos(pitch)
		).normalize();
		_aimRight.crossVectors(_aimDir, _aimUp).normalize();
		// If looking straight up/down, fall back
		if (_aimRight.lengthSq() < 1e-6) {
			_aimRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
		}

		const back = 3.2;
		const up = 1.55;
		const shoulder = 0.7;

		_humanTargetCam
			.copy(_humanPos)
			.addScaledVector(_aimUp, up)
			.addScaledVector(_aimRight, shoulder)
			.addScaledVector(_aimDir, -back);

		// Snap while aiming so mouse ↔ crosshair stay 1:1 (no lag fighting aim)
		const blend = 1 - Math.exp(-CAM_SMOOTH * dt * 3.5);
		camera.position.lerp(_humanTargetCam, blend);

		_lookAt.copy(camera.position).addScaledVector(_aimDir, 40);
		camera.lookAt(_lookAt);
		return;
	}

	// —— Normal (unarmed) chase cam ——
	if (!input.isDragging) {
		const v = human.body.linvel();
		const speed = Math.hypot(v.x, v.z);
		if (speed > 0.5) {
			_humanEuler.setFromQuaternion(human.mesh.quaternion, "YXZ");
			const humanYaw = _humanEuler.y;
			const targetYaw = humanYaw - Math.PI;
			const diff = Math.atan2(
				Math.sin(targetYaw - input.yaw),
				Math.cos(targetYaw - input.yaw)
			);
			input.yaw += diff * (1 - Math.exp(-3.0 * dt));
		}
	}

	const camYaw = input.yaw + Math.PI;
	const pitch = input.pitch;

	const horizDist = input.distance * Math.cos(pitch) * 0.5;
	const lift = input.distance * Math.sin(pitch) * 0.5;

	_humanTargetCam.set(
		_humanPos.x - Math.sin(camYaw) * horizDist,
		_humanPos.y + lift + CAM_HEIGHT - 1.0,
		_humanPos.z - Math.cos(camYaw) * horizDist
	);

	const blend = 1 - Math.exp(-CAM_SMOOTH * dt * 1.5);
	camera.position.lerp(_humanTargetCam, blend);

	_lookAt.copy(_humanPos);
	_lookAt.y += 1.2;
	camera.lookAt(_lookAt);
}
