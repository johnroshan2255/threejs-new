import * as THREE from "three";

export const TERRAIN_CONFIG = {
	/** World size on X/Z (units). */
	size: 140,
	/** Grid resolution — higher = smoother hills, heavier collider. */
	segments: 96,
	/** Peak hill height. */
	maxHeight: 7,
	/** How strong mid-frequency hills are. */
	hillStrength: 1,
	/** Big driveable hill. */
	mainHill: {
		x: 28,
		z: -18,
		height: 16,
		radius: 32,
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
		basin = -6.0 + 5.5 * (norm * norm * norm); // cubic dropoff for a nice deep center
	} else if (distToPond <= 13) {
		// Shoreline: gently slope from the water's edge (-0.5m) up to the flat rim (0m).
		const norm = (distToPond - 10) / 3.0;
		basin = -0.5 * (1 - norm);
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

	const mesh = new THREE.Mesh(geometry, material);
	mesh.name = "large-terrain";
	mesh.receiveShadow = true;
	mesh.castShadow = false;

	const nrows = segments;
	const ncols = segments;
	const half = size / 2;
	const heights = new Float32Array((nrows + 1) * (ncols + 1));

	// Rapier column-major: index = row + col * (nrows + 1)
	for (let col = 0; col <= ncols; col++) {
		for (let row = 0; row <= nrows; row++) {
			const x = -half + (col / ncols) * size;
			const z = -half + (row / nrows) * size;
			const index = row + col * (nrows + 1);
			heights[index] = sampleTerrainHeight(x, z);
		}
	}

	return { mesh, heights, nrows, ncols };
}
