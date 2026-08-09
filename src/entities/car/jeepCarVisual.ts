import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { JEEP_CONFIG } from "./jeepConfig";

const MODEL_URL = "/models/cars/nissan_patrol_extreme.glb";

// Nissan Patrol wheel mapping based on GLTF node positions
const WHEEL_NAMES = {
	FR: "wheel.001",
	RR: "wheel.002",
	RL: "wheel.003",
	FL: "wheel.004",
};

const _box = new THREE.Box3();

let sharedDracoLoader: DRACOLoader | null = null;

export async function loadJeepVisual(
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
	
	const targetLength = 6.72; // Scaled down 30% from 9.6
	const scale = targetLength / size.z;
	model.scale.setScalar(scale);
	model.updateMatrixWorld(true);

	// The visual center of the car might not be at 0,0,0.
	// We'll wrap it in a group to offset it if necessary.
	const bodyWrapper = new THREE.Group();
	
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
	});

	const chassisGroup = new THREE.Group();
	chassisGroup.add(model);
	chassisGroup.scale.setScalar(scale);
	
	// The Jeep's base is in the middle of its bounding box.
	// We want its physical center of mass to be at the bottom of its geometry.
	chassisGroup.updateMatrixWorld(true);
	_box.setFromObject(chassisGroup);
	const chassisCenter = _box.getCenter(new THREE.Vector3());
	chassisCenter.y = _box.min.y;
	model.position.copy(chassisCenter).divideScalar(-scale);
	model.updateMatrixWorld(true);

	chassisGroup.rotation.y = Math.PI; // Rotate just the body 180 degrees to face forward
	chassisGroup.position.y = 0;
	chassisGroup.updateMatrixWorld(true);

	let wheelRadius = 0;
	const extractedWheels: THREE.Group[] = [];
	const physicsWheelPositions: THREE.Vector3[] = [];

	// Find all wheel meshes
	const wheelMeshes: THREE.Mesh[] = [];
	model.traverse((child) => {
		if (child instanceof THREE.Mesh) {
			child.castShadow = true;
			child.receiveShadow = true;
			if (child.name.toLowerCase().includes("wheel")) {
				wheelMeshes.push(child);
			}
		}
	});

	// Cluster meshes by world position (combines rims, tires, calipers into single wheels)
	const clusters: { center: THREE.Vector3, meshes: THREE.Mesh[] }[] = [];
	for (const mesh of wheelMeshes) {
		mesh.updateWorldMatrix(true, false);
		_box.setFromObject(mesh);
		const center = _box.getCenter(new THREE.Vector3());
		
		let added = false;
		for (const cluster of clusters) {
			if (cluster.center.distanceTo(center) < 0.5) { // 0.5m radius for same wheel
				cluster.meshes.push(mesh);
				cluster.center.add(center).multiplyScalar(0.5); // approximate average center
				added = true;
				break;
			}
		}
		if (!added) {
			clusters.push({ center, meshes: [mesh] });
		}
	}

	// Filter out spare tires (usually near the X center of the car)
	const driveWheels = clusters.filter(c => Math.abs(c.center.x) > 0.4);

	let assignedClusters: Record<string, typeof clusters[0]> = {};
	
	if (driveWheels.length >= 4) {
		// Sort by Z to separate front and rear (remember chassis is rotated 180, so +Z is front)
		driveWheels.sort((a, b) => b.center.z - a.center.z);
		const front = [driveWheels[0], driveWheels[1]];
		const rear = [driveWheels[2], driveWheels[3]];
		
		// Sort by X to separate left and right (facing +Z, left is +X)
		front.sort((a, b) => b.center.x - a.center.x);
		rear.sort((a, b) => b.center.x - a.center.x);

		assignedClusters = {
			fl: front[0],
			fr: front[1],
			rl: rear[0],
			rr: rear[1]
		};
	}

	const orderedWheelKeys = ["rl", "rr", "fl", "fr"];

	for (const key of orderedWheelKeys) {
		const cluster = assignedClusters[key];
		const visualWheelGroup = new THREE.Group();
		
		if (cluster && cluster.meshes.length > 0) {
			// Compute true bounding box of the entire wheel cluster
			_box.makeEmpty();
			for (const mesh of cluster.meshes) {
				mesh.updateWorldMatrix(true, false);
				_box.expandByObject(mesh);
			}
			const wheelCenter = _box.getCenter(new THREE.Vector3());
			const wheelSize = _box.getSize(new THREE.Vector3());
			
			wheelRadius = Math.max(wheelRadius, wheelSize.y * 0.5, wheelSize.z * 0.5);
			
			// Rapier attachment point is exactly restLength above the visual center
			wheelCenter.y += JEEP_CONFIG.suspension.restLength;
			physicsWheelPositions.push(wheelCenter.clone());
			
			// Detach all sub-meshes and perfectly center them in the new group
			for (const mesh of cluster.meshes) {
				// Bake world transform into geometry so we can zero out the mesh position
				mesh.updateWorldMatrix(true, false);
				mesh.geometry.applyMatrix4(mesh.matrixWorld);
				
				// Translate geometry so the cluster center is the pivot (0,0,0)
				// We subtract JEEP_CONFIG.suspension.restLength because wheelCenter includes it!
				mesh.geometry.translate(
					-wheelCenter.x,
					-(wheelCenter.y - JEEP_CONFIG.suspension.restLength),
					-wheelCenter.z
				);
				
				mesh.removeFromParent();
				mesh.position.set(0, 0, 0);
				mesh.rotation.set(0, 0, 0);
				mesh.scale.setScalar(1); // Scale is already baked in
				
				visualWheelGroup.add(mesh);
			}
		} else {
			// Fallback if clustering fails
			physicsWheelPositions.push(new THREE.Vector3(key.includes('L') ? -1 : 1, JEEP_CONFIG.suspension.restLength, key.includes('F') ? 1.5 : -1.5));
		}
		
		extractedWheels.push(visualWheelGroup);
	}

	// Now apply the visual chassis offset
	chassisGroup.position.y = colliderYOffset;
	bodyWrapper.add(chassisGroup);

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
