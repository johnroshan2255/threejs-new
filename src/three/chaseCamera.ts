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

	_lookAt.copy(_carPos).addScaledVector(_forward, CAM_LOOK_AHEAD);
	_lookAt.y = _carPos.y + 1.1;

	camera.lookAt(_lookAt);
}

const _humanPos = new THREE.Vector3();
const _humanTargetCam = new THREE.Vector3();
export function updateHumanCamera(
	camera: PerspectiveCamera,
	human: HumanEntity,
	input: ChaseCameraInput,
	dt: number
): void {
	_humanPos.copy(human.mesh.position);

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
