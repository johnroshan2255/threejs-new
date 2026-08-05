/**
 * Grass instance placement — pure math, no THREE, so it runs in a worker.
 *
 * Output is per-chunk flat Float32Arrays in THREE's column-major Matrix4 layout,
 * ready to blit straight into an InstancedMesh's instanceMatrix. The main thread
 * therefore does zero per-instance work: at 1.3M blades the old path allocated
 * 1.3M Matrix4 objects (plus a second copy while bucketing), which is where the
 * multi-hundred-millisecond stall after every sculpt stroke came from.
 */

export type GrassPlacementRequest = {
	heights: Float32Array;
	nrows: number;
	ncols: number;
	/** Terrain extent on X/Z (m). */
	size: number;
	/** Blade spacing of the sampling lattice (m). */
	spacing: number;
	/** Chance a lattice cell is kept, thinning uniformly to the blade budget. */
	keepProb: number;
	maxCount: number;
	/** Reject blades on ground steeper than this (cos of the slope limit). */
	minNormalY: number;
	chunkSize: number;
	/** Scales blade height only, not footprint. */
	heightMultiplier: number;
	clearPondHole: boolean;
	pondX: number;
	pondZ: number;
};

export type GrassChunkData = {
	count: number;
	/** count * 16 floats, column-major (THREE Matrix4 element order). */
	matrices: Float32Array;
	centerX: number;
	centerY: number;
	centerZ: number;
	minX: number;
	minY: number;
	minZ: number;
	maxX: number;
	maxY: number;
	maxZ: number;
};

export type GrassPlacementResult = {
	chunks: GrassChunkData[];
	total: number;
};

const FLOATS_PER_INSTANCE = 16;

/** Per-chunk growable matrix buffer. Doubling keeps peak memory near 2× final. */
class ChunkAccumulator {
	count = 0;
	data = new Float32Array(64 * FLOATS_PER_INSTANCE);
	sumX = 0;
	sumY = 0;
	sumZ = 0;
	minX = Infinity;
	minY = Infinity;
	minZ = Infinity;
	maxX = -Infinity;
	maxY = -Infinity;
	maxZ = -Infinity;

	reserve() {
		const needed = (this.count + 1) * FLOATS_PER_INSTANCE;
		if (needed <= this.data.length) return;
		const grown = new Float32Array(Math.max(needed, this.data.length * 2));
		grown.set(this.data);
		this.data = grown;
	}
}

/**
 * Fisher-Yates over 16-float blocks.
 *
 * Distance fade thins a chunk by lowering InstancedMesh.count, which drops the
 * *last* instances. Generated in lattice order that would peel the field off one
 * side in visible rows, so the order has to be randomised.
 */
function shuffleBlocks(data: Float32Array, count: number) {
	const scratch = new Float32Array(FLOATS_PER_INSTANCE);
	for (let i = count - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		if (i === j) continue;
		const oi = i * FLOATS_PER_INSTANCE;
		const oj = j * FLOATS_PER_INSTANCE;
		scratch.set(data.subarray(oi, oi + FLOATS_PER_INSTANCE));
		data.copyWithin(oi, oj, oj + FLOATS_PER_INSTANCE);
		data.set(scratch, oj);
	}
}

/**
 * Write one instance matrix, matching THREE exactly:
 *   quaternion.setFromUnitVectors((0,1,0), n).multiply(yaw) → Matrix4.compose
 *
 * Written out longhand so this file stays THREE-free and worker-loadable.
 * Verified element-wise against THREE in scratch/grassMathTest.ts.
 */
export function writeBladeMatrix(
	out: Float32Array,
	offset: number,
	px: number,
	py: number,
	pz: number,
	nx: number,
	ny: number,
	nz: number,
	yaw: number,
	scaleX: number,
	scaleY: number,
	scaleZ: number
) {
	// setFromUnitVectors((0,1,0), n) reduces to this quaternion.
	let qx = nz;
	let qy = 0;
	let qz = -nx;
	let qw = 1 + ny;
	const ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
	if (ql < 1e-6) {
		// Exactly antiparallel: 180° about +Z, matching THREE's axis choice for +Y.
		qx = 0;
		qy = 0;
		qz = 1;
		qw = 0;
	} else {
		qx /= ql;
		qy /= ql;
		qz /= ql;
		qw /= ql;
	}

	// Multiply by a spin about Y so blades do not all face one way.
	const s = Math.sin(yaw * 0.5);
	const c = Math.cos(yaw * 0.5);
	const rx = qx * c - qz * s;
	const ry = qy * c + qw * s;
	const rz = qz * c + qx * s;
	const rw = qw * c - qy * s;

	const x2 = rx + rx;
	const y2 = ry + ry;
	const z2 = rz + rz;
	const xx = rx * x2;
	const xy = rx * y2;
	const xz = rx * z2;
	const yy = ry * y2;
	const yz = ry * z2;
	const zz = rz * z2;
	const wx = rw * x2;
	const wy = rw * y2;
	const wz = rw * z2;

	out[offset] = (1 - (yy + zz)) * scaleX;
	out[offset + 1] = (xy + wz) * scaleX;
	out[offset + 2] = (xz - wy) * scaleX;
	out[offset + 3] = 0;
	out[offset + 4] = (xy - wz) * scaleY;
	out[offset + 5] = (1 - (xx + zz)) * scaleY;
	out[offset + 6] = (yz + wx) * scaleY;
	out[offset + 7] = 0;
	out[offset + 8] = (xz + wy) * scaleZ;
	out[offset + 9] = (yz - wx) * scaleZ;
	out[offset + 10] = (1 - (xx + yy)) * scaleZ;
	out[offset + 11] = 0;
	out[offset + 12] = px;
	out[offset + 13] = py;
	out[offset + 14] = pz;
	out[offset + 15] = 1;
}

export function buildGrassPlacement(
	req: GrassPlacementRequest
): GrassPlacementResult {
	const {
		heights,
		nrows,
		ncols,
		size,
		spacing,
		keepProb,
		maxCount,
		minNormalY,
		chunkSize,
		heightMultiplier,
		clearPondHole,
		pondX,
		pondZ,
	} = req;

	const half = size * 0.5;
	const stride = nrows + 1;

	/**
	 * Bilinear over the terrain grid. The rendered surface interpolates between
	 * vertices, so nearest-vertex snapping would sink blades into slopes (or float
	 * them) by up to half a cell × tan(slope) — metres on big worlds, where cells
	 * reach ~39 m at the 254-segment cap.
	 */
	const sampleH = (x: number, z: number) => {
		let fx = ((x + half) / size) * ncols;
		let fz = ((z + half) / size) * nrows;
		fx = fx < 0 ? 0 : fx > ncols ? ncols : fx;
		fz = fz < 0 ? 0 : fz > nrows ? nrows : fz;
		const col0 = Math.floor(fx);
		const row0 = Math.floor(fz);
		const col1 = col0 + 1 > ncols ? ncols : col0 + 1;
		const row1 = row0 + 1 > nrows ? nrows : row0 + 1;
		const tx = fx - col0;
		const tz = fz - row0;
		const h00 = heights[row0 + col0 * stride]!;
		const h10 = heights[row0 + col1 * stride]!;
		const h01 = heights[row1 + col0 * stride]!;
		const h11 = heights[row1 + col1 * stride]!;
		const hRow0 = h00 + (h10 - h00) * tx;
		const hRow1 = h01 + (h11 - h01) * tx;
		return hRow0 + (hRow1 - hRow0) * tz;
	};

	const normalEpsilon = Math.max(spacing * 0.5, size / ncols);
	const chunks = new Map<number, ChunkAccumulator>();
	// Chunk indices can go negative; fold into a single integer key.
	const keyOf = (cx: number, cz: number) => (cx + 4096) * 16384 + (cz + 4096);

	let total = 0;
	let rowIndex = 0;

	for (let gz = -half + spacing * 0.5; gz < half; gz += spacing, rowIndex++) {
		if (total >= maxCount) break;
		// Offset every other row by half a cell (hex-style packing). A square
		// lattice lines blades up in axis-aligned rows, and the seam between rows
		// reads as a bare stripe on any hillside seen face-on.
		const rowShift = (rowIndex & 1) * spacing * 0.5;
		for (let gx = -half + spacing * 0.5 + rowShift; gx < half; gx += spacing) {
			if (total >= maxCount) break;
			if (keepProb < 1 && Math.random() > keepProb) continue;

			// Full-cell jitter (stratified). At 0.9 every cell kept a 5% no-blade
			// margin, and those margins joined up into grid lines.
			const x = gx + (Math.random() - 0.5) * spacing;
			const z = gz + (Math.random() - 0.5) * spacing;
			if (x < -half || x > half || z < -half || z > half) continue;

			// Slope from central differences, same as the terrain's own normals.
			const e = normalEpsilon;
			let nx = sampleH(x - e, z) - sampleH(x + e, z);
			let ny = e * 2;
			let nz = sampleH(x, z - e) - sampleH(x, z + e);
			const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
			nx /= nl;
			ny /= nl;
			nz /= nl;
			if (ny < minNormalY) continue;

			const y = sampleH(x, z);

			// Thin and shorten blades approaching the pond so the shore reads wet.
			let heightScale = 1;
			if (clearPondHole) {
				const distToPond = Math.hypot(x - pondX, z - pondZ);
				if (distToPond < 14) {
					if (distToPond < 8) {
						if (Math.random() > 0.15) continue;
						heightScale = 0.25 + Math.random() * 0.15;
					} else if (distToPond < 10) {
						if (Math.random() > 0.4) continue;
						heightScale = 0.35 + Math.random() * 0.2;
					} else {
						const t = (distToPond - 10) / 4;
						heightScale = 0.45 + 0.55 * t;
					}
				}
			}

			const variation = 0.8 + Math.random() * 0.4;
			const scaleX = variation;
			const scaleY = heightScale * variation * heightMultiplier;
			const scaleZ = variation;

			const yaw = Math.random() * Math.PI * 2;

			const cx = Math.floor(x / chunkSize);
			const cz = Math.floor(z / chunkSize);
			const key = keyOf(cx, cz);
			let chunk = chunks.get(key);
			if (!chunk) {
				chunk = new ChunkAccumulator();
				chunks.set(key, chunk);
			}
			chunk.reserve();
			writeBladeMatrix(
				chunk.data,
				chunk.count * FLOATS_PER_INSTANCE,
				x,
				y,
				z,
				nx,
				ny,
				nz,
				yaw,
				scaleX,
				scaleY,
				scaleZ
			);

			chunk.count++;
			chunk.sumX += x;
			chunk.sumY += y;
			chunk.sumZ += z;
			// Track bounds against the float32 values actually stored in the buffer.
			// Accumulating the doubles instead leaves instances a rounding step
			// outside the reported box, which would be a (tiny) culling pop.
			const fx = Math.fround(x);
			const fy = Math.fround(y);
			const fz2 = Math.fround(z);
			if (fx < chunk.minX) chunk.minX = fx;
			if (fy < chunk.minY) chunk.minY = fy;
			if (fz2 < chunk.minZ) chunk.minZ = fz2;
			if (fx > chunk.maxX) chunk.maxX = fx;
			if (fy > chunk.maxY) chunk.maxY = fy;
			if (fz2 > chunk.maxZ) chunk.maxZ = fz2;
			total++;
		}
	}

	const out: GrassChunkData[] = [];
	for (const chunk of chunks.values()) {
		if (chunk.count === 0) continue;
		shuffleBlocks(chunk.data, chunk.count);
		// Trim to exactly count so the buffer transfers without slack.
		const matrices = chunk.data.subarray(0, chunk.count * FLOATS_PER_INSTANCE);
		out.push({
			count: chunk.count,
			matrices: new Float32Array(matrices),
			centerX: chunk.sumX / chunk.count,
			centerY: chunk.sumY / chunk.count,
			centerZ: chunk.sumZ / chunk.count,
			minX: chunk.minX,
			minY: chunk.minY,
			minZ: chunk.minZ,
			maxX: chunk.maxX,
			maxY: chunk.maxY,
			maxZ: chunk.maxZ,
		});
	}

	return { chunks: out, total };
}
