import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createFoliageMaterial, setFoliageLeafColor, type FoliageMaterial } from "./foliageMaterial";
import { applySnowToMaterial } from "../../terrain/snowShading";

const TREE_URL = "/models/tree/tree.glb";
const FOLIAGE_ALPHA_URL = "/models/tree/foliage_alpha3.png";

export type TreeInstanceOptions = {
	position?: THREE.Vector3Tuple | THREE.Vector3;
	rotationY?: number;
	scale?: number;
	leafColor?: THREE.ColorRepresentation;
	trunkColor?: THREE.ColorRepresentation;
	leafLayers?: number;
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

			gltf.scene.updateMatrixWorld(true);
			gltf.scene.traverse((child) => {
				if (!(child instanceof THREE.Mesh)) return;
				
				// Bake node transform into geometry
				child.geometry.applyMatrix4(child.matrixWorld);
				child.position.set(0, 0, 0);
				child.quaternion.identity();
				child.scale.set(1, 1, 1);
				child.updateMatrixWorld(true);

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

export class TreeInstancedMesh {
	public group = new THREE.Group();
	private trunkMesh!: THREE.InstancedMesh;
	private foliageMesh!: THREE.InstancedMesh;
	private foliageMaterial!: FoliageMaterial;
	
	private capacity = 20000;
	private count = 0;
	
	// Map of entityId to index in the instance buffer
	private idToIndex = new Map<string, number>();
	private indexToId = new Map<number, string>();
	
	// Track layers to support multi-layer foliage for each instance
	private leafLayers: number;
	
	private initialized = false;

	constructor(private manager?: THREE.LoadingManager, leafLayers = 4) {
		this.leafLayers = leafLayers;
	}

	async initialize() {
		if (this.initialized) return;
		
		const template = await loadTreeTemplate(this.manager);
		
		const trunkMaterial = new THREE.MeshStandardMaterial({
			color: new THREE.Color("#3b2a1a"),
			roughness: 0.92,
			metalness: 0,
		});
		// Trunks are instanced; the patch reads instanceMatrix so each tree samples
		// the mask at its own position. Snow lands on upward-facing bark only, so
		// the trunk silhouette stays dark instead of turning into a white post.
		applySnowToMaterial(trunkMaterial);

		this.trunkMesh = new THREE.InstancedMesh(template.trunk.geometry, trunkMaterial, this.capacity);
		this.trunkMesh.castShadow = true;
		this.trunkMesh.receiveShadow = true;
		this.trunkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.trunkMesh.count = 0;

		this.foliageMaterial = createFoliageMaterial({
			leafColor: "#3f6d21",
			alphaMap: template.alphaMap,
			effectBlend: 1,
			inflate: 0,
			foliageScale: 1,
			windSpeed: 1,
		});

		// Foliage requires multiplying capacity by leafLayers
		const foliageCapacity = this.capacity * this.leafLayers;
		this.foliageMesh = new THREE.InstancedMesh(template.foliage.geometry, this.foliageMaterial, foliageCapacity);
		this.foliageMesh.castShadow = true;
		this.foliageMesh.receiveShadow = true;
		this.foliageMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		
		// Optional: We can tint individual leaves using instanceColor
		this.foliageMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(foliageCapacity * 3), 3);
		this.foliageMesh.count = 0;
		
		this.trunkMesh.frustumCulled = false;
		this.foliageMesh.frustumCulled = false;

		this.group.add(this.trunkMesh);
		this.group.add(this.foliageMesh);
		
		// To allow raycasting against trees to find their ID
		this.trunkMesh.userData = { isTreeInstancedMesh: true, manager: this };
		this.foliageMesh.userData = { isTreeInstancedMesh: true, manager: this };
		
		this.initialized = true;
	}

	private ensureInitialized() {
		if (!this.initialized) {
			throw new Error("TreeInstancedMesh not initialized. Call initialize() first.");
		}
	}

	addTree(id: string, position: THREE.Vector3, rotationY: number, scale: number, leafColorHex?: string) {
		this.ensureInitialized();
		if (this.idToIndex.has(id)) return; // Already added
		
		if (this.count >= this.capacity) {
			console.warn("TreeInstancedMesh reached capacity!");
			return;
		}

		const index = this.count++;
		this.idToIndex.set(id, index);
		this.indexToId.set(index, id);
		
		this.trunkMesh.count = this.count;
		this.foliageMesh.count = this.count * this.leafLayers;
		
		this.updateTreeTransform(id, position, rotationY, scale, leafColorHex);
	}

	updateTreeTransform(id: string, position: THREE.Vector3, rotationY: number, scale: number, leafColorHex?: string) {
		this.ensureInitialized();
		const index = this.idToIndex.get(id);
		if (index === undefined) return;

		const matrix = new THREE.Matrix4();
		const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
		const scaleVec = new THREE.Vector3(scale, scale, scale);
		
		matrix.compose(position, quaternion, scaleVec);
		this.trunkMesh.setMatrixAt(index, matrix);
		this.trunkMesh.instanceMatrix.needsUpdate = true;
		
		const baseFoliageIndex = index * this.leafLayers;
		const leafColor = leafColorHex ? new THREE.Color(leafColorHex).convertLinearToSRGB() : null;
		
		for (let i = 0; i < this.leafLayers; i++) {
			const foliageIndex = baseFoliageIndex + i;
			
			const foliageMatrix = new THREE.Matrix4();
			const fQuat = new THREE.Quaternion().setFromAxisAngle(
				new THREE.Vector3(0, 1, 0), 
				rotationY + (i / this.leafLayers) * Math.PI * 2
			);
			const fPos = position.clone();
			if (i > 0) {
				fPos.y += ((i % 2 === 0 ? 0.08 : -0.05) * i) * scale;
			}
			
			foliageMatrix.compose(fPos, fQuat, scaleVec);
			this.foliageMesh.setMatrixAt(foliageIndex, foliageMatrix);
			
			if (leafColor) {
				this.foliageMesh.setColorAt(foliageIndex, leafColor);
			}
		}
		
		this.foliageMesh.instanceMatrix.needsUpdate = true;
		if (leafColor && this.foliageMesh.instanceColor) {
			this.foliageMesh.instanceColor.needsUpdate = true;
		}
		
		// Update bounding sphere so frustum culling works correctly
		this.trunkMesh.computeBoundingSphere();
		this.foliageMesh.computeBoundingSphere();
	}

	removeTree(id: string) {
		this.ensureInitialized();
		const index = this.idToIndex.get(id);
		if (index === undefined) return;
		
		// Swap with last instance to keep array contiguous
		const lastIndex = this.count - 1;
		const lastId = this.indexToId.get(lastIndex)!;
		
		if (index !== lastIndex) {
			// Move trunk
			const tempMatrix = new THREE.Matrix4();
			this.trunkMesh.getMatrixAt(lastIndex, tempMatrix);
			this.trunkMesh.setMatrixAt(index, tempMatrix);
			
			// Move foliage
			const tempColor = new THREE.Color();
			for (let i = 0; i < this.leafLayers; i++) {
				const fromIndex = lastIndex * this.leafLayers + i;
				const toIndex = index * this.leafLayers + i;
				
				this.foliageMesh.getMatrixAt(fromIndex, tempMatrix);
				this.foliageMesh.setMatrixAt(toIndex, tempMatrix);
				
				if (this.foliageMesh.instanceColor) {
					this.foliageMesh.getColorAt(fromIndex, tempColor);
					this.foliageMesh.setColorAt(toIndex, tempColor);
				}
			}
			
			// Update mappings
			this.idToIndex.set(lastId, index);
			this.indexToId.set(index, lastId);
		}
		
		this.idToIndex.delete(id);
		this.indexToId.delete(lastIndex);
		
		this.count--;
		this.trunkMesh.count = this.count;
		this.foliageMesh.count = this.count * this.leafLayers;
		
		this.trunkMesh.instanceMatrix.needsUpdate = true;
		this.foliageMesh.instanceMatrix.needsUpdate = true;
		if (this.foliageMesh.instanceColor) {
			this.foliageMesh.instanceColor.needsUpdate = true;
		}
	}
	
	clear() {
		this.count = 0;
		if (this.trunkMesh) this.trunkMesh.count = 0;
		if (this.foliageMesh) this.foliageMesh.count = 0;
		this.idToIndex.clear();
		this.indexToId.clear();
	}

	getIdFromInstanceId(instanceId: number, mesh: THREE.Object3D): string | null {
		let index = instanceId;
		if (mesh === this.foliageMesh) {
			index = Math.floor(instanceId / this.leafLayers);
		}
		return this.indexToId.get(index) ?? null;
	}

	getMatrixAt(id: string, targetMatrix: THREE.Matrix4) {
		this.ensureInitialized();
		const index = this.idToIndex.get(id);
		if (index !== undefined) {
			this.trunkMesh.getMatrixAt(index, targetMatrix);
		}
	}

	setHidden(id: string, hidden: boolean) {
		this.ensureInitialized();
		const index = this.idToIndex.get(id);
		if (index === undefined) return;

		// Move the tree far away when hidden
		if (hidden) {
			const matrix = new THREE.Matrix4();
			matrix.makeTranslation(0, -9999, 0);
			this.trunkMesh.setMatrixAt(index, matrix);
			for (let i = 0; i < this.leafLayers; i++) {
				this.foliageMesh.setMatrixAt(index * this.leafLayers + i, matrix);
			}
		} else {
			// Restore position. Wait, we don't store original positions!
			// We can expect the caller to call updateTreeTransform to unhide it.
		}
		this.trunkMesh.instanceMatrix.needsUpdate = true;
		this.foliageMesh.instanceMatrix.needsUpdate = true;
	}
}
