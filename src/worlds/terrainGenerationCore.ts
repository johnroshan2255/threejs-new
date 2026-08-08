export type TerrainGenerationRequest = {
	size: number;
	segments: number;
	seed: number;
};

export type TerrainGenerationResult = {
	positions: Float32Array;
	normals: Float32Array;
	heights: Float32Array;
	nrows: number;
	ncols: number;
	size: number;
};

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

function subVectors(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
	return { x: ax - bx, y: ay - by, z: az - bz };
}

function crossVectors(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
	return {
		x: ay * bz - az * by,
		y: az * bx - ax * bz,
		z: ax * by - ay * bx
	};
}

export function buildTerrainGeneration(request: TerrainGenerationRequest): TerrainGenerationResult {
	const { size, segments } = request;
	const seed = request.seed ?? 42;
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

	const nrows = segments;
	const ncols = segments;
	const numVertices = (nrows + 1) * (ncols + 1);

	const positions = new Float32Array(numVertices * 3);
	const normals = new Float32Array(numVertices * 3);
	const heights = new Float32Array(numVertices);

	const segment_width = size / segments;
	const segment_height = size / segments;
	const width_half = size / 2;
	const height_half = size / 2;

	// 1. Generate positions exactly like THREE.PlaneGeometry with rotateX(-Math.PI / 2)
	let i = 0;
	for (let iy = 0; iy <= segments; iy++) {
		const z = iy * segment_height - height_half;
		for (let ix = 0; ix <= segments; ix++) {
			const x = ix * segment_width - width_half;
			const y = sample(x, z);

			positions[i * 3] = x;
			positions[i * 3 + 1] = y;
			positions[i * 3 + 2] = z;
			i++;
		}
	}

	// 2. Generate normals using identical face-accumulation as geometry.computeVertexNormals()
	for (let iy = 0; iy < segments; iy++) {
		for (let ix = 0; ix < segments; ix++) {
			const a = ix + (segments + 1) * iy;
			const b = ix + (segments + 1) * (iy + 1);
			const c = (ix + 1) + (segments + 1) * (iy + 1);
			const d = (ix + 1) + (segments + 1) * iy;

			// Triangle 1: a, b, d
			const pA1 = { x: positions[a*3], y: positions[a*3+1], z: positions[a*3+2] };
			const pB1 = { x: positions[b*3], y: positions[b*3+1], z: positions[b*3+2] };
			const pC1 = { x: positions[d*3], y: positions[d*3+1], z: positions[d*3+2] };
			
			const cb1 = subVectors(pC1.x, pC1.y, pC1.z, pB1.x, pB1.y, pB1.z);
			const ab1 = subVectors(pA1.x, pA1.y, pA1.z, pB1.x, pB1.y, pB1.z);
			const cross1 = crossVectors(cb1.x, cb1.y, cb1.z, ab1.x, ab1.y, ab1.z);

			normals[a*3] += cross1.x; normals[a*3+1] += cross1.y; normals[a*3+2] += cross1.z;
			normals[b*3] += cross1.x; normals[b*3+1] += cross1.y; normals[b*3+2] += cross1.z;
			normals[d*3] += cross1.x; normals[d*3+1] += cross1.y; normals[d*3+2] += cross1.z;

			// Triangle 2: b, c, d
			const pA2 = { x: positions[b*3], y: positions[b*3+1], z: positions[b*3+2] };
			const pB2 = { x: positions[c*3], y: positions[c*3+1], z: positions[c*3+2] };
			const pC2 = { x: positions[d*3], y: positions[d*3+1], z: positions[d*3+2] };
			
			const cb2 = subVectors(pC2.x, pC2.y, pC2.z, pB2.x, pB2.y, pB2.z);
			const ab2 = subVectors(pA2.x, pA2.y, pA2.z, pB2.x, pB2.y, pB2.z);
			const cross2 = crossVectors(cb2.x, cb2.y, cb2.z, ab2.x, ab2.y, ab2.z);

			normals[b*3] += cross2.x; normals[b*3+1] += cross2.y; normals[b*3+2] += cross2.z;
			normals[c*3] += cross2.x; normals[c*3+1] += cross2.y; normals[c*3+2] += cross2.z;
			normals[d*3] += cross2.x; normals[d*3+1] += cross2.y; normals[d*3+2] += cross2.z;
		}
	}

	// Normalize
	for (let j = 0; j < numVertices; j++) {
		const nx = normals[j * 3];
		const ny = normals[j * 3 + 1];
		const nz = normals[j * 3 + 2];
		const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
		if (len > 0) {
			normals[j * 3] /= len;
			normals[j * 3 + 1] /= len;
			normals[j * 3 + 2] /= len;
		} else {
			normals[j * 3] = 0;
			normals[j * 3 + 1] = 1;
			normals[j * 3 + 2] = 0;
		}
	}

	// 3. Generate heights array for Rapier (Z-fastest layout)
	for (let col = 0; col <= ncols; col++) {
		for (let row = 0; row <= nrows; row++) {
			const x = -half + (col / ncols) * size;
			const z = -half + (row / nrows) * size;
			heights[row + col * (nrows + 1)] = sample(x, z);
		}
	}

	return { positions, normals, heights, nrows, ncols, size };
}
