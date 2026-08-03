import * as THREE from "three";
import type { WorldDefinition } from "./worldTypes";

function fade(t: number) {
	return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number) {
	return a + (b - a) * t;
}

function valueNoise2D(x: number, z: number, seed: number) {
	const x0 = Math.floor(x);
	const z0 = Math.floor(z);
	const fx = fade(x - x0);
	const fz = fade(z - z0);
	const hash = (ix: number, iz: number) => {
		const n = Math.sin(ix * 127.1 + iz * 311.7 + seed * 0.001) * 43758.5453;
		return n - Math.floor(n);
	};
	return lerp(
		lerp(hash(x0, z0), hash(x0 + 1, z0), fx),
		lerp(hash(x0, z0 + 1), hash(x0 + 1, z0 + 1), fx),
		fz
	);
}

function fbm(x: number, z: number, seed: number) {
	let amp = 1;
	let freq = 1;
	let value = 0;
	let norm = 0;
	for (let i = 0; i < 5; i++) {
		value += valueNoise2D(x * freq, z * freq, seed + i * 17) * amp;
		norm += amp;
		amp *= 0.5;
		freq *= 2;
	}
	return value / norm;
}

function hillMound(
	x: number,
	z: number,
	cx: number,
	cz: number,
	radius: number
) {
	const d = Math.hypot(x - cx, z - cz) / radius;
	if (d >= 1) return 0;
	const t = 1 - d;
	return t * t * (3 - 2 * t);
}

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
	const { size, segments } = definition;
	const seed = definition.seed ?? 42;
	const half = size * 0.5;
	const scale = size / 200;
	const maxHeight = 7 * Math.min(1.4, Math.sqrt(scale));
	const hillStrength = 1;
	const mainHill = {
		x: 36 * scale * 0.35,
		z: -24 * scale * 0.35,
		height: 18 * Math.min(1.2, Math.sqrt(scale)),
		radius: 40 * Math.min(2.2, scale * 0.45),
	};

	const sample = (x: number, z: number) => {
		const nx = (x / half) * 1.6;
		const nz = (z / half) * 1.6;
		const rolling = (fbm(nx * 1.1 + 2.3, nz * 1.1 - 1.7, seed) - 0.5) * 2;
		const detail = (fbm(nx * 3.4 - 5.1, nz * 3.4 + 4.2, seed + 3) - 0.5) * 0.45;
		const broad = (fbm(nx * 0.45 + 10, nz * 0.45 - 8, seed + 7) - 0.5) * 1.4;
		const edge = Math.max(Math.abs(x), Math.abs(z)) / half;
		const edgeMask = 1 - Math.pow(Math.min(edge, 1), 3) * 0.35;
		const base =
			(rolling * hillStrength + detail + broad) * maxHeight * 0.35 * edgeMask;
		const mound = hillMound(x, z, mainHill.x, mainHill.z, mainHill.radius);
		return base + mound * mainHill.height * edgeMask;
	};

	const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
	geometry.rotateX(-Math.PI / 2);

	const positions = geometry.attributes.position as THREE.BufferAttribute;
	// No vertex colors by default — material.color is the island green.
	// Road paint adds a color attribute later.
	for (let i = 0; i < positions.count; i++) {
		const x = positions.getX(i);
		const z = positions.getZ(i);
		positions.setY(i, sample(x, z));
	}
	positions.needsUpdate = true;
	geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	geometry.computeBoundsTree();

	const mesh = new THREE.Mesh(geometry, material);
	mesh.name = `terrain-${definition.id}`;
	mesh.receiveShadow = true;
	mesh.castShadow = false;

	const nrows = segments;
	const ncols = segments;
	const heights = new Float32Array((nrows + 1) * (ncols + 1));
	for (let col = 0; col <= ncols; col++) {
		for (let row = 0; row <= nrows; row++) {
			const x = -half + (col / ncols) * size;
			const z = -half + (row / nrows) * size;
			heights[row + col * (nrows + 1)] = sample(x, z);
		}
	}

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
