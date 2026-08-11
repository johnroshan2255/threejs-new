import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import RAPIER from "@dimforge/rapier3d-compat";
import type { DynamicRayCastVehicleController } from "@dimforge/rapier3d-compat";
import { getWorldTerrainY } from "../../terrain/islandHeight";
import { getWorld } from "../../physics/world";
import { CAR_CONFIG } from "./carConfig";
import { HUMMER_CONFIG } from "./hummerConfig";
import { JEEP_CONFIG } from "./jeepConfig";

import { loadHummerVisual } from "./hummerCarVisual";
import { loadJeepVisual } from "./jeepCarVisual";
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
	config: typeof CAR_CONFIG;
};

export type VehicleId = "hummer" | "jeep";

export async function createCar(
	manager?: THREE.LoadingManager,
	vehicleId: VehicleId = "jeep"
): Promise<CarEntity> {
	const world = getWorld();
	
	const activeConfig = vehicleId === "jeep" ? JEEP_CONFIG : (vehicleId === "hummer" ? HUMMER_CONFIG : CAR_CONFIG);
	
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
		exhaustMeshMounts,
		nitroMounts,
	} = activeConfig as any;

	const layout = activeConfig === JEEP_CONFIG
		? await loadJeepVisual(colliderYOffset, manager)
		: await loadHummerVisual(colliderYOffset, manager);

	// The user expects the "Elevation" slider to literally lift the car body higher relative to the wheels.
	// Since physics suspension can sometimes compress down and hide the lift, we guarantee 
	// the visual lift by physically raising the visual chassis mesh by the excess suspension length.
	const defaultRestLength = vehicleId === "jeep" ? 0.65 : (vehicleId === "hummer" ? 0.65 : 0.55);
	const visualLiftOffset = Math.max(0, activeConfig.suspension.restLength - defaultRestLength);
	
	// Shift the visual chassis group (which is the first child of the body wrapper) UP by the lift offset.
	// This separates it from the wheels visually without changing the physics center of gravity or colliders!
	if (layout.body.children.length > 0) {
		layout.body.children[0].position.y += visualLiftOffset;
	}
		
	// Determine how much the user scaled the tire size (wheelWidth) vs the default
	const defaultWheelWidth = activeConfig === JEEP_CONFIG ? 0.85 : (activeConfig === HUMMER_CONFIG ? 0.85 : 0.7);
	const wheelScaleMultiplier = activeConfig.wheelWidth / defaultWheelWidth;
	const dynamicWheelRadius = layout.wheelRadius * wheelScaleMultiplier;

	const { chassisSize, physicsWheelPositions } = layout;

	const fpvInterior = createFpvInterior();
	fpvInterior.visible = false;
	layout.body.add(fpvInterior);

	// The logical mounts for the nitro flames
	const nl = nitroMounts?.left || { x: -0.6, y: -0.65, z: -2.15 };
	const nr = nitroMounts?.right || { x: 0.6, y: -0.65, z: -2.15 };

	const leftExhaust = new THREE.Object3D();
	leftExhaust.position.set(nl.x, nl.y + visualLiftOffset, nl.z);
	layout.body.add(leftExhaust);

	const rightExhaust = new THREE.Object3D();
	rightExhaust.position.set(nr.x, nr.y + visualLiftOffset, nr.z);
	layout.body.add(rightExhaust);


	const gltfLoader = new GLTFLoader(manager);
	const dracoLoader = new DRACOLoader();
	dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
	gltfLoader.setDRACOLoader(dracoLoader);
	try {
		const blasterGltf = await gltfLoader.loadAsync("/blaster.glb");
		const blasterMesh = blasterGltf.scene;

		// The visual meshes for the exhaust tips
		const el = exhaustMeshMounts?.left || { x: -0.6, y: -0.65, z: -2.15 };
		const er = exhaustMeshMounts?.right || { x: 0.6, y: -0.65, z: -2.15 };

		const leftBlaster = blasterMesh.clone();
		leftBlaster.position.set(el.x, el.y + visualLiftOffset, el.z);
		leftBlaster.rotation.y = Math.PI; // point backwards
		leftBlaster.scale.setScalar(0.4);
		layout.body.add(leftBlaster);

		const rightBlaster = blasterMesh.clone();
		rightBlaster.position.set(er.x, er.y + visualLiftOffset, er.z);
		rightBlaster.rotation.y = Math.PI;
		rightBlaster.scale.setScalar(0.4);
		layout.body.add(rightBlaster);
	} catch (e) {
		console.error("Failed to load blaster.glb", e);
	}

	const spawnY = getWorldTerrainY(spawn.x, spawn.z) + 5.0;

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

	for (let i = 0; i < physicsWheelPositions.length; i++) {
		const rawPos = physicsWheelPositions[i] as any;
		const px = Array.isArray(rawPos) ? rawPos[0] : rawPos.x;
		const py = Array.isArray(rawPos) ? rawPos[1] : rawPos.y;
		const pz = Array.isArray(rawPos) ? rawPos[2] : rawPos.z;
		
		if (isNaN(px) || isNaN(py) || isNaN(pz) || isNaN(dynamicWheelRadius) || isNaN(suspension.restLength)) {
			console.error("NaN detected in Rapier params", {rawPos, dynamicWheelRadius, suspension});
			throw new Error("NaN detected in Rapier params");
		}
		
		vehicle.addWheel(
			{ x: px, y: py, z: pz },
			suspensionDirection,
			axleDirection,
			suspension.restLength,
			dynamicWheelRadius
		);

		const index = i;
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

	const wheels = physicsWheelPositions.map((pos, i) => {
		let wheel: THREE.Group;
		if (activeConfig === HUMMER_CONFIG || activeConfig === JEEP_CONFIG) {
			wheel = (layout as any).visualWheels[i];
		} else {
			wheel = (layout as any).wheelTemplate.clone(true);
		}
		
		// Apply dynamic tire size scaling visually
		wheel.scale.set(wheelScaleMultiplier, wheelScaleMultiplier, wheelScaleMultiplier);
		
		if (Array.isArray(pos) ? pos[0] < 0 : pos.x < 0) {
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

	let gmLocal: THREE.Vector3;
	if (activeConfig.grappleMount) {
		gmLocal = new THREE.Vector3(
			activeConfig.grappleMount.x,
			activeConfig.grappleMount.y + visualLiftOffset,
			activeConfig.grappleMount.z
		);
	} else {
		gmLocal = computeGrappleMountLocal(chassisSize, activeConfig, layout.body);
	}

	return {
		body,
		collider,
		mesh: layout.body,
		wheels,
		vehicle,
		driveFrontAxleIndices,
		driveRearAxleIndices,
		steeringWheelIndices,
		grappleMountLocal: gmLocal,
		fpvInterior,
		health: 100,
		maxHealth: 100,
		isDestroyed: false,
		timeSinceDestroyed: 0,
		hasExploded: false,
		leftExhaust,
		rightExhaust,
		config: activeConfig,
	};
}
