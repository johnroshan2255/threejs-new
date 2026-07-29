import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { getWorldTerrainY } from "../../terrain/islandHeight";

/** Small light-gray Kenney stones with varied silhouettes for pond edges. */
const STONE_MODELS = [
	"stone_smallA",
	"stone_smallB",
	"stone_smallC",
	"stone_smallD",
	"stone_smallE",
	"stone_smallF",
	"stone_smallG",
	"stone_smallH",
	"stone_smallI",
	"stone_smallFlatA",
	"stone_smallFlatB",
	"stone_smallFlatC",
] as const;

type StoneModelId = (typeof STONE_MODELS)[number];

type StoneTemplate = {
	geometry: THREE.BufferGeometry;
	material: THREE.Material | THREE.Material[];
};

export type PondStoneRingOptions = {
	center: THREE.Vector3;
	/** Pond radius in world units (pond width/2). */
	pondRadius?: number;
	manager?: THREE.LoadingManager;
};

export type PondStoneHandle = {
	group: THREE.Group;
	dispose: () => void;
};

function isFlatStone(id: StoneModelId) {
	return id.includes("Flat");
}

function pickStone(preferFlat = false): StoneModelId {
	if (preferFlat && Math.random() < 0.55) {
		return STONE_MODELS[9 + Math.floor(Math.random() * 3)];
	}
	return STONE_MODELS[Math.floor(Math.random() * STONE_MODELS.length)];
}

function scaleFor(id: StoneModelId) {
	if (isFlatStone(id)) return 1.8 + Math.random() * 1.1;
	return 1.5 + Math.random() * 1.0;
}

function loadStoneTemplate(
	loader: GLTFLoader,
	id: StoneModelId
): Promise<StoneTemplate[]> {
	return new Promise((resolve, reject) => {
		loader.load(
			`/stone/${id}.glb`,
			(gltf) => {
				const root = gltf.scene;
				const parts: StoneTemplate[] = [];
				root.updateMatrixWorld(true);
				root.traverse((child) => {
					if (!(child instanceof THREE.Mesh)) return;

					// Bake the GLB node transform into the geometry so every copy can
					// be drawn by one InstancedMesh for this stone family.
					const geometry = child.geometry.clone();
					geometry.applyMatrix4(child.matrixWorld);

					const material = Array.isArray(child.material)
						? child.material.map((entry) => entry.clone())
						: child.material.clone();
					const materials = Array.isArray(material) ? material : [material];
					for (const entry of materials) entry.side = THREE.FrontSide;

					parts.push({ geometry, material });
				});
				resolve(parts);
			},
			undefined,
			reject
		);
	});
}

/**
 * Densely packs small light-gray stones around the full pond shoreline.
 */
export async function createPondStones(
	options: PondStoneRingOptions
): Promise<PondStoneHandle> {
	const pondRadius = options.pondRadius ?? 10;
	const loader = new GLTFLoader(options.manager);
	const templates = new Map<StoneModelId, StoneTemplate[]>();

	await Promise.all(
		STONE_MODELS.map(async (id) => {
			templates.set(id, await loadStoneTemplate(loader, id));
		})
	);

	const group = new THREE.Group();
	group.name = "PondStones";

	const placements: Array<{
		id: StoneModelId;
		angle: number;
		radius: number;
		yOffset: number;
	}> = [];

	// Dense outer shore band — fills the rim all the way around
	const outerCount = 56;
	for (let i = 0; i < outerCount; i++) {
		const angle = (i / outerCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.12;
		const radius = pondRadius + 0.15 + Math.random() * 1.35;
		const id = pickStone(true);
		placements.push({
			id,
			angle,
			radius,
			yOffset: isFlatStone(id) ? -0.08 : -0.02,
		});
	}

	// Second staggered ring just outside the first
	const midCount = 48;
	for (let i = 0; i < midCount; i++) {
		const angle =
			(i / midCount) * Math.PI * 2 + Math.PI / midCount + (Math.random() - 0.5) * 0.14;
		const radius = pondRadius + 1.2 + Math.random() * 1.5;
		const id = pickStone(false);
		placements.push({
			id,
			angle,
			radius,
			yOffset: isFlatStone(id) ? -0.1 : -0.04,
		});
	}

	// Inner wet-edge pebbles tucked into the waterline
	const innerCount = 40;
	for (let i = 0; i < innerCount; i++) {
		const angle = (i / innerCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.1;
		const radius = pondRadius - 0.25 - Math.random() * 0.85;
		const id = pickStone(true);
		placements.push({
			id,
			angle,
			radius,
			yOffset: -0.28 - Math.random() * 0.12,
		});
	}

	// Extra filler clumps so the sides feel packed, not sparse
	const clumpCount = 28;
	for (let i = 0; i < clumpCount; i++) {
		const baseAngle = Math.random() * Math.PI * 2;
		const baseRadius = pondRadius + 0.4 + Math.random() * 1.8;
		const stonesInClump = 2 + Math.floor(Math.random() * 3);
		for (let j = 0; j < stonesInClump; j++) {
			const id = pickStone(j === 0);
			placements.push({
				id,
				angle: baseAngle + (Math.random() - 0.5) * 0.22,
				radius: baseRadius + (Math.random() - 0.5) * 0.55,
				yOffset: isFlatStone(id) ? -0.1 : -0.03,
			});
		}
	}

	const placementsByModel = new Map<StoneModelId, typeof placements>();
	for (const placement of placements) {
		const family = placementsByModel.get(placement.id);
		if (family) {
			family.push(placement);
		} else {
			placementsByModel.set(placement.id, [placement]);
		}
	}

	const dummy = new THREE.Object3D();
	for (const [id, familyPlacements] of placementsByModel) {
		const parts = templates.get(id);
		if (!parts) continue;

		for (let partIndex = 0; partIndex < parts.length; partIndex++) {
			const part = parts[partIndex];
			const stones = new THREE.InstancedMesh(
				part.geometry,
				part.material,
				familyPlacements.length
			);
			stones.name = `PondStones:${id}:${partIndex}`;
			stones.instanceMatrix.setUsage(THREE.StaticDrawUsage);
			stones.castShadow = true;
			stones.receiveShadow = true;

			for (let i = 0; i < familyPlacements.length; i++) {
				const placement = familyPlacements[i];
				const x =
					options.center.x + Math.cos(placement.angle) * placement.radius;
				const z =
					options.center.z + Math.sin(placement.angle) * placement.radius;
				const y = getWorldTerrainY(x, z) + placement.yOffset;

				dummy.position.set(x, y, z);
				dummy.rotation.set(
					isFlatStone(id) ? 0 : (Math.random() - 0.5) * 0.25,
					Math.random() * Math.PI * 2,
					isFlatStone(id) ? 0 : (Math.random() - 0.5) * 0.25
				);
				dummy.scale.setScalar(scaleFor(id));
				dummy.updateMatrix();
				stones.setMatrixAt(i, dummy.matrix);
			}

			stones.instanceMatrix.needsUpdate = true;
			stones.computeBoundingBox();
			stones.computeBoundingSphere();
			group.add(stones);
		}
	}

	return {
		group,
		dispose: () => {
			group.removeFromParent();
			group.traverse((object) => {
				if (!(object instanceof THREE.InstancedMesh)) return;
				object.dispose();
				object.geometry?.dispose();
				const material = object.material;
				if (Array.isArray(material)) {
					for (const entry of material) entry.dispose();
				} else {
					material?.dispose();
				}
			});
		},
	};
}
