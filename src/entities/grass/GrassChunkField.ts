import * as THREE from "three";
import type { GrassChunkData } from "./grassPlacementCore";

const CHUNK_SIZE = 15;
/** Extra radius so wind-displaced blades near chunk edges don't pop. */
const BOUND_PADDING = 4;

/** Full blade density inside this horizontal distance from the focus. */
const DEFAULT_FADE_START = 48;
/** Soft density reaches 0 by this distance (aligned near island fog ~65). */
const DEFAULT_FADE_END = 68;
/** Stay fully hidden until closer than this (hysteresis vs fade end). */
const DEFAULT_SHOW_DISTANCE = 62;
/** Hard-hide once past this (slightly beyond fade end). */
export const DEFAULT_GRASS_CULL_DISTANCE = 72;

export type GrassChunkFieldOptions = {
	/**
	 * Per-instance matrices. Prefer `chunks` — building Matrix4 objects for a
	 * million blades is exactly the main-thread cost the worker path removes.
	 * Kept for the MeshSurfaceSampler path on the built-in worlds.
	 */
	matrices?: THREE.Matrix4[];
	/** Pre-chunked flat matrix buffers from the placement worker. */
	chunks?: GrassChunkData[];
	geometry: THREE.BufferGeometry;
	material: THREE.Material;
	origin?: THREE.Vector3;
	chunkSize?: number;
	density?: number;
	/** Max horizontal distance before grass hides (default {@link DEFAULT_GRASS_CULL_DISTANCE}). */
	cullDistance?: number;
};

function shuffleInPlace<T>(arr: T[]) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const tmp = arr[i]!;
		arr[i] = arr[j]!;
		arr[j] = tmp;
	}
}

/**
 * Same fluffy grass mesh, split into spatial InstancedMesh chunks so Three.js
 * frustum culling can skip off-screen tiles. Distance culling softly thins
 * then hides far chunks with hysteresis — same gradual band as the island.
 */
export class GrassChunkField {
	readonly group = new THREE.Group();
	private readonly meshes: THREE.InstancedMesh[] = [];
	private readonly chunkCenters: THREE.Vector3[] = [];
	private readonly distanceScale: number[] = [];
	private readonly hidden: boolean[] = [];
	private density: number;
	private readonly chunkSize: number;
	private fadeStart = DEFAULT_FADE_START;
	private fadeEnd = DEFAULT_FADE_END;
	private showDistance = DEFAULT_SHOW_DISTANCE;
	private hideDistance = DEFAULT_GRASS_CULL_DISTANCE;
	private readonly _matrix = new THREE.Matrix4();
	private readonly _pos = new THREE.Vector3();
	private readonly _quat = new THREE.Quaternion();
	private readonly _scale = new THREE.Vector3();
	/** Per-mesh bitset of instances cleared by roads (same length as maxGrassCount). */
	private readonly roadMasked: boolean[][] = [];

	constructor(options: GrassChunkFieldOptions) {
		this.chunkSize = options.chunkSize ?? CHUNK_SIZE;
		this.density = THREE.MathUtils.clamp(options.density ?? 100, 0, 100);
		this.group.name = "Grass";
		this.group.position.copy(options.origin ?? new THREE.Vector3());
		if (options.cullDistance != null) {
			this.setCullDistance(options.cullDistance);
		}

		if (options.chunks) {
			this.buildFromChunks(options.chunks, options.geometry, options.material);
			return;
		}

		const buckets = new Map<string, THREE.Matrix4[]>();
		const matrixPosition = new THREE.Vector3();

		for (const matrix of options.matrices ?? []) {
			matrixPosition.setFromMatrixPosition(matrix);
			const chunkX = Math.floor(matrixPosition.x / this.chunkSize);
			const chunkZ = Math.floor(matrixPosition.z / this.chunkSize);
			const key = `${chunkX}:${chunkZ}`;
			const bucket = buckets.get(key);
			if (bucket) bucket.push(matrix);
			else buckets.set(key, [matrix]);
		}

		for (const bucket of buckets.values()) {
			// Shuffle so soft fade (mesh.count) thins randomly, not by grid side.
			shuffleInPlace(bucket);

			const mesh = new THREE.InstancedMesh(
				options.geometry,
				options.material,
				bucket.length
			);
			mesh.name = "GrassChunk";
			mesh.receiveShadow = true;
			mesh.frustumCulled = true;
			mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			mesh.layers.set(0);

			const center = new THREE.Vector3();
			const masked = new Array(bucket.length).fill(false);
			for (let i = 0; i < bucket.length; i++) {
				mesh.setMatrixAt(i, bucket[i]!);
				matrixPosition.setFromMatrixPosition(bucket[i]!);
				center.add(matrixPosition);
			}
			center.multiplyScalar(1 / bucket.length);

			mesh.instanceMatrix.needsUpdate = true;
			mesh.userData.maxGrassCount = bucket.length;
			mesh.count = Math.floor(bucket.length * (this.density / 100));

			mesh.computeBoundingBox();
			mesh.computeBoundingSphere();
			if (mesh.boundingSphere) {
				mesh.boundingSphere.radius += BOUND_PADDING;
			}
			if (mesh.boundingBox) {
				mesh.boundingBox.expandByScalar(BOUND_PADDING);
			}

			this.group.add(mesh);
			this.meshes.push(mesh);
			this.chunkCenters.push(center);
			this.distanceScale.push(1);
			this.hidden.push(false);
			this.roadMasked.push(masked);
		}
	}

	/**
	 * Adopt worker output with no per-instance JS work: each chunk's matrix buffer
	 * is blitted straight into instanceMatrix, and bounds come from the worker's
	 * position extents rather than InstancedMesh.computeBoundingBox (which would
	 * walk every instance again on the main thread).
	 */
	private buildFromChunks(
		chunks: GrassChunkData[],
		geometry: THREE.BufferGeometry,
		material: THREE.Material
	) {
		// Conservative padding: blade extent at its largest instance scale. Bounding
		// volumes only have to enclose, so overestimating costs nothing but culling.
		if (!geometry.boundingSphere) geometry.computeBoundingSphere();
		const bladeReach = (geometry.boundingSphere?.radius ?? 1) * 1.2 + BOUND_PADDING;

		for (const chunk of chunks) {
			if (chunk.count === 0) continue;
			const mesh = new THREE.InstancedMesh(geometry, material, chunk.count);
			mesh.name = "GrassChunk";
			mesh.receiveShadow = true;
			mesh.frustumCulled = true;
			mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			mesh.layers.set(0);

			(mesh.instanceMatrix.array as Float32Array).set(chunk.matrices);
			mesh.instanceMatrix.needsUpdate = true;

			mesh.userData.maxGrassCount = chunk.count;
			mesh.count = Math.floor(chunk.count * (this.density / 100));

			mesh.boundingBox = new THREE.Box3(
				new THREE.Vector3(chunk.minX, chunk.minY, chunk.minZ),
				new THREE.Vector3(chunk.maxX, chunk.maxY, chunk.maxZ)
			).expandByScalar(bladeReach);
			mesh.boundingSphere = new THREE.Sphere();
			mesh.boundingBox.getBoundingSphere(mesh.boundingSphere);

			this.group.add(mesh);
			this.meshes.push(mesh);
			this.chunkCenters.push(
				new THREE.Vector3(chunk.centerX, chunk.centerY, chunk.centerZ)
			);
			this.distanceScale.push(1);
			this.hidden.push(false);
			this.roadMasked.push(new Array(chunk.count).fill(false));
		}
	}

	setDensity(percent: number) {
		this.density = THREE.MathUtils.clamp(percent, 0, 100);
		this.applyCounts();
	}

	/**
	 * How far grass stays visible before hard hide (meters).
	 * Scales the island fade band (48→68→72) proportionally. Default 72.
	 */
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

	/**
	 * Softly thin then hide chunks by horizontal distance from the focus
	 * (player / car). Gradual fade then hard hide at {@link cullDistance}.
	 */
	updateDistanceCulling(focusPosition: THREE.Vector3) {
		const originX = this.group.position.x;
		const originZ = this.group.position.z;
		const fadeRange = Math.max(0.001, this.fadeEnd - this.fadeStart);

		for (let i = 0; i < this.meshes.length; i++) {
			const local = this.chunkCenters[i]!;
			const cx = local.x + originX;
			const cz = local.z + originZ;
			const dx = focusPosition.x - cx;
			const dz = focusPosition.z - cz;
			const dist = Math.sqrt(dx * dx + dz * dz);

			if (this.hidden[i]) {
				if (dist <= this.showDistance) this.hidden[i] = false;
			} else if (dist >= this.hideDistance) {
				this.hidden[i] = true;
			}

			let scale = 1;
			if (this.hidden[i] || dist >= this.fadeEnd) {
				scale = 0;
			} else if (dist > this.fadeStart) {
				const t = (dist - this.fadeStart) / fadeRange;
				// Full smoothstep 1 → 0 (island-style gradual fade).
				scale = 1 - t * t * (3 - 2 * t);
			}

			this.distanceScale[i] = scale;
		}

		this.applyCounts();
	}

	/**
	 * Clear fluffy grass in a circle (mud road). Buries instances under the terrain.
	 */
	maskRoadCircle(worldX: number, worldZ: number, radius: number) {
		const originX = this.group.position.x;
		const originZ = this.group.position.z;
		const localX = worldX - originX;
		const localZ = worldZ - originZ;
		const radiusSq = radius * radius;
		const pad = (this.chunkSize * 0.5 + radius) ** 2;

		for (let c = 0; c < this.meshes.length; c++) {
			const center = this.chunkCenters[c]!;
			const cdx = center.x - localX;
			const cdz = center.z - localZ;
			if (cdx * cdx + cdz * cdz > pad) continue;

			const mesh = this.meshes[c]!;
			const masked = this.roadMasked[c]!;
			const maximum = mesh.userData.maxGrassCount as number;
			let changed = false;

			for (let i = 0; i < maximum; i++) {
				if (masked[i]) continue;
				mesh.getMatrixAt(i, this._matrix);
				this._matrix.decompose(this._pos, this._quat, this._scale);
				const dx = this._pos.x - localX;
				const dz = this._pos.z - localZ;
				if (dx * dx + dz * dz > radiusSq) continue;

				masked[i] = true;
				this._pos.y = -50;
				this._scale.set(0.001, 0.001, 0.001);
				this._matrix.compose(this._pos, this._quat, this._scale);
				mesh.setMatrixAt(i, this._matrix);
				changed = true;
			}
			if (changed) mesh.instanceMatrix.needsUpdate = true;
		}
	}

	private applyCounts() {
		const densityFactor = this.density / 100;
		for (let i = 0; i < this.meshes.length; i++) {
			const mesh = this.meshes[i]!;
			const maximum = mesh.userData.maxGrassCount as number;
			const scale = this.distanceScale[i]!;
			const count = Math.floor(maximum * densityFactor * scale);
			mesh.count = count;
			mesh.visible = !this.hidden[i] && count > 0;
		}
	}

	dispose() {
		this.group.removeFromParent();
		for (const mesh of this.meshes) {
			mesh.dispose();
		}
		this.meshes.length = 0;
		this.chunkCenters.length = 0;
		this.distanceScale.length = 0;
		this.hidden.length = 0;
		this.roadMasked.length = 0;
		this.group.clear();
	}
}
