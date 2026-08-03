import * as THREE from "three";
import { getWorld } from "../../physics/world";
import {
	findSafeTerrainSpawn,
	getWorldTerrainY,
	hasTerrainAt,
	isOutsideTerrain,
} from "../../terrain/islandHeight";
import type { CarController } from "./carController";
import { CAR_CONFIG } from "./carConfig";
import type { CarEntity } from "./createCar";

const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");

/** True when the car has left the driveable terrain (or fallen off the map). */
export function isCarOutsideWorld(car: CarEntity): boolean {
	const t = car.body.translation();
	return isOutsideTerrain(t.x, t.y, t.z);
}

/** Upright the car at its current XZ, on terrain, facing the same compass heading. */
export function resetCarUpright(car: CarEntity, controller: CarController) {
	const t = car.body.translation();
	const r = car.body.rotation();

	_quat.set(r.x, r.y, r.z, r.w);
	_euler.setFromQuaternion(_quat, "YXZ");
	const yaw = _euler.y;
	const halfYaw = yaw * 0.5;

	const spawn = hasTerrainAt(t.x, t.z)
		? new THREE.Vector3(
				t.x,
				getWorldTerrainY(t.x, t.z) + CAR_CONFIG.spawn.clearance,
				t.z
			)
		: findSafeTerrainSpawn(t.x, t.z, CAR_CONFIG.spawn.clearance);

	car.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
	car.body.setRotation(
		{ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) },
		true
	);
	car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
	car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

	controller.resetDriveState();
	settleVehicle(car);
}

export function respawnCarAtStart(
	car: CarEntity,
	controller: CarController,
	customSpawnPoint?: THREE.Vector3
) {
	let spawn: THREE.Vector3;
	if (customSpawnPoint && hasTerrainAt(customSpawnPoint.x, customSpawnPoint.z)) {
		spawn = new THREE.Vector3(
			customSpawnPoint.x,
			getWorldTerrainY(customSpawnPoint.x, customSpawnPoint.z) +
				CAR_CONFIG.spawn.clearance,
			customSpawnPoint.z
		);
	} else if (customSpawnPoint) {
		spawn = findSafeTerrainSpawn(
			customSpawnPoint.x,
			customSpawnPoint.z,
			CAR_CONFIG.spawn.clearance
		);
	} else {
		spawn = findSafeTerrainSpawn(
			CAR_CONFIG.spawn.x,
			CAR_CONFIG.spawn.z,
			CAR_CONFIG.spawn.clearance
		);
	}

	car.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
	car.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
	car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
	car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

	controller.resetDriveState();
	settleVehicle(car);
}

function settleVehicle(car: CarEntity) {
	const world = getWorld();
	for (let i = 0; i < 40; i++) {
		car.vehicle.updateVehicle(1 / 60);
		world.step();
	}
}
