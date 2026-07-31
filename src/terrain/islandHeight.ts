import * as THREE from "three";

const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _hitPoint = new THREE.Vector3();
const _worldNormal = new THREE.Vector3();

let terrainMeshes: THREE.Object3D[] = [];
let fallbackY = 0;
let rayStartY = 200;
let rayFar = 400;

export type TerrainRayHit = {
	point: THREE.Vector3;
	distance: number;
	normal: THREE.Vector3;
};

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

export function clearIslandTerrain() {
	terrainMeshes = [];
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

/**
 * Forward ray against the active world's terrain mesh (island / valley / custom).
 * Skips underside / back-face hits from DoubleSide terrain.
 */
export function raycastTerrain(
	origin: THREE.Vector3,
	direction: THREE.Vector3,
	maxDistance: number
): THREE.Vector3 | null {
	const hit = raycastTerrainHit(origin, direction, maxDistance);
	return hit ? hit.point : null;
}

export function raycastTerrainHit(
	origin: THREE.Vector3,
	direction: THREE.Vector3,
	maxDistance: number
): TerrainRayHit | null {
	if (terrainMeshes.length === 0) return null;
	if (direction.lengthSq() < 1e-12) return null;

	_raycaster.set(origin, direction);
	_raycaster.near = 0;
	_raycaster.far = maxDistance;

	const hits = _raycaster.intersectObjects(terrainMeshes, true);
	for (const hit of hits) {
		if (hit.distance < 0.35) continue;
		if (hit.distance > maxDistance) continue;

		if (hit.face) {
			_worldNormal
				.copy(hit.face.normal)
				.transformDirection(hit.object.matrixWorld)
				.normalize();
			// Back-face / underside: normal faces roughly along the ray.
			if (_worldNormal.dot(direction) > 0.15) continue;
		}

		return {
			point: _hitPoint.copy(hit.point),
			distance: hit.distance,
			normal: _worldNormal.clone(),
		};
	}
	return null;
}
