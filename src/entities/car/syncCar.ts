import * as THREE from "three";
import type { CarEntity } from "./createCar";

const _steerAxis = new THREE.Vector3(0, 1, 0);
const _spinAxis = new THREE.Vector3(1, 0, 0);
const _wheelSteerQuat = new THREE.Quaternion();
const _wheelSpinQuat = new THREE.Quaternion();

export function syncCar(car: CarEntity) {
	const pos = car.body.translation();
	const rot = car.body.rotation();

	car.mesh.position.set(pos.x, pos.y, pos.z);
	car.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);

	const { vehicle } = car;
	const frontSteer = vehicle.wheelSteering(car.steeringWheelIndices[0]) ?? 0;

	car.wheels.forEach((wheel, i) => {
		const connection = vehicle.wheelChassisConnectionPointCs(i);
		const suspension = vehicle.wheelSuspensionLength(i);
		if (!connection) return;

		wheel.position.set(
			connection.x,
			connection.y - (suspension ?? 0),
			connection.z
		);

		const steering = car.steeringWheelIndices.includes(i) ? frontSteer : 0;
		const rotation = vehicle.wheelRotation(i) ?? 0;

		_wheelSteerQuat.setFromAxisAngle(_steerAxis, steering);
		_wheelSpinQuat.setFromAxisAngle(_spinAxis, rotation);

		wheel.quaternion.copy(_wheelSteerQuat).multiply(_wheelSpinQuat);
	});

	if (car.fpvInterior) {
		const sw = car.fpvInterior.getObjectByName("steering-wheel");
		if (sw) {
			// Steering wheel is tilted, so we rotate around its local Z axis
			sw.rotation.z = -frontSteer * 2.0; // Multiplier to exaggerate steering wheel turn
		}
	}
}
