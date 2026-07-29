import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { getWorldTerrainY } from "../../terrain/islandHeight";

const STONE_URL = "/stone/stone_smallC.glb";

export type PlacedStoneHandle = {
	group: THREE.Group;
	dispose: () => void;
};

let templatePromise: Promise<THREE.Group> | null = null;

function loadStoneTemplate(manager?: THREE.LoadingManager): Promise<THREE.Group> {
	if (!templatePromise) {
		templatePromise = new Promise((resolve, reject) => {
			const loader = new GLTFLoader(manager);
			loader.load(
				STONE_URL,
				(gltf) => {
					const root = gltf.scene;
					root.traverse((child) => {
						if (!(child instanceof THREE.Mesh)) return;
						child.castShadow = true;
						child.receiveShadow = true;
					});
					resolve(root);
				},
				undefined,
				reject
			);
		});
	}
	return templatePromise;
}

export async function placeStone(options: {
	position: THREE.Vector3;
	scale?: number;
	rotationY?: number;
	manager?: THREE.LoadingManager;
}): Promise<PlacedStoneHandle> {
	const template = await loadStoneTemplate(options.manager);
	const group = template.clone(true);
	const scale = options.scale ?? 2.2 + Math.random() * 0.8;
	group.scale.setScalar(scale);
	group.rotation.y = options.rotationY ?? Math.random() * Math.PI * 2;
	const y = getWorldTerrainY(options.position.x, options.position.z);
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
