import * as THREE from "three";

const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

let terrainMeshes: THREE.Object3D[] = [];
let fallbackY = 0;

export function setIslandTerrain(mesh: THREE.Mesh) {
	terrainMeshes = [mesh];
	mesh.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(mesh);
	fallbackY = box.max.y;
}

export function getWorldTerrainY(x: number, z: number): number {
	if (terrainMeshes.length === 0) return fallbackY;

	_origin.set(x, 200, z);
	_raycaster.set(_origin, _down);
	_raycaster.far = 400;

	const hits = _raycaster.intersectObjects(terrainMeshes, true);
	if (hits.length > 0) {
		return hits[0].point.y;
	}

	return fallbackY;
}
