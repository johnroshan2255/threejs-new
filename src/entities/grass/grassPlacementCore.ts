/**
 * Grass blade placement and packing — pure math, no THREE.
 *
 * Generation is per *chunk* and deterministic: `generateGrassChunk` is a pure
 * function of (seed, chunk coordinate), which is what lets GrassStreamField discard
 * a chunk when it leaves the ring and get the identical blades back when it returns,
 * and what makes every multiplayer client derive the same field.
 *
 * There is no whole-world placement pass any more. `buildGrassPlacement` used to
 * place every blade in the world up front — 1.3M of them on a 1 km map, which is
 * where the multi-hundred-millisecond stall after every sculpt stroke came from, and
 * why it had to be pushed to a worker. Nothing places up front now, so the worker,
 * its client and the chunk-transfer plumbing are all gone with it.
 */

/**
 * Per-blade storage: two vec4s, 32 bytes.
 *
 * Was a full Matrix4 — 64 bytes — of which 16 bytes were the constant last column
 * (0,0,0,1) and the remaining 36 were a 3x3 rotation-times-scale derived from just
 * a normal, a yaw and two scales. At 1.25M blades that layout cost 80 MB in the JS
 * heap, 80 MB of VRAM, and 80 MB of reads on every culling dispatch, to carry
 * ~28 bytes of actual information.
 *
 * The matrix is now rebuilt in the culling compute shader and written only for the
 * blades that survive culling (~8k of 1.25M at the default draw distance), so the
 * expensive layout is paid for what is drawn rather than for what exists.
 *
 * Laid out as two adjacent vec4s rather than a struct so it can be read through a
 * single `storage(..., 'vec4', count * 2)` node: element(i*2) and element(i*2+1).
 * Interleaved, so both reads land in the same 64-byte cache line.
 */
const FLOATS_PER_INSTANCE = 8;

/**
 * Distance over which the blade shader sinks grass out of sight, metres.
 *
 * Lives here because two places have to agree on it and used to not: the material
 * hardcoded 48 / 68 in its vertex stage while GrassChunkField kept its own
 * `fadeStart` / `fadeEnd` that nothing ever read. A blade sinks GRASS_FADE_SINK and
 * is ~1.3 m tall, so nothing is visible past GRASS_FADE_END — which is what bounds
 * the streaming ring and caps the draw-distance setting.
 */
export const GRASS_FADE_START = 48;
export const GRASS_FADE_END = 68;
/** Metres a fully-faded blade is pushed down. Must exceed the tallest blade. */
export const GRASS_FADE_SINK = 2;

/** vec4 0: world position + yaw. */
const BLADE_X = 0;
const BLADE_Y = 1;
const BLADE_Z = 2;
const BLADE_YAW = 3;
/** vec4 1: ground normal XZ + the two scales. */
const BLADE_NX = 4;
const BLADE_NZ = 5;
/** Uniform XZ scale — the 0.8..1.2 size variation. */
const BLADE_SCALE_XZ = 6;
/**
 * Y scale, with the pond taper and the field's height multiplier already folded
 * in. Zero is reserved: it means "masked", and culling drops the blade outright
 * rather than emitting a degenerate one. See GrassStreamField.applyMaskToSlot.
 */
const BLADE_SCALE_Y = 7;

export {
	FLOATS_PER_INSTANCE as GRASS_FLOATS_PER_INSTANCE,
	BLADE_X,
	BLADE_Y,
	BLADE_Z,
	BLADE_YAW,
	BLADE_NX,
	BLADE_NZ,
	BLADE_SCALE_XZ,
	BLADE_SCALE_Y,
};

/**
 * Write one packed blade.
 *
 * `ny` is not stored: placement rejects anything below `minNormalY` (cos 65 deg at
 * the loosest), so the ground normal always points up and `ny` is recoverable as
 * `sqrt(1 - nx^2 - nz^2)`. Feeding this a downward normal would silently flip it.
 */
export function writeBladePacked(
	out: Float32Array,
	offset: number,
	px: number,
	py: number,
	pz: number,
	nx: number,
	nz: number,
	yaw: number,
	scaleXZ: number,
	scaleY: number
) {
	out[offset + BLADE_X] = px;
	out[offset + BLADE_Y] = py;
	out[offset + BLADE_Z] = pz;
	out[offset + BLADE_YAW] = yaw;
	out[offset + BLADE_NX] = nx;
	out[offset + BLADE_NZ] = nz;
	out[offset + BLADE_SCALE_XZ] = scaleXZ;
	out[offset + BLADE_SCALE_Y] = scaleY;
}

/**
 * CPU reference for the matrix the culling shader rebuilds from a packed blade.
 *
 * Exists to be tested: `scratch/grassMathTest.ts` runs pack -> this -> compare
 * against `writeBladeMatrix`, which is itself verified element-wise against THREE.
 * If the TSL in `GrassStreamField` and this function ever disagree, the test will
 * not catch it — so keep the two in step by hand.
 */
export function unpackBladeMatrix(
	out: Float32Array,
	outOffset: number,
	packed: Float32Array,
	offset: number
) {
	const nx = packed[offset + BLADE_NX]!;
	const nz = packed[offset + BLADE_NZ]!;
	const ny = Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz));
	writeBladeMatrix(
		out,
		outOffset,
		packed[offset + BLADE_X]!,
		packed[offset + BLADE_Y]!,
		packed[offset + BLADE_Z]!,
		nx,
		ny,
		nz,
		packed[offset + BLADE_YAW]!,
		packed[offset + BLADE_SCALE_XZ]!,
		packed[offset + BLADE_SCALE_Y]!,
		packed[offset + BLADE_SCALE_XZ]!
	);
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

/**
 * Bilinear height lookup over a terrain grid.
 *
 * The rendered surface interpolates between vertices, so nearest-vertex snapping
 * would sink blades into slopes (or float them) by up to half a cell x tan(slope) —
 * metres on big worlds, where cells reach ~39 m at the 254-segment cap.
 *
 * Module scope rather than a closure so the streaming generator can share it.
 */
export function sampleTerrainHeight(
	heights: Float32Array,
	nrows: number,
	ncols: number,
	size: number,
	x: number,
	z: number
): number {
	const half = size * 0.5;
	const stride = nrows + 1;
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
}

/** 32-bit integer avalanche (splitmix-style). */
function mix32(h: number): number {
	h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
	h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
	return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Deterministic [0,1) from a lattice cell plus a stream id.
 *
 * Placement has to be a pure function of (seed, cell, stream) rather than of call
 * order, for two reasons that both matter more than they look:
 *
 * - Streaming. A chunk is generated whenever it enters the ring and discarded when
 *   it leaves. `Math.random()` would hand back different blades each time, so grass
 *   would rearrange itself every time the player walked away and came back.
 * - Multiplayer. Every client generates its own grass. With `Math.random()` two
 *   clients disagree about where blades are — which for prone players in tall grass
 *   means one client sees someone hidden and another sees them exposed. Keyed on the
 *   world seed instead, every client derives the identical field.
 *
 * `stream` separates the independent decisions taken per cell (keep, jitter, yaw,
 * ...) so they do not correlate with each other.
 */
export function cellRandom(
	seed: number,
	cellX: number,
	cellZ: number,
	stream: number
): number {
	let h = 0x9e3779b9 ^ Math.imul(seed | 0, 0x85ebca6b);
	h = mix32(h ^ Math.imul(cellX | 0, 0xc2b2ae35));
	h = mix32(h ^ Math.imul(cellZ | 0, 0x27d4eb2f));
	h = mix32(h ^ Math.imul(stream | 0, 0x165667b1));
	return h / 4294967296;
}

/** Random streams per lattice cell. Keep distinct so decisions stay independent. */
const STREAM_KEEP = 1;
const STREAM_JITTER_X = 2;
const STREAM_JITTER_Z = 3;
const STREAM_YAW = 4;
const STREAM_VARIATION = 5;
const STREAM_POND_KEEP = 6;
const STREAM_POND_HEIGHT = 7;

export type GrassChunkGenParams = {
	heights: Float32Array;
	nrows: number;
	ncols: number;
	/** Terrain extent on X/Z (m). */
	size: number;
	/** Blade spacing of the sampling lattice (m). */
	spacing: number;
	/** Chance a lattice cell is kept, thinning uniformly to the blade budget. */
	keepProb: number;
	/** Reject blades on ground steeper than this (cos of the slope limit). */
	minNormalY: number;
	/** Scales blade height only, not footprint. */
	heightMultiplier: number;
	chunkSize: number;
	/** Shared across every client and every regeneration of a chunk. */
	seed: number;
	clearPondHole: boolean;
	pondX: number;
	pondZ: number;
};

/**
 * Generate one chunk of blades into `out`, and return how many were written.
 *
 * Cells are assigned to a chunk by their *unjittered* lattice centre, so every cell
 * belongs to exactly one chunk no matter which order chunks are generated in. Jitter
 * can then push a blade up to half a spacing outside its chunk box, which is why the
 * ring pads its cull bounds — see GrassStreamField.
 *
 * Writes at most `capacity` blades. Overflow is dropped rather than grown: the ring
 * allocates fixed-size slots, and a chunk that exceeds its slot would otherwise
 * scribble into its neighbour.
 */
export function generateGrassChunk(
	params: GrassChunkGenParams,
	chunkX: number,
	chunkZ: number,
	out: Float32Array,
	outOffset: number,
	capacity: number
): number {
	const {
		heights,
		nrows,
		ncols,
		size,
		spacing,
		keepProb,
		minNormalY,
		heightMultiplier,
		chunkSize,
		seed,
		clearPondHole,
		pondX,
		pondZ,
	} = params;

	const half = size * 0.5;
	const normalEpsilon = Math.max(spacing * 0.5, size / ncols);
	const sampleH = (x: number, z: number) =>
		sampleTerrainHeight(heights, nrows, ncols, size, x, z);

	// Cell centres: x = -half + spacing * (ix + 0.5) + rowShift(iz), and the same for
	// z without the shift. Every other row is offset half a cell (hex-style packing) —
	// a square lattice lines blades up in axis-aligned rows, and the seam between rows
	// reads as a bare stripe on any hillside seen face-on.
	const minZ = chunkZ * chunkSize;
	const maxZ = minZ + chunkSize;
	const minX = chunkX * chunkSize;
	const maxX = minX + chunkSize;

	const izLo = Math.max(0, Math.ceil((minZ + half) / spacing - 0.5));
	const izHi = Math.floor((maxZ + half) / spacing - 0.5);

	let count = 0;

	for (let iz = izLo; iz <= izHi; iz++) {
		const z = -half + spacing * (iz + 0.5);
		if (z < minZ || z >= maxZ) continue;
		if (z < -half || z > half) continue;

		const rowShift = (iz & 1) * spacing * 0.5;
		const ixLo = Math.max(0, Math.ceil((minX - rowShift + half) / spacing - 0.5));
		const ixHi = Math.floor((maxX - rowShift + half) / spacing - 0.5);

		for (let ix = ixLo; ix <= ixHi; ix++) {
			if (count >= capacity) return count;

			const cellX = -half + spacing * (ix + 0.5) + rowShift;
			if (cellX < minX || cellX >= maxX) continue;
			if (cellX < -half || cellX > half) continue;

			if (
				keepProb < 1 &&
				cellRandom(seed, ix, iz, STREAM_KEEP) > keepProb
			) {
				continue;
			}

			// Full-cell jitter (stratified). At 0.9 every cell kept a 5% no-blade
			// margin, and those margins joined up into grid lines.
			const x =
				cellX + (cellRandom(seed, ix, iz, STREAM_JITTER_X) - 0.5) * spacing;
			const z2 = z + (cellRandom(seed, ix, iz, STREAM_JITTER_Z) - 0.5) * spacing;
			if (x < -half || x > half || z2 < -half || z2 > half) continue;

			// Slope from central differences, same as the terrain's own normals.
			const e = normalEpsilon;
			let nx = sampleH(x - e, z2) - sampleH(x + e, z2);
			let ny = e * 2;
			let nz = sampleH(x, z2 - e) - sampleH(x, z2 + e);
			const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
			nx /= nl;
			ny /= nl;
			nz /= nl;
			if (ny < minNormalY) continue;

			const y = sampleH(x, z2);

			// Thin and shorten blades approaching the pond so the shore reads wet.
			let heightScale = 1;
			if (clearPondHole) {
				const distToPond = Math.hypot(x - pondX, z2 - pondZ);
				if (distToPond < 14) {
					const keep = cellRandom(seed, ix, iz, STREAM_POND_KEEP);
					const shape = cellRandom(seed, ix, iz, STREAM_POND_HEIGHT);
					if (distToPond < 8) {
						if (keep > 0.15) continue;
						heightScale = 0.25 + shape * 0.15;
					} else if (distToPond < 10) {
						if (keep > 0.4) continue;
						heightScale = 0.35 + shape * 0.2;
					} else {
						const t = (distToPond - 10) / 4;
						heightScale = 0.45 + 0.55 * t;
					}
				}
			}

			const variation =
				0.8 + cellRandom(seed, ix, iz, STREAM_VARIATION) * 0.4;
			const yaw = cellRandom(seed, ix, iz, STREAM_YAW) * Math.PI * 2;

			writeBladePacked(
				out,
				outOffset + count * FLOATS_PER_INSTANCE,
				x,
				y,
				z2,
				nx,
				nz,
				yaw,
				variation,
				heightScale * variation * heightMultiplier
			);
			count++;
		}
	}

	return count;
}

