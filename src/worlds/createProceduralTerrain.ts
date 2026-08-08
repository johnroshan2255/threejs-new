import * as THREE from "three";
import type { WorldDefinition } from "./worldTypes";
import { applySnowToMaterial } from "../terrain/snowShading";

import { buildTerrainGeneration } from "./terrainGenerationCore";

export type ProceduralTerrainResult = {
	mesh: THREE.Mesh;
	heights: Float32Array;
	nrows: number;
	ncols: number;
	size: number;
};

/**
 * Rolling-hills terrain like the island, parameterized for any size (incl. 1km).
 */
export function createProceduralTerrain(
	material: THREE.Material,
	definition: WorldDefinition
): ProceduralTerrainResult {
	// See createLargeTerrain: snow is patched onto whatever material builds
	// terrain, so a new caller can't silently ship green ground under snow.
	applySnowToMaterial(material);

	const { size, segments } = definition;
	const seed = definition.seed ?? 42;

	const { positions, normals, heights, nrows, ncols } = buildTerrainGeneration({
		size,
		segments,
		seed
	});

	const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
	geometry.rotateX(-Math.PI / 2);

	geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
	geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));

	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	geometry.computeBoundsTree();

	const mesh = new THREE.Mesh(geometry, material);
	mesh.name = `terrain-${definition.id}`;
	mesh.receiveShadow = true;
	mesh.castShadow = false;

	return { mesh, heights, nrows, ncols, size };
}

/** Paint light-blue water tint onto terrain vertex colors. */
export function paintTerrainWater(
	mesh: THREE.Mesh,
	worldX: number,
	worldZ: number,
	radius: number
) {
	const geometry = mesh.geometry as THREE.BufferGeometry;
	const positions = geometry.attributes.position as THREE.BufferAttribute;
	const grass = new THREE.Color("#3f6d21");
	const water = new THREE.Color("#7eb8e8");

	if (!geometry.attributes.color) {
		const arr = new Float32Array(positions.count * 3);
		for (let i = 0; i < positions.count; i++) {
			arr[i * 3] = grass.r;
			arr[i * 3 + 1] = grass.g;
			arr[i * 3 + 2] = grass.b;
		}
		geometry.setAttribute("color", new THREE.BufferAttribute(arr, 3));
	}
	const colors = geometry.attributes.color as THREE.BufferAttribute;
	const radiusSq = radius * radius;
	const inv = 1 / Math.max(radius, 0.0001);
	const origin = mesh.position;

	for (let i = 0; i < positions.count; i++) {
		const x = positions.getX(i) + origin.x;
		const z = positions.getZ(i) + origin.z;
		const dx = x - worldX;
		const dz = z - worldZ;
		const d2 = dx * dx + dz * dz;
		if (d2 > radiusSq) continue;
		const t = 1 - Math.sqrt(d2) * inv;
		const w = t * t * (3 - 2 * t);
		colors.setXYZ(
			i,
			THREE.MathUtils.lerp(colors.getX(i), water.r, w),
			THREE.MathUtils.lerp(colors.getY(i), water.g, w),
			THREE.MathUtils.lerp(colors.getZ(i), water.b, w)
		);
	}
	colors.needsUpdate = true;
}

/** Paint muddy road tint onto terrain vertex colors. */
export function paintTerrainMud(
	mesh: THREE.Mesh,
	worldX: number,
	worldZ: number,
	radius: number
) {
	const geometry = mesh.geometry as THREE.BufferGeometry;
	const positions = geometry.attributes.position as THREE.BufferAttribute;
	const grass = new THREE.Color("#3f6d21");
	/** Light mud road — readable on green terrain, no grass (masked separately). */
	const mud = new THREE.Color("#a8906e");

	if (!geometry.attributes.color) {
		const arr = new Float32Array(positions.count * 3);
		for (let i = 0; i < positions.count; i++) {
			arr[i * 3] = grass.r;
			arr[i * 3 + 1] = grass.g;
			arr[i * 3 + 2] = grass.b;
		}
		geometry.setAttribute("color", new THREE.BufferAttribute(arr, 3));
	}
	const colors = geometry.attributes.color as THREE.BufferAttribute;

	const radiusSq = radius * radius;
	const inv = 1 / Math.max(radius, 0.0001);
	const origin = mesh.position;

	for (let i = 0; i < positions.count; i++) {
		const x = positions.getX(i) + origin.x;
		const z = positions.getZ(i) + origin.z;
		const dx = x - worldX;
		const dz = z - worldZ;
		const d2 = dx * dx + dz * dz;
		if (d2 > radiusSq) continue;
		const t = 1 - Math.sqrt(d2) * inv;
		const w = t * t * (3 - 2 * t);
		colors.setXYZ(
			i,
			THREE.MathUtils.lerp(colors.getX(i), mud.r, w),
			THREE.MathUtils.lerp(colors.getY(i), mud.g, w),
			THREE.MathUtils.lerp(colors.getZ(i), mud.b, w)
		);
	}
	colors.needsUpdate = true;
}

/**
 * Green → muddy bank → water. Paints wet floor + a soft muddy shore ring.
 * `innerRadius` ≈ water edge; `outerRadius` ≈ where grass resumes.
 */
export function paintTerrainMudShore(
	mesh: THREE.Mesh,
	worldX: number,
	worldZ: number,
	innerRadius: number,
	outerRadius: number
) {
	const geometry = mesh.geometry as THREE.BufferGeometry;
	const positions = geometry.attributes.position as THREE.BufferAttribute;
	const grass = new THREE.Color("#3f6d21");
	const mud = new THREE.Color("#9a8060");
	const wetMud = new THREE.Color("#7a6848");

	if (!geometry.attributes.color) {
		const arr = new Float32Array(positions.count * 3);
		for (let i = 0; i < positions.count; i++) {
			arr[i * 3] = grass.r;
			arr[i * 3 + 1] = grass.g;
			arr[i * 3 + 2] = grass.b;
		}
		geometry.setAttribute("color", new THREE.BufferAttribute(arr, 3));
	}
	const colors = geometry.attributes.color as THREE.BufferAttribute;
	const inner = Math.max(1, innerRadius);
	const outer = Math.max(inner + 1.5, outerRadius);
	const band = Math.max(0.001, outer - inner);
	const outerSq = outer * outer;
	const origin = mesh.position;

	for (let i = 0; i < positions.count; i++) {
		const x = positions.getX(i) + origin.x;
		const z = positions.getZ(i) + origin.z;
		const dx = x - worldX;
		const dz = z - worldZ;
		const d2 = dx * dx + dz * dz;
		if (d2 > outerSq) continue;

		const r = Math.sqrt(d2);
		let target: THREE.Color;
		let w: number;

		if (r <= inner) {
			// Under / at the waterline — wetter mud (hides green basin floor).
			const floorT = 1 - r / Math.max(inner, 0.0001);
			w = 0.75 + 0.2 * floorT;
			target = wetMud;
		} else {
			// Shore band: strongest mud near water, fades to green outward.
			const t = 1 - (r - inner) / band;
			const shore = t * t * (3 - 2 * t);
			w = shore * 0.95;
			target = mud;
		}

		if (w < 0.02) continue;
		colors.setXYZ(
			i,
			THREE.MathUtils.lerp(colors.getX(i), target.r, w),
			THREE.MathUtils.lerp(colors.getY(i), target.g, w),
			THREE.MathUtils.lerp(colors.getZ(i), target.b, w)
		);
	}
	colors.needsUpdate = true;
}
