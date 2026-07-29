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
export function updateHumanCamera(
	camera: PerspectiveCamera,
	human: HumanEntity,
	input: ChaseCameraInput,
	dt: number
): void {
	_humanPos.copy(human.mesh.position);

	// Auto-center camera if human is moving and user isn't dragging
	if (!input.isDragging) {
		const v = human.body.linvel();
		const speed = Math.hypot(v.x, v.z);
		if (speed > 0.5) {
			// Human yaw is derived from its quaternion
			_humanEuler.setFromQuaternion(human.mesh.quaternion, "YXZ");
			const humanYaw = _humanEuler.y;
			
			// We want input.yaw to approach (humanYaw - Math.PI)
			// Need to handle wrap-around for shortest path interpolation
			let targetYaw = humanYaw - Math.PI;
			
			// Normalize angles to -PI to PI
			const diff = Math.atan2(Math.sin(targetYaw - input.yaw), Math.cos(targetYaw - input.yaw));
			
			// Gently lerp
			input.yaw += diff * (1 - Math.exp(-3.0 * dt));
		}
	}

	// Instead of snapping to the human's rotation, we let the camera rotate freely via input.
	// We'll base camYaw purely on the input yaw relative to an absolute coordinate (or you can use mesh forward if you want it to behave like a vehicle).
	// Typically for characters, camera rotation is free.
	const camYaw = input.yaw + Math.PI; 
	const pitch = input.pitch;

	const horizDist = input.distance * Math.cos(pitch) * 0.5; // Closer to character
	const lift = input.distance * Math.sin(pitch) * 0.5;

	_humanTargetCam.set(
		_humanPos.x - Math.sin(camYaw) * horizDist,
		_humanPos.y + lift + CAM_HEIGHT - 1.0,
		_humanPos.z - Math.cos(camYaw) * horizDist
	);

	const blend = 1 - Math.exp(-CAM_SMOOTH * dt * 1.5);
	camera.position.lerp(_humanTargetCam, blend);

	_lookAt.copy(_humanPos);
	_lookAt.y += 1.2; // Look at head/chest height

	camera.lookAt(_lookAt);
}
