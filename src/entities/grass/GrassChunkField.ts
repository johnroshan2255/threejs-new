import * as THREE from "three";

const CHUNK_SIZE = 20;
/** Extra radius so wind-displaced blades near chunk edges don't pop. */
const BOUND_PADDING = 4;

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
 * frustum culling can skip off-screen tiles without changing appearance.
 */
export class GrassChunkField {
	readonly group = new THREE.Group();
	private readonly meshes: THREE.InstancedMesh[] = [];
	private density: number;

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

			for (let i = 0; i < matrices.length; i++) {
				mesh.setMatrixAt(i, matrices[i]);
			}
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
		}
	}

	setDensity(percent: number) {
		this.density = THREE.MathUtils.clamp(percent, 0, 100);
		for (const mesh of this.meshes) {
			const maximum = mesh.userData.maxGrassCount as number;
			mesh.count = Math.floor(maximum * (this.density / 100));
		}
	}

	dispose() {
		this.group.removeFromParent();
		for (const mesh of this.meshes) {
			mesh.dispose();
		}
		this.meshes.length = 0;
		this.group.clear();
	}
}
