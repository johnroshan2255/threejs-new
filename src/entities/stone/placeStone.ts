import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { getWorldTerrainY } from "../../terrain/islandHeight";
import { applySnowToMaterial } from "../../terrain/snowShading";

const DEFAULT_STONE_URL = "/stone/stone_smallC.glb";

export type PlacedStoneHandle = {
	group: THREE.Group;
	dispose: () => void;
};

const templateCache = new Map<string, Promise<THREE.Group>>();

function loadStoneTemplate(
	url: string,
	manager?: THREE.LoadingManager
): Promise<THREE.Group> {
	const key = url || DEFAULT_STONE_URL;
	let pending = templateCache.get(key);
	if (!pending) {
		pending = new Promise((resolve, reject) => {
			const loader = new GLTFLoader(manager);
			loader.load(
				key,
				(gltf) => {
					const root = gltf.scene;
					root.traverse((child) => {
						if (!(child instanceof THREE.Mesh)) return;
						child.castShadow = true;
						child.receiveShadow = true;
						// Patched on the template, which every placed stone shares
						// by reference (clone(true) does not clone materials). One
						// patch covers all of them, and the world-space mask still
						// decides snow per fragment, so bare and snowy stones can
						// coexist without per-instance data.
						const mats = Array.isArray(child.material)
							? child.material
							: [child.material];
						for (const mat of mats) if (mat) applySnowToMaterial(mat);
					});
					resolve(root);
				},
				undefined,
				reject
			);
		});
		templateCache.set(key, pending);
	}
	return pending;
}

export async function placeStone(options: {
	position: THREE.Vector3;
	scale?: number;
	rotationY?: number;
	/** Optional absolute Y; defaults to terrain height. */
	y?: number;
	assetUrl?: string;
	manager?: THREE.LoadingManager;
}): Promise<PlacedStoneHandle> {
	const template = await loadStoneTemplate(
		options.assetUrl ?? DEFAULT_STONE_URL,
		options.manager
	);
	const group = template.clone(true);
	const scale = options.scale ?? 2.2 + Math.random() * 0.8;
	group.scale.setScalar(scale);
	group.rotation.y = options.rotationY ?? Math.random() * Math.PI * 2;
	const y =
		options.y ??
		getWorldTerrainY(options.position.x, options.position.z);
	group.position.set(options.position.x, y, options.position.z);
	group.name = "PlacedStone";

	return {
		group,
		dispose: () => {
			group.removeFromParent();
			group.traverse((obj) => {
				if (!(obj instanceof THREE.Mesh)) return;
				obj.geometry?.dispose();
				const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
				for (const mat of mats) mat.dispose();
			});
		},
	};
}
