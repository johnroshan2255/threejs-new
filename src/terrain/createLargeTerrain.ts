import * as THREE from "three";
import { applyTerrainShading } from "./snowShading";

export const TERRAIN_CONFIG = {
	/** World size on X/Z (units). */
	size: 200,
	/** Grid resolution — higher = smoother hills, heavier collider. */
	segments: 254,
	/** Peak hill height. */
	maxHeight: 7,
	/** How strong mid-frequency hills are. */
	hillStrength: 1,
	/** Big driveable hill. */
	mainHill: {
		x: 36,
		z: -24,
		height: 18,
		radius: 40,
	},
};

function fade(t: number) {
	return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number) {
	return a + (b - a) * t;
}

function valueNoise2D(x: number, z: number) {
	const x0 = Math.floor(x);
	const z0 = Math.floor(z);
	const fx = fade(x - x0);
	const fz = fade(z - z0);

	const hash = (ix: number, iz: number) => {
		const n = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
		return n - Math.floor(n);
	};

	const v00 = hash(x0, z0);
	const v10 = hash(x0 + 1, z0);
	const v01 = hash(x0, z0 + 1);
	const v11 = hash(x0 + 1, z0 + 1);

	return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fz);
}

function fbm(x: number, z: number) {
	let amp = 1;
	let freq = 1;
	let sum = 0;
	let norm = 0;

	for (let i = 0; i < 4; i++) {
		sum += valueNoise2D(x * freq, z * freq) * amp;
		norm += amp;
		amp *= 0.5;
		freq *= 2.05;
	}

	return sum / norm;
}

/** Smooth dome: 1 at center → 0 at radius. */
function hillMound(x: number, z: number, cx: number, cz: number, radius: number) {
	const dx = (x - cx) / radius;
	const dz = (z - cz) / radius;
	const d = Math.sqrt(dx * dx + dz * dz);
	if (d >= 1) return 0;
	const t = 1 - d;
	// Smoothstep-ish falloff so the car can climb it.
	return t * t * (3 - 2 * t);
}

/** World-space height at (x, z). */
export function sampleTerrainHeight(x: number, z: number): number {
	const { size, maxHeight, hillStrength, mainHill } = TERRAIN_CONFIG;
	const half = size * 0.5;
	const nx = (x / half) * 1.6;
	const nz = (z / half) * 1.6;

	const rolling = (fbm(nx * 1.1 + 2.3, nz * 1.1 - 1.7) - 0.5) * 2;
	const detail = (fbm(nx * 3.4 - 5.1, nz * 3.4 + 4.2) - 0.5) * 0.45;
	const broad = (fbm(nx * 0.45 + 10, nz * 0.45 - 8) - 0.5) * 1.4;

	const edge = Math.max(Math.abs(x), Math.abs(z)) / half;
	const edgeMask = 1 - Math.pow(Math.min(edge, 1), 3) * 0.35;

	// Flatten the terrain noise around the pond (up to 18m radius) to ensure a solid rim
	const distToPond = Math.hypot(x - (-20), z - 5);
	let pondMask = 1.0;
	if (distToPond < 18) {
		const t = Math.max(0, (distToPond - 12) / 6);
		pondMask = t * t * (3 - 2 * t);
	}

	const base =
		(rolling * hillStrength + detail + broad) * maxHeight * 0.35 * edgeMask * pondMask;

	const mound = hillMound(x, z, mainHill.x, mainHill.z, mainHill.radius);
	const hill = mound * mainHill.height * edgeMask;

	// Create a perfectly fitted basin for the 20x20 pond.
	// We want the water to sit very close to ground level (-0.5m) so it's visible from all angles.
	let basin = 0;
	if (distToPond <= 10) {
		// Inside the water: smooth bowl dropping from -0.5m at the shore to -6m at the center.
		const norm = distToPond / 10.0;
		const t = norm * norm * (3 - 2 * norm); // smoothstep
		basin = -6.0 + 5.5 * t;
	} else if (distToPond <= 13) {
		// Shoreline: gently slope from the water's edge (-0.5m) up to the flat rim (0m).
		const norm = (distToPond - 10) / 3.0;
		const t = norm * norm * (3 - 2 * norm); // smoothstep to perfectly blend the edge!
		basin = -0.5 * (1 - t);
	}
	
	return base + hill + basin;
}

/**
 * Large rolling-hills terrain (replaces the small island.glb).
 * Geometry is baked Y-up (no mesh.rotation) so grass sampling stays in world space.
 */
export function createLargeTerrain(material: THREE.Material): {
	mesh: THREE.Mesh;
	heights: Float32Array;
	nrows: number;
	ncols: number;
} {
	// Patched here rather than at the caller: terrain materials are built in
	// several places (island, custom worlds, valley) and a missed one shows up as
	// snow that covers grass and rocks but leaves the ground green — which is
	// exactly what you see from a distance, where grass has faded out.
	applyTerrainShading(material, Boolean((material as any).vertexColors));

	const { size, segments } = TERRAIN_CONFIG;
	const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
	// Bake flat → ground orientation into the geometry (identity mesh transform).
	geometry.rotateX(-Math.PI / 2);

	const positions = geometry.attributes.position;
	for (let i = 0; i < positions.count; i++) {
		const x = positions.getX(i);
		const z = positions.getZ(i);
		positions.setY(i, sampleTerrainHeight(x, z));
	}

	positions.needsUpdate = true;
	geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();

	// Right-size the attributes that do not need 32-bit precision.
	//
	// Terrain is the one geometry that grows with world size, so per-vertex bytes
	// matter here more than anywhere else: at 2048 segments it is 4.2 M vertices.
	//   normal: unit vector, Int8 normalized is ~0.8 degrees of error -> 12 B -> 4 B
	//           (three pads x3 to snorm8x4 for alignment, so 4 not 3)
	//   uv:     PlaneGeometry emits 0..1 exactly, so Unorm16 is lossless here -> 8 B -> 4 B
	packNormalsInt8(geometry);
	packUvUint16(geometry);

	// The BVH is not optional: gameplay height queries raycast this mesh
	// (islandHeight.ts), so it is built here rather than lazily in the editor.
	geometry.computeBoundsTree();

	const mesh = new THREE.Mesh(geometry, material);
	mesh.name = "large-terrain";
	mesh.receiveShadow = true;
	mesh.castShadow = false;

	const nrows = segments;
	const ncols = segments;
	const half = size / 2;
	const heights = new Float32Array((nrows + 1) * (ncols + 1));

	// Rapier column-major: j + i * (ncols + 1) where j is Z, i is X.
	// This means Z varies fastest in memory.
	for (let j = 0; j <= ncols; j++) {
		for (let i = 0; i <= nrows; i++) {
			const x = -half + (i / nrows) * size;
			const z = -half + (j / ncols) * size;
			const index = j + i * (ncols + 1);
			heights[index] = sampleTerrainHeight(x, z);
		}
	}

	return { mesh, heights, nrows, ncols };
}

/**
 * Convert a Float32 normal attribute to Int8 normalized in place.
 *
 * Normals are unit-length, so the useful range is exactly [-1, 1] — the range a
 * signed normalized 8-bit attribute represents. Worst-case angular error is well
 * under a degree, which terrain lighting cannot show.
 */
function packNormalsInt8(geometry: THREE.BufferGeometry): void {
	const src = geometry.getAttribute("normal");
	if (!src || !(src.array instanceof Float32Array)) return;
	const n = src.count * 3;
	const packed = new Int8Array(n);
	for (let i = 0; i < n; i++) {
		const v = (src.array as Float32Array)[i]!;
		packed[i] = Math.max(-127, Math.min(127, Math.round(v * 127)));
	}
	geometry.setAttribute("normal", new THREE.BufferAttribute(packed, 3, true));
}

/**
 * Convert a Float32 uv attribute to Uint16 normalized in place.
 *
 * Only valid because PlaneGeometry's uvs are within [0, 1]; a tiling uv (>1)
 * would clamp. 1/65535 of a unit is far finer than any texel this samples.
 */
function packUvUint16(geometry: THREE.BufferGeometry): void {
	const src = geometry.getAttribute("uv");
	if (!src || !(src.array instanceof Float32Array)) return;
	const arr = src.array as Float32Array;
	for (let i = 0; i < arr.length; i++) {
		if (arr[i]! < 0 || arr[i]! > 1) return; // tiling uvs — leave alone
	}
	const packed = new Uint16Array(arr.length);
	for (let i = 0; i < arr.length; i++) packed[i] = Math.round(arr[i]! * 65535);
	geometry.setAttribute("uv", new THREE.BufferAttribute(packed, 2, true));
}
