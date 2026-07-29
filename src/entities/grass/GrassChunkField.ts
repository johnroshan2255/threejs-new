import * as THREE from "three";

const CHUNK_SIZE = 20;
/** Extra radius so wind-displaced blades near chunk edges don't pop. */
const BOUND_PADDING = 4;

/** Full blade density inside this horizontal distance from the camera. */
const FADE_START = 48;
/** Soft density reaches 0 by this distance (aligned near island fog ~65). */
const FADE_END = 68;
/** Stay fully hidden until closer than this (hysteresis vs FADE_END). */
const SHOW_DISTANCE = 62;
/** Hard-hide once past this (slightly beyond fade end). */
const HIDE_DISTANCE = 72;

export type GrassChunkFieldOptions = {
	matrices: THREE.Matrix4[];
	geometry: THREE.BufferGeometry;
	material: THREE.Material;
	origin?: THREE.Vector3;
	chunkSize?: number;
	density?: number;
};

/**
 * Same fluffy grass mesh, split into spatial InstancedMesh chunks so Three.js
 * frustum culling can skip off-screen tiles. Distance culling softly thins
 * then hides far chunks with hysteresis to reduce pop-in.
 */
export class GrassChunkField {
	readonly group = new THREE.Group();
	private readonly meshes: THREE.InstancedMesh[] = [];
	private readonly chunkCenters: THREE.Vector3[] = [];
	private readonly distanceScale: number[] = [];
	private readonly hidden: boolean[] = [];
	private density: number;
	private readonly _worldCenter = new THREE.Vector3();

	constructor(options: GrassChunkFieldOptions) {
		const chunkSize = options.chunkSize ?? CHUNK_SIZE;
		this.density = THREE.MathUtils.clamp(options.density ?? 100, 0, 100);
		this.group.name = "Grass";
		this.group.position.copy(options.origin ?? new THREE.Vector3());

		const buckets = new Map<string, THREE.Matrix4[]>();
		const matrixPosition = new THREE.Vector3();

		for (const matrix of options.matrices) {
			matrixPosition.setFromMatrixPosition(matrix);
			const chunkX = Math.floor(matrixPosition.x / chunkSize);
			const chunkZ = Math.floor(matrixPosition.z / chunkSize);
			const key = `${chunkX}:${chunkZ}`;
			const bucket = buckets.get(key);
			if (bucket) bucket.push(matrix);
			else buckets.set(key, [matrix]);
		}

		for (const matrices of buckets.values()) {
			const mesh = new THREE.InstancedMesh(
				options.geometry,
				options.material,
				matrices.length
			);
			mesh.name = "GrassChunk";
			mesh.receiveShadow = true;
			mesh.frustumCulled = true;
			mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
			mesh.layers.set(0);

			const center = new THREE.Vector3();
			for (let i = 0; i < matrices.length; i++) {
				mesh.setMatrixAt(i, matrices[i]);
				matrixPosition.setFromMatrixPosition(matrices[i]);
				center.add(matrixPosition);
			}
			center.multiplyScalar(1 / matrices.length);

			mesh.instanceMatrix.needsUpdate = true;
			mesh.userData.maxGrassCount = matrices.length;
			mesh.count = Math.floor(matrices.length * (this.density / 100));

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
		}
	}

	setDensity(percent: number) {
		this.density = THREE.MathUtils.clamp(percent, 0, 100);
		this.applyCounts();
	}

	/**
	 * Softly thin then hide chunks by horizontal distance from the camera.
	 * Call from the render loop (can be throttled).
	 */
	updateDistanceCulling(cameraPosition: THREE.Vector3) {
		const originX = this.group.position.x;
		const originZ = this.group.position.z;
		const fadeRange = Math.max(0.001, FADE_END - FADE_START);

		for (let i = 0; i < this.meshes.length; i++) {
			const local = this.chunkCenters[i];
			this._worldCenter.set(local.x + originX, 0, local.z + originZ);
			const dx = cameraPosition.x - this._worldCenter.x;
			const dz = cameraPosition.z - this._worldCenter.z;
			const dist = Math.sqrt(dx * dx + dz * dz);

			if (this.hidden[i]) {
				if (dist <= SHOW_DISTANCE) this.hidden[i] = false;
			} else if (dist >= HIDE_DISTANCE) {
				this.hidden[i] = true;
			}

			let scale = 1;
			if (dist >= FADE_END) scale = 0;
			else if (dist > FADE_START) {
				const t = (dist - FADE_START) / fadeRange;
				// Smoothstep for softer thin-out
				scale = 1 - t * t * (3 - 2 * t);
			}

			if (this.hidden[i]) scale = 0;
			this.distanceScale[i] = scale;
		}

		this.applyCounts();
	}

	private applyCounts() {
		const densityFactor = this.density / 100;
		for (let i = 0; i < this.meshes.length; i++) {
			const mesh = this.meshes[i];
			const maximum = mesh.userData.maxGrassCount as number;
			const scale = this.distanceScale[i];
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
		this.group.clear();
	}
}
