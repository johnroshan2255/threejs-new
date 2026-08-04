/**
 * Cave geometry primitives. Deliberately free of THREE so this module can be
 * imported by the meshing worker without pulling the renderer into its bundle.
 */

/**
 * One node on a cave tunnel spine (world position + tunnel radius there).
 * A cave is authored as a chain of these — the 3D analogue of a water basin's cells.
 */
export type CaveNode = {
	x: number;
	y: number;
	z: number;
	r: number;
};

/**
 * Serializable cave. Only the spine is stored; the mesh is always rebuilt from it
 * so peers / reloads reproduce identical geometry (no RNG anywhere in the pipeline).
 */
export type CaveSpec = {
	nodes: CaveNode[];
};

/** Terrain height lookup over the live (possibly sculpted) heightfield. */
export type HeightSampler = (x: number, z: number) => number;

function clamp01(v: number) {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampInt(v: number, lo: number, hi: number) {
	return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Bilinear sampler over a Rapier-order heightfield (index = row + col * (nrows + 1)).
 * Bilinear (not nearest) matters — the cave SDF is evaluated at voxel resolution,
 * which is finer than the terrain grid, and nearest sampling would terrace the mouth.
 */
export function createHeightSampler(
	heights: Float32Array,
	nrows: number,
	ncols: number,
	size: number
): HeightSampler {
	const half = size * 0.5;
	const stride = nrows + 1;
	return (x, z) => {
		const fc = ((x + half) / size) * ncols;
		const fr = ((z + half) / size) * nrows;
		const col0 = clampInt(Math.floor(fc), 0, ncols);
		const row0 = clampInt(Math.floor(fr), 0, nrows);
		const col1 = Math.min(col0 + 1, ncols);
		const row1 = Math.min(row0 + 1, nrows);
		const tx = clamp01(fc - col0);
		const tz = clamp01(fr - row0);
		const h00 = heights[row0 + col0 * stride] ?? 0;
		const h10 = heights[row0 + col1 * stride] ?? 0;
		const h01 = heights[row1 + col0 * stride] ?? 0;
		const h11 = heights[row1 + col1 * stride] ?? 0;
		const a = h00 + (h10 - h00) * tx;
		const b = h01 + (h11 - h01) * tx;
		return a + (b - a) * tz;
	};
}

/**
 * Polynomial smooth-min. Blends neighbouring tunnel segments and branches into
 * one organic void instead of leaving a hard crease at every joint.
 */
function smoothMin(a: number, b: number, k: number): number {
	if (k <= 1e-5) return Math.min(a, b);
	const h = clamp01(0.5 + (0.5 * (b - a)) / k);
	return b + (a - b) * h - k * h * (1 - h);
}

/**
 * Distance from p to one tapered capsule segment.
 * Radius is lerped along the segment — an approximation of an exact round cone,
 * but smooth and monotonic, which is all the mesher needs.
 */
function segmentDistance(
	x: number,
	y: number,
	z: number,
	a: CaveNode,
	b: CaveNode
): number {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const abz = b.z - a.z;
	const apx = x - a.x;
	const apy = y - a.y;
	const apz = z - a.z;
	const ab2 = abx * abx + aby * aby + abz * abz;
	const t = ab2 > 1e-9 ? clamp01((apx * abx + apy * aby + apz * abz) / ab2) : 0;
	const cx = apx - abx * t;
	const cy = apy - aby * t;
	const cz = apz - abz * t;
	const r = a.r + (b.r - a.r) * t;
	return Math.sqrt(cx * cx + cy * cy + cz * cz) - r;
}

/**
 * Signed distance to the cave void: negative inside the tunnel, positive in rock.
 */
export function caveDistance(
	nodes: CaveNode[],
	x: number,
	y: number,
	z: number
): number {
	const count = nodes.length;
	if (count === 0) return Infinity;
	if (count === 1) {
		const n = nodes[0]!;
		const dx = x - n.x;
		const dy = y - n.y;
		const dz = z - n.z;
		return Math.sqrt(dx * dx + dy * dy + dz * dz) - n.r;
	}

	let best = Infinity;
	for (let i = 0; i < count - 1; i++) {
		const a = nodes[i]!;
		const b = nodes[i + 1]!;
		const d = segmentDistance(x, y, z, a, b);
		// Blend width scales with the local tunnel so big chambers blend softly
		// and thin passages keep their shape.
		const k = Math.min(a.r, b.r) * 0.55;
		best = i === 0 ? d : smoothMin(best, d, k);
	}
	return best;
}

/** Largest tunnel radius in the chain. */
export function maxCaveRadius(nodes: CaveNode[]): number {
	let r = 0;
	for (const n of nodes) r = Math.max(r, n.r);
	return r;
}

/**
 * Padding around the spine for the voxel region. Must exceed the tunnel radius so
 * the shell fully caps tunnel ends — an unsealed end would let players fall out
 * of the mesh into empty space.
 */
export function cavePadding(nodes: CaveNode[], voxel: number): number {
	return maxCaveRadius(nodes) + voxel * 4 + 0.6;
}

export type CaveBounds = {
	minX: number;
	minY: number;
	minZ: number;
	maxX: number;
	maxY: number;
	maxZ: number;
};

/** World-space voxel region for a cave chain. */
export function caveBounds(nodes: CaveNode[], pad: number): CaveBounds {
	let minX = Infinity;
	let minY = Infinity;
	let minZ = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let maxZ = -Infinity;
	for (const n of nodes) {
		if (n.x - n.r < minX) minX = n.x - n.r;
		if (n.y - n.r < minY) minY = n.y - n.r;
		if (n.z - n.r < minZ) minZ = n.z - n.r;
		if (n.x + n.r > maxX) maxX = n.x + n.r;
		if (n.y + n.r > maxY) maxY = n.y + n.r;
		if (n.z + n.r > maxZ) maxZ = n.z + n.r;
	}
	if (!nodes.length) {
		return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
	}
	return {
		minX: minX - pad,
		minY: minY - pad,
		minZ: minZ - pad,
		maxX: maxX + pad,
		maxY: maxY + pad,
		maxZ: maxZ + pad,
	};
}

/** Rock density: negative inside solid rock, positive in air or inside the cave. */
export function rockDensity(
	nodes: CaveNode[],
	terrainHeight: number,
	x: number,
	y: number,
	z: number
): number {
	const aboveGround = y - terrainHeight;
	const cave = caveDistance(nodes, x, y, z);
	return Math.max(aboveGround, -cave);
}

/**
 * True where the cave void breaks (or nearly breaks) the terrain surface.
 *
 * Single source of truth for three consumers that must agree exactly, or the mouth
 * either shows a gap or double-renders: the terrain hole punch, the cull of
 * surface-coincident shell triangles, and the grass mask.
 *
 * `dilate` deliberately punches slightly wider than the void so the shell's rock
 * lip overlaps the terrain edge rather than meeting it exactly.
 */
export function isMouthColumn(
	nodes: CaveNode[],
	sampleHeight: HeightSampler,
	x: number,
	z: number,
	dilate = 0.6
): boolean {
	const h = sampleHeight(x, z);
	return caveDistance(nodes, x, h - 0.15, z) < dilate;
}
