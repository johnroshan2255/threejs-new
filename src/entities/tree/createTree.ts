import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { getWorldTerrainY } from "../../terrain/islandHeight";
import {
	createFoliageMaterial,
	setFoliageLeafColor,
	type FoliageMaterial,
} from "./foliageMaterial";

const TREE_URL = "/models/tree/tree.glb";
const FOLIAGE_ALPHA_URL = "/models/tree/foliage_alpha3.png";

export type TreeHandle = {
	group: THREE.Group;
	foliageMaterial: FoliageMaterial;
	setLeafColor: (color: THREE.ColorRepresentation) => void;
	setPosition: (x: number, y: number, z: number) => void;
	snapToTerrain: () => void;
	dispose: () => void;
};

export type CreateTreeOptions = {
	position?: THREE.Vector3Tuple | THREE.Vector3;
	rotationY?: number;
	scale?: number;
	leafColor?: THREE.ColorRepresentation;
	trunkColor?: THREE.ColorRepresentation;
	placeOnTerrain?: boolean;
	windSpeed?: number;
	effectBlend?: number;
	inflate?: number;
	foliageScale?: number;
	/**
	 * Extra foliage clones (rotated) to thicken the canopy.
	 * 1 = original only; 4–6 looks much fuller.
	 */
	leafLayers?: number;
	manager?: THREE.LoadingManager;
};

type TreeTemplate = {
	trunk: THREE.Mesh;
	foliage: THREE.Mesh;
	alphaMap: THREE.Texture;
};

let templatePromise: Promise<TreeTemplate> | null = null;

function loadTexture(
	url: string,
	manager?: THREE.LoadingManager
): Promise<THREE.Texture> {
	return new Promise((resolve, reject) => {
		new THREE.TextureLoader(manager).load(
			url,
			(tex) => {
				tex.colorSpace = THREE.NoColorSpace;
				tex.needsUpdate = true;
				resolve(tex);
			},
			undefined,
			reject
		);
	});
}

function loadTreeTemplate(manager?: THREE.LoadingManager): Promise<TreeTemplate> {
	if (!templatePromise) {
		templatePromise = (async () => {
			const loader = new GLTFLoader(manager);
			const [gltf, alphaMap] = await Promise.all([
				loader.loadAsync(TREE_URL),
				loadTexture(FOLIAGE_ALPHA_URL, manager),
			]);

			let trunk: THREE.Mesh | null = null;
			let foliage: THREE.Mesh | null = null;

			gltf.scene.traverse((child) => {
				if (!(child instanceof THREE.Mesh)) return;
				if (child.name === "trunk") trunk = child;
				if (child.name === "foliage") foliage = child;
			});

			if (!trunk || !foliage) {
				throw new Error("tree.glb missing trunk/foliage meshes");
			}

			return { trunk, foliage, alphaMap };
		})();
	}
	return templatePromise;
}

function toTuple(
	position?: THREE.Vector3Tuple | THREE.Vector3
): THREE.Vector3Tuple {
	if (!position) return [0, 0, 0];
	if (position instanceof THREE.Vector3) {
		return [position.x, position.y, position.z];
	}
	return position;
}

/**
 * Exact douges.dev tree — black trunk + windy alpha foliage.
 *
 * @example
 * const tree = await createTree({ position: [8, 0, 4], leafColor: "#3f6d21" });
 * scene.add(tree.group);
 * tree.setLeafColor("#6b9a3c");
 */
export async function createTree(
	options: CreateTreeOptions = {}
): Promise<TreeHandle> {
	const {
		rotationY = 0,
		scale = 1,
		leafColor = "#3f6d21",
		trunkColor = "#3b2a1a",
		placeOnTerrain = true,
		windSpeed = 1,
		effectBlend = 1,
		inflate = 0,
		foliageScale = 1,
		leafLayers = 1,
		manager,
	} = options;

	const [x0, y0, z0] = toTuple(options.position);
	const template = await loadTreeTemplate(manager);

	const trunk = template.trunk.clone(true);
	trunk.castShadow = true;
	trunk.receiveShadow = true;
	trunk.material = new THREE.MeshStandardMaterial({
		color: new THREE.Color(trunkColor),
		roughness: 0.92,
		metalness: 0,
	});

	const foliageMaterial = createFoliageMaterial({
		leafColor,
		alphaMap: template.alphaMap,
		effectBlend,
		inflate,
		foliageScale,
		windSpeed,
	});

	const group = new THREE.Group();
	group.name = "tree";
	group.add(trunk);

	const layers = Math.max(1, Math.floor(leafLayers));
	for (let i = 0; i < layers; i++) {
		const foliage = template.foliage.clone(true);
		foliage.castShadow = true;
		foliage.receiveShadow = true;
		foliage.material = foliageMaterial;
		// Fan extra layers around Y so leaf cards fill gaps.
		foliage.rotation.y = (i / layers) * Math.PI * 2;
		if (i > 0) {
			foliage.position.y += (i % 2 === 0 ? 0.08 : -0.05) * i;
		}
		group.add(foliage);
	}

	group.rotation.y = rotationY;
	group.scale.setScalar(scale);

	let y = y0;
	if (placeOnTerrain) {
		y = getWorldTerrainY(x0, z0);
	}
	group.position.set(x0, y, z0);

	return {
		group,
		foliageMaterial,
		setLeafColor(color) {
			setFoliageLeafColor(foliageMaterial, color);
		},
		setPosition(x, nextY, z) {
			group.position.set(x, nextY, z);
		},
		snapToTerrain() {
			const { x, z } = group.position;
			group.position.y = getWorldTerrainY(x, z);
		},
		dispose() {
			group.removeFromParent();
			(trunk.material as THREE.Material).dispose();
			foliageMaterial.dispose();
		},
	};
}

export async function createTrees(
	entries: CreateTreeOptions[],
	manager?: THREE.LoadingManager
): Promise<TreeHandle[]> {
	await loadTreeTemplate(manager);
	return Promise.all(
		entries.map((entry) => createTree({ ...entry, manager }))
	);
}
