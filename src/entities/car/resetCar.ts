import * as THREE from "three";
import { getWorld } from "../../physics/world";
import { getWorldTerrainY } from "../../terrain/islandHeight";
import type { CarController } from "./carController";
import { CAR_CONFIG } from "./carConfig";
import type { CarEntity } from "./createCar";

const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");

/** Upright the car at its current XZ, on terrain, facing the same compass heading. */
export function resetCarUpright(car: CarEntity, controller: CarController) {
	const t = car.body.translation();
	const r = car.body.rotation();

	_quat.set(r.x, r.y, r.z, r.w);
	_euler.setFromQuaternion(_quat, "YXZ");
	const yaw = _euler.y;
	const halfYaw = yaw * 0.5;

	const y = getWorldTerrainY(t.x, t.z) + CAR_CONFIG.spawn.clearance;

	car.body.setTranslation({ x: t.x, y, z: t.z }, true);
	car.body.setRotation(
		{ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) },
		true
	);
	car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
	car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

	controller.resetDriveState();

	const world = getWorld();
	for (let i = 0; i < 40; i++) {
		car.vehicle.updateVehicle(1 / 60);
		world.step();
	}
}
