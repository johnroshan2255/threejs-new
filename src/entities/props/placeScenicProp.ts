import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { getWorld } from "../../physics/world";
import { getWorldTerrainY } from "../../terrain/islandHeight";

export type ScenicPropHandle = {
	group: THREE.Group;
	body: RAPIER.RigidBody | null;
	dispose: () => void;
};

const templateCache = new Map<string, Promise<THREE.Group>>();

function loadPropTemplate(
	url: string,
	manager?: THREE.LoadingManager
): Promise<THREE.Group> {
	let pending = templateCache.get(url);
	if (!pending) {
		pending = new Promise((resolve, reject) => {
			const loader = new GLTFLoader(manager);
			loader.load(
				url,
				(gltf) => {
					const root = gltf.scene;
					root.traverse((child) => {
						if (!(child instanceof THREE.Mesh)) return;
						child.castShadow = true;
						child.receiveShadow = true;
						child.frustumCulled = false;
					});
					resolve(root);
				},
				undefined,
				reject
			);
		});
		templateCache.set(url, pending);
	}
	return pending;
}

/**
 * Sketchfab (and similar) GLBs bake huge node matrices / offsets.
 * Wrap so the mesh AABB sits with feet at y=0 and XZ centered on origin.
 */
function normalizePropRoot(source: THREE.Group): {
	root: THREE.Group;
	nativeHeight: number;
} {
	const inner = source.clone(true);
	inner.updateMatrixWorld(true);

	const box = new THREE.Box3().setFromObject(inner);
	if (box.isEmpty()) {
		const root = new THREE.Group();
		root.add(inner);
		return { root, nativeHeight: 1 };
	}

	const size = new THREE.Vector3();
	const center = new THREE.Vector3();
	box.getSize(size);
	box.getCenter(center);

	inner.position.x -= center.x;
	inner.position.y -= box.min.y;
	inner.position.z -= center.z;

	const root = new THREE.Group();
	root.add(inner);
	root.updateMatrixWorld(true);

	return {
		root,
		nativeHeight: Math.max(0.001, size.y),
	};
}

/**
 * Place a GLB with height scaled to meters (human ≈ 1.8 m).
 * Bottom of the mesh sits on terrain. Optional fixed Rapier collider.
 */
export async function placeScenicProp(options: {
	assetUrl: string;
	position: { x: number; z: number };
	/** Desired world height in meters. */
	targetHeight: number;
	rotationY?: number;
	/** Add a fixed cuboid collider (default true). */
	withCollider?: boolean;
	manager?: THREE.LoadingManager;
}): Promise<ScenicPropHandle> {
	const template = await loadPropTemplate(options.assetUrl, options.manager);
	const { root: group, nativeHeight } = normalizePropRoot(template);

	const scale = options.targetHeight / nativeHeight;
	group.scale.setScalar(scale);

	const groundY = getWorldTerrainY(options.position.x, options.position.z);
	group.position.set(options.position.x, groundY, options.position.z);
	group.rotation.y = options.rotationY ?? 0;
	group.name = "ScenicProp";
	group.userData.assetUrl = options.assetUrl;
	group.updateMatrixWorld(true);

	let body: RAPIER.RigidBody | null = null;
	if (options.withCollider !== false) {
		const worldBox = new THREE.Box3().setFromObject(group);
		const worldSize = new THREE.Vector3();
		const center = new THREE.Vector3();
		worldBox.getSize(worldSize);
		worldBox.getCenter(center);

		const hx = Math.max(0.12, worldSize.x * 0.45);
		const hy = Math.max(0.08, worldSize.y * 0.48);
		const hz = Math.max(0.12, worldSize.z * 0.45);

		const world = getWorld();
		body = world.createRigidBody(
			RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z)
		);
		world.createCollider(
			RAPIER.ColliderDesc.cuboid(hx, hy, hz)
				.setFriction(0.85)
				.setRestitution(0.05),
			body
		);
	}

	return {
		group,
		body,
		dispose: () => {
			group.removeFromParent();
			if (body) {
				getWorld().removeRigidBody(body);
				body = null;
			}
			group.traverse((obj) => {
				if (!(obj instanceof THREE.Mesh)) return;
				obj.geometry?.dispose();
				const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
				for (const mat of mats) mat.dispose();
			});
		},
	};
}
