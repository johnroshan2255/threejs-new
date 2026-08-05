import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import RAPIER from "@dimforge/rapier3d-compat";
import type { DynamicRayCastVehicleController } from "@dimforge/rapier3d-compat";
import { getWorldTerrainY } from "../../terrain/islandHeight";
import { getWorld } from "../../physics/world";
import { CAR_CONFIG } from "./carConfig";
import { loadKenneySuvVisual } from "./kenneyCarVisual";
import { computeGrappleMountLocal } from "./vehicleGrapple";
import { createFpvInterior } from "./createFpvInterior";

export type CarEntity = {
	body: RAPIER.RigidBody;
	collider: RAPIER.Collider;
	mesh: THREE.Group;
	wheels: THREE.Group[];
	vehicle: DynamicRayCastVehicleController;
	driveFrontAxleIndices: number[];
	driveRearAxleIndices: number[];
	steeringWheelIndices: number[];
	/** Front bumper mount in chassis local space (any future car mesh). */
	grappleMountLocal: THREE.Vector3;
	fpvInterior?: THREE.Group;
	health: number;
	maxHealth?: number;
	isDestroyed?: boolean;
	timeSinceDestroyed: number;
	hasExploded: boolean;
	leftExhaust: THREE.Object3D;
	rightExhaust: THREE.Object3D;
};

export async function createCar(
	manager?: THREE.LoadingManager
): Promise<CarEntity> {
	const world = getWorld();
	const {
		driveFrontAxleIndices,
		driveRearAxleIndices,
		steeringWheelIndices,
		spawn,
		colliderYOffset,
		colliderRoundness,
		colliderHeightScale,
		colliderLocalYFactor,
		centerOfMassY,
		angularDamping,
		mass,
		suspension,
	} = CAR_CONFIG;

	const layout = await loadKenneySuvVisual(colliderYOffset, manager);
	const { chassisSize, physicsWheelPositions, wheelRadius } = layout;

	const fpvInterior = createFpvInterior();
	fpvInterior.visible = false;
	layout.body.add(fpvInterior);

	const leftExhaust = new THREE.Object3D();
	leftExhaust.position.set(-0.6, -0.65, -2.15);
	layout.body.add(leftExhaust);

	const rightExhaust = new THREE.Object3D();
	rightExhaust.position.set(0.6, -0.65, -2.15);
	layout.body.add(rightExhaust);


	const gltfLoader = new GLTFLoader(manager);
	try {
		const blasterGltf = await gltfLoader.loadAsync("/blaster.glb");
		const blasterMesh = blasterGltf.scene;

		const leftBlaster = blasterMesh.clone();
		leftBlaster.position.set(-0.6, -0.65, -2.15);
		leftBlaster.rotation.y = Math.PI; // point backwards
		leftBlaster.scale.setScalar(0.4);
		layout.body.add(leftBlaster);

		const rightBlaster = blasterMesh.clone();
		rightBlaster.position.set(0.6, -0.65, -2.15);
		rightBlaster.rotation.y = Math.PI;
		rightBlaster.scale.setScalar(0.4);
		layout.body.add(rightBlaster);
	} catch (e) {
		console.error("Failed to load blaster.glb", e);
	}

	const spawnY = getWorldTerrainY(spawn.x, spawn.z) + spawn.clearance;

	const hx = Math.max(0.1, (chassisSize.x / 2) - colliderRoundness);
	const hy = chassisSize.y / 2;
	const hz = Math.max(0.1, (chassisSize.z / 2) - colliderRoundness);
	const colliderHy = Math.max(0.1, (hy * colliderHeightScale) - colliderRoundness);
	const colliderLocalY = colliderYOffset + hy * colliderLocalYFactor;

	const body = world.createRigidBody(
		RAPIER.RigidBodyDesc.dynamic()
			.setTranslation(spawn.x, spawnY, spawn.z)
			.setLinearDamping(0.1)
			.setAngularDamping(angularDamping)
			.setCcdEnabled(true)
	);

	const collider = world.createCollider(
		RAPIER.ColliderDesc.roundCuboid(hx, colliderHy, hz, colliderRoundness)
			.setTranslation(0, colliderLocalY, 0)
			.setFriction(0.35)
			.setRestitution(0),
		body
	);

	const wx = hx * 2;
	const wy = colliderHy * 2;
	const wz = hz * 2;
	body.setAdditionalMassProperties(
		mass,
		{ x: 0, y: centerOfMassY, z: 0 },
		{
			x: (mass / 12) * (wy * wy + wz * wz),
			y: (mass / 12) * (wx * wx + wz * wz),
			z: (mass / 12) * (wx * wx + wy * wy),
		},
		{ w: 1, x: 0, y: 0, z: 0 },
		true
	);

	const vehicle = world.createVehicleController(body);
	vehicle.indexUpAxis = 1;
	vehicle.setIndexForwardAxis = 2;

	const suspensionDirection = { x: 0, y: -1, z: 0 };
	const axleDirection = { x: 1, y: 0, z: 0 };

	for (const [index, position] of physicsWheelPositions.entries()) {
		vehicle.addWheel(
			{ x: position[0], y: position[1], z: position[2] },
			suspensionDirection,
			axleDirection,
			suspension.restLength,
			wheelRadius
		);

		vehicle.setWheelSuspensionStiffness(index, suspension.stiffness);
		vehicle.setWheelMaxSuspensionTravel(index, suspension.maxTravel);
		vehicle.setWheelSuspensionCompression(index, suspension.compression);
		vehicle.setWheelSuspensionRelaxation(index, suspension.relaxation);
		vehicle.setWheelMaxSuspensionForce(index, suspension.maxForce);
		vehicle.setWheelFrictionSlip(index, 12);
		vehicle.setWheelSideFrictionStiffness(index, 0.8);
	}

	for (let i = 0; i < 90; i++) {
		vehicle.updateVehicle(1 / 60);
		world.step();
	}

	const wheels = physicsWheelPositions.map((pos) => {
		const wheel = layout.wheelTemplate.clone(true);
		if (pos[0] < 0) {
			wheel.scale.x = -Math.abs(wheel.scale.x);
		}
		wheel.traverse((child) => {
			if (!(child instanceof THREE.Mesh)) return;
			child.castShadow = true;
			child.receiveShadow = true;
			const mats = Array.isArray(child.material)
				? child.material
				: [child.material];
			for (const mat of mats) {
				if (mat) mat.side = THREE.DoubleSide;
			}
		});
		wheel.renderOrder = 5;
		return wheel;
	});

	return {
		body,
		collider,
		mesh: layout.body,
		wheels,
		vehicle,
		driveFrontAxleIndices,
		driveRearAxleIndices,
		steeringWheelIndices,
		grappleMountLocal: computeGrappleMountLocal(chassisSize, layout.body),
		fpvInterior,
		health: 100,
		maxHealth: 100,
		isDestroyed: false,
		timeSinceDestroyed: 0,
		hasExploded: false,
		leftExhaust,
		rightExhaust,
	};
}
