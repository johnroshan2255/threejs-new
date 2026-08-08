import * as THREE from "three";
import {
	Fn,
	If,
	atomicAdd,
	atomicStore,
	atomicLoad,
	float,
	fract,
	instanceIndex,
	invocationLocalIndex,
	max,
	sin,
	sqrt,
	storage,
	uint,
	uniform,
	uniformArray,
	vec3,
	workgroupArray,
	workgroupBarrier,
} from "three/tsl";
import { StorageBufferAttribute, StorageInstancedBufferAttribute, IndirectStorageBufferAttribute } from "three/webgpu";
import type { GrassChunkData } from "./grassPlacementCore";

const BOUND_PADDING = 4;
const DEFAULT_FADE_START = 48;
const DEFAULT_FADE_END = 68;
const DEFAULT_SHOW_DISTANCE = 62;
export const DEFAULT_GRASS_CULL_DISTANCE = 72;

export type GrassChunkFieldOptions = {
	matrices?: THREE.Matrix4[];
	chunks?: GrassChunkData[];
	geometry: THREE.BufferGeometry;
	material: THREE.Material;
	origin?: THREE.Vector3;
	chunkSize?: number;
	density?: number;
	cullDistance?: number;
};

export class GrassChunkField {
	readonly group = new THREE.Group();
	private density: number;
	private fadeStart = DEFAULT_FADE_START;
	private fadeEnd = DEFAULT_FADE_END;
	private showDistance = DEFAULT_SHOW_DISTANCE; // Kept for API compatibility though compute shader fades per frame smoothly
	private hideDistance = DEFAULT_GRASS_CULL_DISTANCE;

	private grassMesh?: THREE.InstancedMesh;
	private indirectBuffer?: IndirectStorageBufferAttribute;
	private cullingComputeNode?: any;
	private resetComputeNode?: any;
	private frustumPlanesUniform?: any;
	private cullPositionUniform: any;
	private densityUniform: any;

	private allMatrices?: Float32Array;
	private roadMasked?: boolean[];
	private instanceDataBuffer?: StorageBufferAttribute;

	private frustum = new THREE.Frustum();
	private projScreenMatrix = new THREE.Matrix4();

	private initialized = false;

	constructor(options: GrassChunkFieldOptions) {
		this.density = THREE.MathUtils.clamp(options.density ?? 100, 0, 100);
		this.group.name = "Grass";
		this.group.position.copy(options.origin ?? new THREE.Vector3());

		if (options.cullDistance != null) {
			this.setCullDistance(options.cullDistance);
		}

		let totalCount = 0;
		let boundingBox = new THREE.Box3();

		if (options.chunks) {
			totalCount = options.chunks.reduce((sum, chunk) => sum + chunk.count, 0);
			this.allMatrices = new Float32Array(totalCount * 16);
			let offset = 0;
			for (const chunk of options.chunks) {
				this.allMatrices.set(chunk.matrices, offset);
				offset += chunk.count * 16;

				boundingBox.expandByPoint(new THREE.Vector3(chunk.minX, chunk.minY, chunk.minZ));
				boundingBox.expandByPoint(new THREE.Vector3(chunk.maxX, chunk.maxY, chunk.maxZ));
			}
		} else if (options.matrices) {
			totalCount = options.matrices.length;
			this.allMatrices = new Float32Array(totalCount * 16);
			let offset = 0;
			const pos = new THREE.Vector3();
			for (const matrix of options.matrices) {
				matrix.toArray(this.allMatrices, offset);
				pos.setFromMatrixPosition(matrix);
				boundingBox.expandByPoint(pos);
				offset += 16;
			}
		} else {
			return;
		}

		if (totalCount === 0) return;
		this.roadMasked = new Array(totalCount).fill(false);

		if (!options.geometry.boundingSphere) options.geometry.computeBoundingSphere();
		const bladeReach = (options.geometry.boundingSphere?.radius ?? 1) * 1.2 + BOUND_PADDING;
		boundingBox.expandByScalar(bladeReach);

		// 1. Storage buffer for ALL raw instance matrices
		this.instanceDataBuffer = new StorageBufferAttribute(totalCount, 16);
		this.instanceDataBuffer.array.set(this.allMatrices);
		const instanceDataNode = storage(this.instanceDataBuffer, 'mat4', totalCount);

		// 2. Storage buffer for CULLED instance matrices
		const culledDataBuffer = new StorageInstancedBufferAttribute(totalCount, 16);
		const culledDataNode = storage(culledDataBuffer, 'mat4', totalCount);

		// 3. Indirect draw buffer: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
		const indexCount = options.geometry.index ? options.geometry.index.count : options.geometry.attributes.position.count;
		this.indirectBuffer = new IndirectStorageBufferAttribute(new Uint32Array([indexCount, 0, 0, 0, 0]), 1);
		const indirectNode = storage(this.indirectBuffer, 'uint', 5).toAtomic();

		// 4. Frustum planes uniform
		this.frustumPlanesUniform = uniformArray([
			new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(),
			new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()
		]);
		this.cullPositionUniform = uniform(new THREE.Vector3());
		this.densityUniform = uniform(float(this.density / 100.0));

		// 5. Mesh setup
		this.grassMesh = new THREE.InstancedMesh(options.geometry, options.material, totalCount);
		this.grassMesh.name = "GrassGPU";
		this.grassMesh.receiveShadow = true;
		this.grassMesh.frustumCulled = false; // We compute our own culling
		this.grassMesh.boundingBox = boundingBox;
		this.grassMesh.boundingSphere = new THREE.Sphere();
		boundingBox.getBoundingSphere(this.grassMesh.boundingSphere);
		this.grassMesh.geometry.indirect = this.indirectBuffer;
		this.grassMesh.instanceMatrix = culledDataBuffer;

		this.group.add(this.grassMesh);

		// 6. Compute Shaders

		// 6a. Reset node
		const resetFn = Fn(() => {
			atomicStore(indirectNode.element(1), uint(0));
		});
		this.resetComputeNode = resetFn().compute(1);

		// 6b. Culling node
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
			const matrix = instanceDataNode.element(index);

			const posX = matrix[3][0];
			const posY = matrix[3][1];
			const posZ = matrix[3][2];
			const pos = vec3(posX, posY, posZ);

			const origin = vec3(this.group.position);
			const worldPos = pos.add(origin);

			const dx = this.cullPositionUniform.x.sub(worldPos.x);
			const dz = this.cullPositionUniform.z.sub(worldPos.z);
			const distSq = dx.mul(dx).add(dz.mul(dz));

			const hideDist = float(this.hideDistance);

			// Compute visibility WITHOUT early-exiting so barriers stay uniform
			const isVisible = uint(0).toVar();
			
			If(distSq.lessThan(hideDist.mul(hideDist)), () => {
				const radius = float(bladeReach);
				
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
					
				If(inFrustum, () => {
					const hash = fract(sin(worldPos.x.mul(12.9898).add(worldPos.z.mul(78.233))).mul(43758.5453));
					isVisible.assign(hash.lessThan(this.densityUniform));
				});
			});
			
			// From here on, EVERY thread in the workgroup executes identically.
			// Only the isVisible-gated *work* differs, not control flow around barriers.
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
					atomicStore(sharedData.element(uint(1)), atomicAdd(indirectNode.element(1), totalLocal));
				});
			});
			
			workgroupBarrier();
			
			If(isVisible, () => {
				// @ts-ignore
				const writeIndex = atomicLoad(sharedData.element(uint(1))).add(localOffset);
				culledDataNode.element(writeIndex).assign(matrix);
			});
		});

		this.cullingComputeNode = cullingFn().compute(totalCount);
		this.initialized = true;
	}

	setDensity(percent: number) {
		this.density = THREE.MathUtils.clamp(percent, 0, 100);
		if (this.densityUniform) {
			this.densityUniform.value = this.density / 100.0;
		}
	}

	setCullDistance(meters: number) {
		const hide = THREE.MathUtils.clamp(meters, 30, 250);
		const scale = hide / DEFAULT_GRASS_CULL_DISTANCE;
		this.hideDistance = hide;
		this.fadeStart = DEFAULT_FADE_START * scale;
		this.fadeEnd = DEFAULT_FADE_END * scale;
		this.showDistance = DEFAULT_SHOW_DISTANCE * scale;
	}

	get cullDistance() {
		return this.hideDistance;
	}

	updateDistanceCulling(focusPosition: THREE.Vector3) {
		// Used to be called per frame, but distance culling is fully in the GPU now.
		// Retained for API compatibility.
	}

	updateCompute(renderer: any, camera: THREE.Camera, cullPos: THREE.Vector3) {
		if (!this.initialized) return;

		this.cullPositionUniform.value.copy(cullPos);

		// Extract frustum planes
		this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
		this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

		for (let i = 0; i < 6; i++) {
			const plane = this.frustum.planes[i];
			this.frustumPlanesUniform.array[i].set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
		}

		renderer.compute(this.resetComputeNode);
		renderer.compute(this.cullingComputeNode);
	}

	async maskRoadCircle(worldX: number, worldZ: number, radius: number) {
		await this.maskCircles([{ x: worldX, z: worldZ, radius }]);
	}

	async maskCircles(circles: { x: number; z: number; radius: number }[]) {
		if (!circles.length || !this.allMatrices || !this.roadMasked || !this.instanceDataBuffer) return;

		const originX = this.group.position.x;
		const originZ = this.group.position.z;
		
		const { grassMaskClient } = await import("../../workers/grassMaskClient");

		if (grassMaskClient.available) {
			try {
				const res = await grassMaskClient.run(
					{
						matrices: this.allMatrices,
						circles,
						originX,
						originZ,
					},
					[this.allMatrices.buffer]
				);
				this.allMatrices = res.matrices;
				this.instanceDataBuffer.array.set(this.allMatrices);
				this.instanceDataBuffer.needsUpdate = true;
				return;
			} catch (error) {
				console.warn("[GrassChunkField] mask worker failed, falling back to sync", error);
			}
		}

		// Fallback to sync masking if worker is not available or failed
		const cx = new Float64Array(circles.length);
		const cz = new Float64Array(circles.length);
		const cr2 = new Float64Array(circles.length);

		for (let n = 0; n < circles.length; n++) {
			const c = circles[n]!;
			cx[n] = c.x - originX;
			cz[n] = c.z - originZ;
			cr2[n] = c.radius * c.radius;
		}

		let changed = false;
		const totalCount = this.allMatrices.length / 16;

		for (let i = 0; i < totalCount; i++) {
			if (this.roadMasked[i]) continue;

			const offset = i * 16;
			const posX = this.allMatrices[offset + 12];
			const posZ = this.allMatrices[offset + 14];

			let inside = false;
			for (let n = 0; n < circles.length; n++) {
				const dx = posX - cx[n]!;
				const dz = posZ - cz[n]!;
				if (dx * dx + dz * dz <= cr2[n]!) {
					inside = true;
					break;
				}
			}

			if (!inside) continue;

			this.roadMasked[i] = true;
			// Sink into ground
			this.allMatrices[offset + 13] = -50;
			// Scale down
			this.allMatrices[offset + 0] *= 0.001;
			this.allMatrices[offset + 5] *= 0.001;
			this.allMatrices[offset + 10] *= 0.001;
			changed = true;
		}

		if (changed) {
			this.instanceDataBuffer.array.set(this.allMatrices);
			this.instanceDataBuffer.needsUpdate = true;
		}
	}

	dispose() {
		this.group.removeFromParent();
		this.grassMesh?.geometry.dispose();
		this.grassMesh?.dispose();
		this.indirectBuffer?.dispose();
		this.instanceDataBuffer?.dispose();
		this.group.clear();
		this.allMatrices = undefined;
		this.roadMasked = undefined;
	}
}
