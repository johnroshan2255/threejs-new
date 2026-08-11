import * as THREE from "three";
import { getCaveMeshes, getCaveVersion, isInsideCave } from "./caveRegistry";

const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _hitPoint = new THREE.Vector3();
const _worldNormal = new THREE.Vector3();

let baseTerrainMesh: THREE.Mesh | null = null;
let composedMeshes: THREE.Object3D[] = [];
let composedCaveVersion = -1;
let terrainBounds: THREE.Box3 | null = null;
let fallbackY = 0;
let rayStartY = 200;
let rayFar = 400;

export type TerrainRayHit = {
	point: THREE.Vector3;
	distance: number;
	normal: THREE.Vector3;
};

/**
 * Terrain plus every cave shell. Cave interiors are real surfaces you stand on,
 * so they have to be part of every ground query, not a separate system.
 * Rebuilt only when the cave set actually changes — these run per frame.
 */
function terrainMeshes(): THREE.Object3D[] {
	const version = getCaveVersion();
	if (composedCaveVersion !== version) {
		composedMeshes = baseTerrainMesh
			? [baseTerrainMesh, ...getCaveMeshes()]
			: getCaveMeshes();
		composedCaveVersion = version;
	}
	return composedMeshes;
}

export function setIslandTerrain(mesh: THREE.Mesh) {
	baseTerrainMesh = mesh;
	composedCaveVersion = -1;
	mesh.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(mesh);
	terrainBounds = box.clone();
	fallbackY = box.max.y;
	// Always start the probe above the tallest peak. A fixed ceiling can sit
	// *inside* a sculpted hill, and since terrain is DoubleSide the downward ray
	// then hits the far underside and reports a height below the real surface.
	rayStartY = box.max.y + 50;
	// Generous far plane: caves sink well below the terrain's own AABB.
	rayFar = box.max.y - box.min.y + 300;
}

export function clearIslandTerrain() {
	baseTerrainMesh = null;
	composedCaveVersion = -1;
	composedMeshes = [];
	terrainBounds = null;
}

/** True when a downward ray hits the active terrain mesh at (x, z). */
export function hasTerrainAt(x: number, z: number): boolean {
	const meshes = terrainMeshes();
	if (meshes.length === 0) return false;
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
	return _raycaster.intersectObjects(meshes, true).length > 0;
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
	const meshes = terrainMeshes();
	if (meshes.length === 0) return true;
	// Being under the surface is the whole point of a cave. Without this the
	// below-ground slack below flags anyone in a tunnel as fallen out of the
	// world and resetCar teleports them back to the surface.
	if (isInsideCave(x, y, z, 1.6)) return false;
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
	const hits = _raycaster.intersectObjects(meshes, true);
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

/**
 * Ceiling for a downward probe, against the terrain *as it stands now*.
 *
 * `rayStartY` is captured when a world registers, but sculpting keeps raising the
 * surface afterwards. A probe that starts inside a hill reads the far underside
 * (terrain is DoubleSide) or misses outright, so the live geometry bounds get a
 * vote too.
 */
function probeStartY(): number {
	const box = baseTerrainMesh?.geometry?.boundingBox;
	if (!box) return rayStartY;
	return Math.max(rayStartY, box.max.y + (baseTerrainMesh?.position.y ?? 0) + 50);
}

/**
 * Rings sampled when a vertical probe finds nothing, nearest first.
 *
 * A miss inside the map means a hole in the terrain — a cave mouth, nearly
 * always, since carving one deletes the triangles over it. The rim a few metres
 * out is the honest answer for "ground height here"; see `getWorldTerrainY`.
 */
const HOLE_PROBE_RINGS = [4, 10, 20];
const HOLE_PROBE_ANGLES = 6;

/**
 * Height of the ground at (x, z).
 *
 * By default the probe starts above every peak, so it reports the outdoor
 * surface — correct for grass, props and spawning. Pass `fromY` to get the
 * surface directly *beneath* a known position instead; inside a cave the
 * topmost hit is the hillside overhead, not the floor you are standing on.
 *
 * A vertical miss used to return `fallbackY` — the top of the world. Callers
 * read this as a ground height and drop props onto it, so a prop over a cave
 * mouth was launched tens of metres into the sky and hung there. Sampling the
 * hole's rim instead keeps it on the ground it was meant to sit on.
 */
/**
 * Where a prop with no saved Y belongs at (x, z).
 *
 * Preference order, and each step exists because of a way props ended up in the
 * sky:
 *  1. The outdoor terrain directly underneath. `getWorldTerrainY` composes terrain
 *     with every cave shell and returns the *topmost* hit, so a shell that rises
 *     above the ground it was dug from became "the surface" and seated nearby
 *     trees and stones on its roof, metres up.
 *  2. Failing that the terrain has a hole here — a cave mouth was carved under the
 *     prop after it was planted — so rest on whatever surface really is there,
 *     which is the shell spanning the hole.
 *  3. Only if nothing at all answers, the rim of the hole, then the fallback.
 */
export function getPropSeatY(x: number, z: number): number {
	const terrainOnly = baseTerrainMesh ? probeExact([baseTerrainMesh], x, z) : null;
	if (terrainOnly != null) return terrainOnly;
	const anySurface = probeExact(terrainMeshes(), x, z);
	if (anySurface != null) return anySurface;
	return baseTerrainMesh ? probeSurface([baseTerrainMesh], x, z) : fallbackY;
}

/** Straight vertical probe, no fallbacks: null when nothing is under (x, z). */
function probeExact(meshes: THREE.Object3D[], x: number, z: number): number | null {
	if (!meshes.length) return null;
	const startY = probeStartY();
	_origin.set(x, startY, z);
	_raycaster.set(_origin, _down);
	_raycaster.far = rayFar + Math.max(0, startY - rayStartY);
	const hits = _raycaster.intersectObjects(meshes, true);
	return hits.length > 0 ? hits[0]!.point.y : null;
}

/** Shared vertical probe: live ceiling, then hole-rim rings, then the fallback. */
function probeSurface(meshes: THREE.Object3D[], x: number, z: number): number {
	const startY = probeStartY();
	const far = rayFar + Math.max(0, startY - rayStartY);
	_origin.set(x, startY, z);
	_raycaster.set(_origin, _down);
	_raycaster.far = far;
	const hits = _raycaster.intersectObjects(meshes, true);
	if (hits.length > 0) return hits[0]!.point.y;

	if (terrainBounds) {
		const pad = 2;
		if (
			x < terrainBounds.min.x - pad ||
			x > terrainBounds.max.x + pad ||
			z < terrainBounds.min.z - pad ||
			z > terrainBounds.max.z + pad
		) {
			return fallbackY;
		}
	}

	// Lowest hit on the nearest ring that answers, not the first. A single sample
	// can land on a steep hillside or an overhang and report a height far above the
	// hole — which put a prop 59 m up. Biasing low means the worst case is a prop
	// sunk slightly into a slope instead of one hanging in the sky.
	for (const radius of HOLE_PROBE_RINGS) {
		let lowest = Infinity;
		for (let i = 0; i < HOLE_PROBE_ANGLES; i++) {
			const angle = (i / HOLE_PROBE_ANGLES) * Math.PI * 2;
			_origin.set(x + Math.cos(angle) * radius, startY, z + Math.sin(angle) * radius);
			_raycaster.set(_origin, _down);
			_raycaster.far = far;
			const ringHits = _raycaster.intersectObjects(meshes, true);
			if (ringHits.length > 0 && ringHits[0]!.point.y < lowest) {
				lowest = ringHits[0]!.point.y;
			}
		}
		if (Number.isFinite(lowest)) return lowest;
	}
	return fallbackY;
}

export function getWorldTerrainY(x: number, z: number, fromY?: number): number {
	const meshes = terrainMeshes();
	if (meshes.length === 0) return fallbackY;

	if (fromY == null) return probeSurface(meshes, x, z);

	const startY = fromY + 0.5;
	const far = rayFar + 50;
	_origin.set(x, startY, z);
	_raycaster.set(_origin, _down);
	_raycaster.far = far;

	const hits = _raycaster.intersectObjects(meshes, true);
	// Probing from a known position: the nearest floor below the caller. A rim
	// metres away is not their floor, so there is no ring fallback here.
	if (hits.length > 0) return hits[0]!.point.y;
	return -1000;
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
	const meshes = terrainMeshes();
	if (meshes.length === 0) return null;
	if (direction.lengthSq() < 1e-12) return null;

	_raycaster.set(origin, direction);
	_raycaster.near = 0;
	_raycaster.far = maxDistance;

	const hits = _raycaster.intersectObjects(meshes, true);
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
