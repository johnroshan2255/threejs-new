import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { HUMMER_CONFIG } from "./hummerConfig";

const MODEL_URL = "/models/cars/hummer.glb";

// The Hummer GLB uses the conventional names: FL/FR are the front axle and
// RL/RR are the rear axle.  The body and wheel positions are both rotated
// below, so these identities stay correct in the rendered vehicle too.
const WHEEL_NAMES = {
	RL: "Wheel_RL",
	RR: "Wheel_RR",
	FL: "Wheel_FL",
	FR: "Wheel_FR",
};

const _box = new THREE.Box3();

let sharedDracoLoader: DRACOLoader | null = null;

export async function loadHummerVisual(
	colliderYOffset: number,
	manager?: THREE.LoadingManager
) {
	const loader = new GLTFLoader(manager);
	
	if (!sharedDracoLoader) {
		sharedDracoLoader = new DRACOLoader();
		sharedDracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
	}
	loader.setDRACOLoader(sharedDracoLoader);

	const gltf = await loader.loadAsync(MODEL_URL);
	
	const model = gltf.scene.clone();
	
	// The hummer model might be huge or tiny, let's establish a base scale.
	// We'll calculate its bounding box and scale it so its length roughly matches the Kenney SUV (around 4-5 units).
	_box.setFromObject(model);
	const size = new THREE.Vector3();
	_box.getSize(size);
	
	const targetLength = 6.9696; // Increased by another 20% from 5.808
	const scale = targetLength / size.z;
	model.scale.setScalar(scale);
	model.updateMatrixWorld(true);

	// The visual center of the car might not be at 0,0,0.
	// We'll wrap it in a group to offset it if necessary.
	const bodyWrapper = new THREE.Group();
	
	// Separate chassis parts from wheels
	const chassisParts: THREE.Object3D[] = [];
	const wheels: Record<string, THREE.Object3D> = {};

	model.traverse((child) => {
		if (child instanceof THREE.Mesh) {
			child.castShadow = true;
			child.receiveShadow = true;
		}

		if (child.name === WHEEL_NAMES.FL) wheels["fl"] = child;
		else if (child.name === WHEEL_NAMES.FR) wheels["fr"] = child;
		else if (child.name === WHEEL_NAMES.RL) wheels["rl"] = child;
		else if (child.name === WHEEL_NAMES.RR) wheels["rr"] = child;
		else if (
			child.name === "Body" ||
			child.name === "Frame" ||
			child.name === "Glass" ||
			child.name === "Salon"
		) {
			chassisParts.push(child);
		}
	});

	// Detach wheels and chassis from the original model structure so we can flatten it
	const chassisGroup = new THREE.Group();
	chassisParts.forEach(p => {
		// Keep local transforms but parent to chassis
		p.removeFromParent();
		chassisGroup.add(p);
	});
	chassisGroup.scale.setScalar(scale);
	chassisGroup.rotation.y = Math.PI; // Rotate just the body 180 degrees to face forward

	// We offset the visual body downward by colliderYOffset
	// because the physics center of mass is typically near the bottom of the chassis.
	chassisGroup.position.y = colliderYOffset;
	bodyWrapper.add(chassisGroup);

	// Wheels logic: extract world position of the wheels to feed into physics
	// Note: Rapier raycast vehicle expects wheel positions relative to the *RigidBody* center.
	// We also need to detach the visual wheels to update them independently every frame.
	
	// This must match the rendered tire radius.  The previous fixed 0.8 m
	// radius was larger than the GLB tires after their length-based scaling, so
	// Rapier's invisible raycast wheels contacted the terrain before the visible
	// Hummer wheels did and the whole vehicle appeared to hover.
	let wheelRadius = 0;

	const extractedWheels: THREE.Group[] = [];
	const physicsWheelPositions: THREE.Vector3[] = [];

	// Map them in the same order as Kenney SUV: back-left, back-right, front-left, front-right
	const orderedWheelKeys = ["rl", "rr", "fl", "fr"];

	for (const key of orderedWheelKeys) {
		const originalWheel = wheels[key];
		const visualWheelGroup = new THREE.Group();
		
		if (originalWheel) {
			// Find its world position based on the scaled model
			originalWheel.updateWorldMatrix(true, false);
			_box.setFromObject(originalWheel);
			const wheelCenter = _box.getCenter(new THREE.Vector3());
			const wheelSize = _box.getSize(new THREE.Vector3());
			// Hummer axles run along X, therefore Y/Z describe the tire diameter.
			wheelRadius = Math.max(wheelRadius, wheelSize.y * 0.5, wheelSize.z * 0.5);
			// chassisGroup has a 180° Y turn, therefore the Rapier connection
			// points must receive the same local-space turn.
			wheelCenter.x = -wheelCenter.x;
			wheelCenter.z = -wheelCenter.z;
			
			// Offset the physics connection point upwards by the suspension resting length
			// so that when the suspension extends, the wheels sit perfectly inside the wheel wells
			wheelCenter.y += HUMMER_CONFIG.suspension.restLength;
			
			// We store this bounding box center as the physics attachment point
			physicsWheelPositions.push(wheelCenter.clone());
			
			// Detach from model
			originalWheel.removeFromParent();
			
			// We can center geometries directly to avoid nested transform headaches
			originalWheel.traverse((child) => {
				if (child instanceof THREE.Mesh) {
					child.geometry.computeBoundingBox();
					const gCenter = child.geometry.boundingBox.getCenter(new THREE.Vector3());
					child.geometry.translate(-gCenter.x, -gCenter.y, -gCenter.z);
				}
			});
			
			originalWheel.position.set(0, 0, 0);
			originalWheel.scale.setScalar(scale);
			
			visualWheelGroup.add(originalWheel);
		} else {
			// Fallback if wheel not found (front is +Z, rear is -Z)
			physicsWheelPositions.push(new THREE.Vector3(key.includes('L') ? -1 : 1, HUMMER_CONFIG.suspension.restLength, key.includes('F') ? 1.5 : -1.5));
		}
		
		extractedWheels.push(visualWheelGroup);
	}

	// Keep a sensible fallback if a future Hummer GLB renames all wheel meshes.
	wheelRadius = Math.max(wheelRadius, 0.18);

	// Calculate overall chassis size for physics (using the scaled chassisGroup)
	bodyWrapper.updateMatrixWorld(true);
	_box.setFromObject(chassisGroup);
	const chassisSize = new THREE.Vector3();
	_box.getSize(chassisSize);
	
	// The Hummer model has some extreme bounds sometimes (e.g. antennas).
	// Cap the height and width to keep physics stable. Also ensure it's never 0.
	chassisSize.x = Math.max(0.5, Math.min(chassisSize.x, 2.2));
	chassisSize.y = Math.max(0.5, Math.min(chassisSize.y, 1.8));
	chassisSize.z = Math.max(0.5, Math.min(chassisSize.z, 5.0));

	return {
		body: bodyWrapper,
		visualWheels: extractedWheels,
		physicsWheelPositions,
		wheelRadius,
		chassisSize,
	};
}
