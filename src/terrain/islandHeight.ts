import * as THREE from "three";

const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

let terrainMeshes: THREE.Object3D[] = [];
let fallbackY = 0;
let rayStartY = 200;
let rayFar = 400;

export function setIslandTerrain(mesh: THREE.Mesh) {
	terrainMeshes = [mesh];
	mesh.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(mesh);
	fallbackY = box.max.y;
	// Always start the probe above the tallest peak. A fixed ceiling can sit
	// *inside* a sculpted hill, and since terrain is DoubleSide the downward ray
	// then hits the far underside and reports a height below the real surface.
	rayStartY = box.max.y + 50;
	rayFar = box.max.y - box.min.y + 100;
}

export function getWorldTerrainY(x: number, z: number): number {
	if (terrainMeshes.length === 0) return fallbackY;

	_origin.set(x, rayStartY, z);
	_raycaster.set(_origin, _down);
	_raycaster.far = rayFar;

	const hits = _raycaster.intersectObjects(terrainMeshes, true);
	if (hits.length > 0) {
		// Highest surface first — the ray starts above every peak.
		return hits[0].point.y;
	}

	return fallbackY;
}
