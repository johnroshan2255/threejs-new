import * as THREE from "three";

const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _hitPoint = new THREE.Vector3();
const _worldNormal = new THREE.Vector3();

let terrainMeshes: THREE.Object3D[] = [];
let terrainBounds: THREE.Box3 | null = null;
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
	terrainBounds = box.clone();
	fallbackY = box.max.y;
	// Always start the probe above the tallest peak. A fixed ceiling can sit
	// *inside* a sculpted hill, and since terrain is DoubleSide the downward ray
	// then hits the far underside and reports a height below the real surface.
	rayStartY = box.max.y + 50;
	rayFar = box.max.y - box.min.y + 100;
}

export function clearIslandTerrain() {
	terrainMeshes = [];
	terrainBounds = null;
}

/** True when a downward ray hits the active terrain mesh at (x, z). */
export function hasTerrainAt(x: number, z: number): boolean {
	if (terrainMeshes.length === 0) return false;
	if (terrainBounds) {
		const pad = 2;
		if (
			x < terrainBounds.min.x - pad ||
			x > terrainBounds.max.x + pad ||
			z < terrainBounds.min.z - pad ||
			z > terrainBounds.max.z + pad
		) {
			return false;
		}
	}

	_origin.set(x, rayStartY, z);
	_raycaster.set(_origin, _down);
	_raycaster.far = rayFar;
	return _raycaster.intersectObjects(terrainMeshes, true).length > 0;
}

/**
 * Outside driveable ground: no terrain underfoot, or fallen / flown far from surface.
 */
export function isOutsideTerrain(
	x: number,
	y: number,
	z: number,
	options?: { belowSlack?: number; aboveSlack?: number }
): boolean {
	if (y < -120 || y > 90) return true;
	if (terrainMeshes.length === 0) return true;
	if (terrainBounds) {
		const pad = 2;
		if (
			x < terrainBounds.min.x - pad ||
			x > terrainBounds.max.x + pad ||
			z < terrainBounds.min.z - pad ||
			z > terrainBounds.max.z + pad
		) {
			return true;
		}
	}

	_origin.set(x, rayStartY, z);
	_raycaster.set(_origin, _down);
	_raycaster.far = rayFar;
	const hits = _raycaster.intersectObjects(terrainMeshes, true);
	if (hits.length === 0) return true;

	const groundY = hits[0].point.y;
	const below = options?.belowSlack ?? 25;
	const above = options?.aboveSlack ?? 45;
	return y < groundY - below || y > groundY + above;
}

/**
 * Find a spawn point on real terrain near a preferred XZ (spirals outward).
 */
export function findSafeTerrainSpawn(
	preferX = 0,
	preferZ = 0,
	clearance = 2.5
): THREE.Vector3 {
	const tryAt = (x: number, z: number): THREE.Vector3 | null => {
		if (!hasTerrainAt(x, z)) return null;
		return new THREE.Vector3(x, getWorldTerrainY(x, z) + clearance, z);
	};

	const direct = tryAt(preferX, preferZ);
	if (direct) return direct;

	const step = 6;
	const maxR = 160;
	for (let r = step; r <= maxR; r += step) {
		const samples = Math.max(8, Math.floor((r / step) * 6));
		for (let i = 0; i < samples; i++) {
			const a = (i / samples) * Math.PI * 2;
			const hit = tryAt(preferX + Math.cos(a) * r, preferZ + Math.sin(a) * r);
			if (hit) return hit;
		}
	}

	// Last resorts: origin, then terrain AABB center
	const origin = tryAt(0, 0);
	if (origin) return origin;
	if (terrainBounds) {
		const cx = (terrainBounds.min.x + terrainBounds.max.x) * 0.5;
		const cz = (terrainBounds.min.z + terrainBounds.max.z) * 0.5;
		const mid = tryAt(cx, cz);
		if (mid) return mid;
	}
	return new THREE.Vector3(preferX, fallbackY + clearance, preferZ);
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
