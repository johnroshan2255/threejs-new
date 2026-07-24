import type { PerspectiveCamera } from "three";
import * as THREE from "three";
import type { CarEntity } from "../entities/car/createCar";
import { getCarGroundForward } from "../entities/car/cameraDrive";
import type { ChaseCameraInput } from "./chaseCameraInput";

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
