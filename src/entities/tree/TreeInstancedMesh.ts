import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createFoliageMaterial, setFoliageInstanceSource, setFoliageLeafColor, type FoliageMaterial } from "./foliageMaterial";
import { applySnowToMaterial } from "../../terrain/snowShading";
import {
	Fn,
	If,
	atomicAdd,
	atomicStore,
	atomicLoad,
	float,
	instanceIndex,
	invocationLocalIndex,
	storage,
	uint,
	uniform,
	uniformArray,
	vec3,
	workgroupArray,
	workgroupBarrier,
	Loop,
	int,
} from "three/tsl";
import { StorageBufferAttribute, StorageInstancedBufferAttribute, IndirectStorageBufferAttribute } from "three/webgpu";

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
	
	private capacity = 2000;
	private count = 0;
	
	private idToIndex = new Map<string, number>();
	private indexToId = new Map<number, string>();
	
	private leafLayers: number;
	private initialized = false;

	// GPU Compute variables
	private masterTrunkData!: StorageBufferAttribute;
	private masterFoliageData!: StorageBufferAttribute;
	private masterFoliageColorData!: StorageBufferAttribute;
	private masterTrunkArray!: Float32Array;
	private masterFoliageArray!: Float32Array;
	private masterFoliageColorArray!: Float32Array;
	
	private trunkIndirectBuffer!: IndirectStorageBufferAttribute;
	private foliageIndirectBuffer!: IndirectStorageBufferAttribute;
	private resetComputeNode?: any;
	private cullingComputeNode?: any;
	private frustumPlanesUniform?: any;
	private cullPositionUniform?: any;
	private countUniform?: any;
	private frustum = new THREE.Frustum();
	private projScreenMatrix = new THREE.Matrix4();
	
	public cullDistance = 400; // Trees draw very far

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
		applySnowToMaterial(trunkMaterial);

		const foliageCapacity = this.capacity * this.leafLayers;
		
		// 1. Setup Master Arrays
		this.masterTrunkArray = new Float32Array(this.capacity * 16);
		this.masterFoliageArray = new Float32Array(foliageCapacity * 16);
		this.masterFoliageColorArray = new Float32Array(foliageCapacity * 3).fill(1);
		
		this.masterTrunkData = new StorageBufferAttribute(this.capacity, 16);
		this.masterFoliageData = new StorageBufferAttribute(foliageCapacity, 16);
		this.masterFoliageColorData = new StorageBufferAttribute(foliageCapacity, 3);
		
		this.masterTrunkData.array = this.masterTrunkArray;
		this.masterFoliageData.array = this.masterFoliageArray;
		this.masterFoliageColorData.array = this.masterFoliageColorArray;

		const masterTrunkNode = storage(this.masterTrunkData, 'mat4', this.capacity);
		const masterFoliageNode = storage(this.masterFoliageData, 'mat4', foliageCapacity);
		const masterFoliageColorNode = storage(this.masterFoliageColorData, 'vec3', foliageCapacity);

		// 2. Setup Culled Buffers
		const culledTrunkData = new StorageInstancedBufferAttribute(this.capacity, 16);
		const culledFoliageData = new StorageInstancedBufferAttribute(foliageCapacity, 16);
		const culledFoliageColorData = new StorageInstancedBufferAttribute(foliageCapacity, 3);
		
		const culledTrunkNode = storage(culledTrunkData, 'mat4', this.capacity);
		const culledFoliageNode = storage(culledFoliageData, 'mat4', foliageCapacity);
		const culledFoliageColorNode = storage(culledFoliageColorData, 'vec3', foliageCapacity);

		// 3. Setup Indirect Buffers
		const trunkIndexCount = template.trunk.geometry.index ? template.trunk.geometry.index.count : template.trunk.geometry.attributes.position.count;
		const foliageIndexCount = template.foliage.geometry.index ? template.foliage.geometry.index.count : template.foliage.geometry.attributes.position.count;
		
		this.trunkIndirectBuffer = new IndirectStorageBufferAttribute(new Uint32Array([trunkIndexCount, 0, 0, 0, 0]), 1);
		this.foliageIndirectBuffer = new IndirectStorageBufferAttribute(new Uint32Array([foliageIndexCount, 0, 0, 0, 0]), 1);
		
		const trunkIndirectNode = storage(this.trunkIndirectBuffer, 'uint', 5).toAtomic();
		const foliageIndirectNode = storage(this.foliageIndirectBuffer, 'uint', 5).toAtomic();

		// 4. Uniforms
		this.frustumPlanesUniform = uniformArray([
			new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(),
			new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()
		]);
		this.cullPositionUniform = uniform(new THREE.Vector3());
		this.countUniform = uniform(uint(0));

		// 5. Meshes
		this.trunkMesh = new THREE.InstancedMesh(template.trunk.geometry, trunkMaterial, this.capacity);
		this.trunkMesh.castShadow = true;
		this.trunkMesh.receiveShadow = true;
		this.trunkMesh.frustumCulled = false;
		this.trunkMesh.geometry.indirect = this.trunkIndirectBuffer;
		this.trunkMesh.instanceMatrix = culledTrunkData;

		this.foliageMaterial = createFoliageMaterial({
			leafColor: "#3f6d21",
			alphaMap: template.alphaMap,
			effectBlend: 1,
			inflate: 0,
			foliageScale: 1,
			windSpeed: 1,
		});

		this.foliageMesh = new THREE.InstancedMesh(template.foliage.geometry, this.foliageMaterial, foliageCapacity);
		this.foliageMesh.castShadow = true;
		this.foliageMesh.receiveShadow = true;
		this.foliageMesh.frustumCulled = false;
		this.foliageMesh.geometry.indirect = this.foliageIndirectBuffer;
		this.foliageMesh.instanceMatrix = culledFoliageData;
		this.foliageMesh.instanceColor = culledFoliageColorData as any;
		
		setFoliageInstanceSource(this.foliageMaterial, this.foliageMesh.instanceMatrix);

		this.group.add(this.trunkMesh);
		this.group.add(this.foliageMesh);
		
		this.trunkMesh.userData = { isTreeInstancedMesh: true, manager: this };
		this.foliageMesh.userData = { isTreeInstancedMesh: true, manager: this };

		// 6. Compute Shaders
		const resetFn = Fn(() => {
			atomicStore(trunkIndirectNode.element(1), uint(0));
			atomicStore(foliageIndirectNode.element(1), uint(0));
		});
		this.resetComputeNode = resetFn().compute(1);

		const leafLayersU = uint(this.leafLayers);
		const hideDistance = float(this.cullDistance);

		const cullingFn = Fn(() => {
			const sharedData = workgroupArray('atomic<u32>', 2);
			
			If(invocationLocalIndex.equal(0), () => {
				// @ts-ignore
				atomicStore(sharedData.element(uint(0)), uint(0));
				// @ts-ignore
				atomicStore(sharedData.element(uint(1)), uint(0));
			});
			workgroupBarrier();

			const index = instanceIndex;
			const isVisible = uint(0).toVar();
			const activeCount = this.countUniform;

			If(index.lessThan(activeCount), () => {
				const matrix = masterTrunkNode.element(index);
				const posX = matrix[3][0];
				const posY = matrix[3][1];
				const posZ = matrix[3][2];
				const pos = vec3(posX, posY, posZ);

				const worldPos = pos; // Trees don't offset their group right now

				const dx = this.cullPositionUniform.x.sub(worldPos.x);
				const dz = this.cullPositionUniform.z.sub(worldPos.z);
				const distSq = dx.mul(dx).add(dz.mul(dz));

				If(distSq.lessThan(hideDistance.mul(hideDistance)), () => {
					// Hardcoded radius for tree bounding sphere
					const radius = float(12.0); 
					
					const p0 = this.frustumPlanesUniform.element(0);
					const p1 = this.frustumPlanesUniform.element(1);
					const p2 = this.frustumPlanesUniform.element(2);
					const p3 = this.frustumPlanesUniform.element(3);
					const p4 = this.frustumPlanesUniform.element(4);
					const p5 = this.frustumPlanesUniform.element(5);
					
					const d0 = p0.x.mul(worldPos.x).add(p0.y.mul(worldPos.y)).add(p0.z.mul(worldPos.z)).add(p0.w);
					const d1 = p1.x.mul(worldPos.x).add(p1.y.mul(worldPos.y)).add(p1.z.mul(worldPos.z)).add(p1.w);
					const d2 = p2.x.mul(worldPos.x).add(p2.y.mul(worldPos.y)).add(p2.z.mul(worldPos.z)).add(p2.w);
					const d3 = p3.x.mul(worldPos.x).add(p3.y.mul(worldPos.y)).add(p3.z.mul(worldPos.z)).add(p3.w);
					const d4 = p4.x.mul(worldPos.x).add(p4.y.mul(worldPos.y)).add(p4.z.mul(worldPos.z)).add(p4.w);
					const d5 = p5.x.mul(worldPos.x).add(p5.y.mul(worldPos.y)).add(p5.z.mul(worldPos.z)).add(p5.w);
					
					const inFrustum = d0.greaterThanEqual(radius.negate())
						.and(d1.greaterThanEqual(radius.negate()))
						.and(d2.greaterThanEqual(radius.negate()))
						.and(d3.greaterThanEqual(radius.negate()))
						.and(d4.greaterThanEqual(radius.negate()))
						.and(d5.greaterThanEqual(radius.negate()));
						
					isVisible.assign(inFrustum);
				});
			});

			const localOffset = uint(0).toVar();
			
			If(isVisible, () => {
				// @ts-ignore
				localOffset.assign(atomicAdd(sharedData.element(uint(0)), uint(1)));
			});
			
			workgroupBarrier();
			
			If(invocationLocalIndex.equal(0), () => {
				// @ts-ignore
				const totalLocal = atomicLoad(sharedData.element(uint(0)));
				// @ts-ignore
				If(totalLocal.greaterThan(uint(0)), () => {
					// @ts-ignore
					atomicStore(sharedData.element(uint(1)), atomicAdd(trunkIndirectNode.element(1), totalLocal));
					// @ts-ignore
					atomicAdd(foliageIndirectNode.element(1), totalLocal.mul(leafLayersU));
				});
			});
			
			workgroupBarrier();
			
			If(isVisible, () => {
				// @ts-ignore
				const writeIndex = atomicLoad(sharedData.element(uint(1))).add(localOffset);
				culledTrunkNode.element(writeIndex).assign(masterTrunkNode.element(index));
				
				const foliageBaseWrite = writeIndex.mul(leafLayersU);
				const foliageBaseRead = index.mul(leafLayersU);
				
				Loop({ start: int(0), end: int(this.leafLayers), type: 'int', condition: '<' }, ({ i }) => {
					const r = foliageBaseRead.add(uint(i));
					const w = foliageBaseWrite.add(uint(i));
					culledFoliageNode.element(w).assign(masterFoliageNode.element(r));
					culledFoliageColorNode.element(w).assign(masterFoliageColorNode.element(r));
				});
			});
		});

		this.cullingComputeNode = cullingFn().compute(this.capacity);
		this.initialized = true;
	}

	private ensureInitialized() {
		if (!this.initialized) {
			throw new Error("TreeInstancedMesh not initialized. Call initialize() first.");
		}
	}

	addTree(id: string, position: THREE.Vector3, rotationY: number, scale: number, leafColorHex?: string) {
		this.ensureInitialized();
		if (this.idToIndex.has(id)) return;
		
		if (this.count >= this.capacity) {
			console.warn("TreeInstancedMesh reached capacity!");
			return;
		}

		const index = this.count++;
		this.idToIndex.set(id, index);
		this.indexToId.set(index, id);
		
		this.countUniform.value = this.count;
		
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
		matrix.toArray(this.masterTrunkArray, index * 16);
		this.masterTrunkData.needsUpdate = true;
		
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
			foliageMatrix.toArray(this.masterFoliageArray, foliageIndex * 16);
			
			if (leafColor) {
				this.masterFoliageColorArray[foliageIndex * 3 + 0] = leafColor.r;
				this.masterFoliageColorArray[foliageIndex * 3 + 1] = leafColor.g;
				this.masterFoliageColorArray[foliageIndex * 3 + 2] = leafColor.b;
			}
		}
		
		this.masterFoliageData.needsUpdate = true;
		this.masterFoliageColorData.needsUpdate = true;
	}

	removeTree(id: string) {
		this.ensureInitialized();
		const index = this.idToIndex.get(id);
		if (index === undefined) return;
		
		const lastIndex = this.count - 1;
		const lastId = this.indexToId.get(lastIndex)!;
		
		if (index !== lastIndex) {
			for (let i = 0; i < 16; i++) {
				this.masterTrunkArray[index * 16 + i] = this.masterTrunkArray[lastIndex * 16 + i];
			}
			
			for (let i = 0; i < this.leafLayers; i++) {
				const fromIndex = lastIndex * this.leafLayers + i;
				const toIndex = index * this.leafLayers + i;
				
				for (let j = 0; j < 16; j++) {
					this.masterFoliageArray[toIndex * 16 + j] = this.masterFoliageArray[fromIndex * 16 + j];
				}
				for (let j = 0; j < 3; j++) {
					this.masterFoliageColorArray[toIndex * 3 + j] = this.masterFoliageColorArray[fromIndex * 3 + j];
				}
			}
			
			this.idToIndex.set(lastId, index);
			this.indexToId.set(index, lastId);
		}
		
		this.idToIndex.delete(id);
		this.indexToId.delete(lastIndex);
		
		this.count--;
		this.countUniform.value = this.count;
		
		this.masterTrunkData.needsUpdate = true;
		this.masterFoliageData.needsUpdate = true;
		this.masterFoliageColorData.needsUpdate = true;
	}
	
	clear() {
		this.count = 0;
		if (this.countUniform) this.countUniform.value = 0;
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
			targetMatrix.fromArray(this.masterTrunkArray, index * 16);
		}
	}

	setHidden(id: string, hidden: boolean) {
		this.ensureInitialized();
		const index = this.idToIndex.get(id);
		if (index === undefined) return;

		if (hidden) {
			const matrix = new THREE.Matrix4();
			matrix.makeTranslation(0, -9999, 0);
			matrix.toArray(this.masterTrunkArray, index * 16);
			for (let i = 0; i < this.leafLayers; i++) {
				matrix.toArray(this.masterFoliageArray, (index * this.leafLayers + i) * 16);
			}
		} else {
			// If unhidden, we expect a transform update
		}
		
		this.masterTrunkData.needsUpdate = true;
		this.masterFoliageData.needsUpdate = true;
	}

	updateCompute(renderer: any, camera: THREE.Camera, cullPos: THREE.Vector3) {
		if (!this.initialized) return;

		this.cullPositionUniform.value.copy(cullPos);

		this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
		this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

		for (let i = 0; i < 6; i++) {
			const plane = this.frustum.planes[i];
			this.frustumPlanesUniform.array[i].set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
		}

		renderer.compute(this.resetComputeNode);
		renderer.compute(this.cullingComputeNode);
	}
}
