import {
	caveBounds,
	caveDistance,
	cavePadding,
	createHeightSampler,
	isMouthColumn,
	maxCaveRadius,
	rockDensity,
	type CaveBounds,
	type CaveNode,
} from "./caveShape";

/**
 * Surface Nets cave mesher — pure typed-array math, no THREE, so it runs in a
 * worker. The THREE.BufferGeometry wrapper lives in caveMesh.ts.
 */

/**
 * 0.25m keeps tunnel walls reading as carved rock. Coarser grids start to look
 * lumpy at walking distance; finer ones blow past the sample budget for no gain.
 */
const TARGET_VOXEL = 0.25;
/** ~3M samples ≈ 12MB of float scratch and a few hundred ms to mesh. */
const MAX_SAMPLES = 3_000_000;
/** How far past the void the mouth region extends, for both punch and shell. */
export const MOUTH_DILATE = 0.6;
/**
 * The shell's ground apron sits a hair below the terrain plane.
 *
 * Terrain and shell tessellate at different resolutions, so their mouth
 * boundaries cannot line up exactly. The shell therefore keeps slightly more
 * apron than the terrain gives up (any-vertex vs all-vertices below) which
 * guarantees no crack — and this 2mm sink stops the resulting overlap ring from
 * z-fighting against the coplanar terrain.
 */
const SURFACE_SINK = 0.002;

/**
 * Everything the mesher needs, all structured-cloneable so it can be posted to a
 * worker. Heights are passed as the raw grid rather than a sampler function
 * because functions cannot cross a worker boundary.
 */
export type CaveMeshRequest = {
	nodes: CaveNode[];
	heights: Float32Array;
	nrows: number;
	ncols: number;
	size: number;
	targetVoxel?: number;
	maxSamples?: number;
};

export type CaveMeshData = {
	positions: Float32Array;
	normals: Float32Array;
	indices: Uint32Array;
	voxelSize: number;
	bounds: CaveBounds;
	triangles: number;
};

/** Cube corner c → unit offsets (di = c&1, dj = (c>>1)&1, dk = (c>>2)&1). */
const CORNER_X = [0, 1, 0, 1, 0, 1, 0, 1];
const CORNER_Y = [0, 0, 1, 1, 0, 0, 1, 1];
const CORNER_Z = [0, 0, 0, 0, 1, 1, 1, 1];

/** The 12 cube edges as corner-index pairs, grouped x / y / z. */
const EDGE_A = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3];
const EDGE_B = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];

/**
 * Smooth (non-blocky) cave shell via Surface Nets.
 *
 * Each straddling cell contributes ONE vertex placed at the averaged zero-crossing
 * of its edges — a float position anywhere inside the cell, never snapped to a grid
 * corner. That is what separates this from cube meshing: no axis-aligned faces.
 * Normals come from the analytic field gradient rather than face averaging, so
 * shading stays smooth even where the voxel grid is coarse relative to the walls.
 *
 * Returns null when the spine is too small to enclose a void.
 */
export function buildCaveMeshData(req: CaveMeshRequest): CaveMeshData | null {
	const nodes = req.nodes;
	if (nodes.length < 1) return null;
	if (maxCaveRadius(nodes) < 0.2) return null;

	const sampleHeight = createHeightSampler(
		req.heights,
		req.nrows,
		req.ncols,
		req.size
	);

	const maxSamples = req.maxSamples ?? MAX_SAMPLES;
	let voxel = req.targetVoxel ?? TARGET_VOXEL;
	let bounds = caveBounds(nodes, cavePadding(nodes, voxel));
	let nx = 0;

	// Coarsen until the region fits the sample budget (huge authored chambers).
	for (let guard = 0; guard < 24; guard++) {
		bounds = caveBounds(nodes, cavePadding(nodes, voxel));
		nx = Math.floor((bounds.maxX - bounds.minX) / voxel) + 1;
		const ny = Math.floor((bounds.maxY - bounds.minY) / voxel) + 1;
		const nz = Math.floor((bounds.maxZ - bounds.minZ) / voxel) + 1;
		if (nx * ny * nz <= maxSamples) break;
		voxel *= 1.25;
	}

	nx = Math.floor((bounds.maxX - bounds.minX) / voxel) + 1;
	const ny = Math.floor((bounds.maxY - bounds.minY) / voxel) + 1;
	const nz = Math.floor((bounds.maxZ - bounds.minZ) / voxel) + 1;
	const cnx = nx - 1;
	const cny = ny - 1;
	const cnz = nz - 1;
	if (cnx < 2 || cny < 2 || cnz < 2) return null;

	// Terrain height is y-independent — hoist it out of the inner loop so we do
	// nx*nz lookups instead of nx*ny*nz.
	const columnH = new Float32Array(nx * nz);
	for (let k = 0; k < nz; k++) {
		const z = bounds.minZ + k * voxel;
		for (let i = 0; i < nx; i++) {
			columnH[i + k * nx] = sampleHeight(bounds.minX + i * voxel, z);
		}
	}

	const slice = nx * ny;
	const field = new Float32Array(nx * ny * nz);
	for (let k = 0; k < nz; k++) {
		const z = bounds.minZ + k * voxel;
		for (let j = 0; j < ny; j++) {
			const y = bounds.minY + j * voxel;
			const rowBase = j * nx + k * slice;
			for (let i = 0; i < nx; i++) {
				field[i + rowBase] = rockDensity(
					nodes,
					columnH[i + k * nx]!,
					bounds.minX + i * voxel,
					y,
					z
				);
			}
		}
	}

	const density = (x: number, y: number, z: number) =>
		rockDensity(nodes, sampleHeight(x, z), x, y, z);

	const cellVertex = new Int32Array(cnx * cny * cnz).fill(-1);
	const positions: number[] = [];
	const normals: number[] = [];
	/** 1 where a vertex sits on the terrain surface rather than a cave wall. */
	const onSurface: number[] = [];
	/** 1 where a vertex's column belongs to the punched mouth region. */
	const inMouth: number[] = [];
	const corner = new Float64Array(8);
	const grad = voxel * 0.4;

	for (let k = 0; k < cnz; k++) {
		for (let j = 0; j < cny; j++) {
			for (let i = 0; i < cnx; i++) {
				let negatives = 0;
				for (let c = 0; c < 8; c++) {
					const v =
						field[
							i +
								CORNER_X[c]! +
								(j + CORNER_Y[c]!) * nx +
								(k + CORNER_Z[c]!) * slice
						]!;
					corner[c] = v;
					if (v < 0) negatives++;
				}
				// Entirely rock or entirely air — no surface passes through.
				if (negatives === 0 || negatives === 8) continue;

				let sx = 0;
				let sy = 0;
				let sz = 0;
				let crossings = 0;
				for (let e = 0; e < 12; e++) {
					const a = EDGE_A[e]!;
					const b = EDGE_B[e]!;
					const va = corner[a]!;
					const vb = corner[b]!;
					if (va < 0 === vb < 0) continue;
					const t = va / (va - vb);
					sx += CORNER_X[a]! + (CORNER_X[b]! - CORNER_X[a]!) * t;
					sy += CORNER_Y[a]! + (CORNER_Y[b]! - CORNER_Y[a]!) * t;
					sz += CORNER_Z[a]! + (CORNER_Z[b]! - CORNER_Z[a]!) * t;
					crossings++;
				}
				if (crossings === 0) continue;

				const wx = bounds.minX + (i + sx / crossings) * voxel;
				let wy = bounds.minY + (j + sy / crossings) * voxel;
				const wz = bounds.minZ + (k + sz / crossings) * voxel;

				// Gradient of the density field points toward air, i.e. out of the rock.
				let gx = density(wx + grad, wy, wz) - density(wx - grad, wy, wz);
				let gy = density(wx, wy + grad, wz) - density(wx, wy - grad, wz);
				let gz = density(wx, wy, wz + grad) - density(wx, wy, wz - grad);
				const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
				if (gl > 1e-8) {
					gx /= gl;
					gy /= gl;
					gz /= gl;
				} else {
					gx = 0;
					gy = 1;
					gz = 0;
				}

				// density = max(aboveGround, -cave). Whichever term the max picked is
				// the surface this vertex belongs to — an exact classification, so no
				// distance tolerance is needed anywhere downstream.
				const surfaceH = sampleHeight(wx, wz);
				const isSurface = wy - surfaceH >= -caveDistance(nodes, wx, wy, wz);
				if (isSurface) {
					// Weld the lip onto the heightfield. Both meshes approximate the same
					// surface, and the leftover difference is a crack you can see daylight
					// through at the mouth.
					wy = surfaceH - SURFACE_SINK;
				}

				cellVertex[i + j * cnx + k * cnx * cny] = positions.length / 3;
				positions.push(wx, wy, wz);
				normals.push(gx, gy, gz);
				onSurface.push(isSurface ? 1 : 0);
				inMouth.push(
					isMouthColumn(nodes, sampleHeight, wx, wz, MOUTH_DILATE) ? 1 : 0
				);
			}
		}
	}

	if (!positions.length) return null;

	const cellIdx = (ci: number, cj: number, ck: number) =>
		ci + cj * cnx + ck * cnx * cny;
	const rawIndices: number[] = [];
	const quad = (a: number, b: number, c: number, d: number) => {
		if (a < 0 || b < 0 || c < 0 || d < 0) return;
		rawIndices.push(a, b, c, a, c, d);
	};

	// A sign change on an axis-aligned edge means the surface crosses it, so the
	// four cells sharing that edge each hold a vertex — connect them into a quad.
	for (let k = 1; k < cnz; k++) {
		for (let j = 1; j < cny; j++) {
			for (let i = 0; i < cnx; i++) {
				const v0 = field[i + j * nx + k * slice]!;
				const v1 = field[i + 1 + j * nx + k * slice]!;
				if (v0 < 0 === v1 < 0) continue;
				quad(
					cellVertex[cellIdx(i, j - 1, k - 1)]!,
					cellVertex[cellIdx(i, j, k - 1)]!,
					cellVertex[cellIdx(i, j, k)]!,
					cellVertex[cellIdx(i, j - 1, k)]!
				);
			}
		}
	}
	for (let k = 1; k < cnz; k++) {
		for (let j = 0; j < cny; j++) {
			for (let i = 1; i < cnx; i++) {
				const v0 = field[i + j * nx + k * slice]!;
				const v1 = field[i + (j + 1) * nx + k * slice]!;
				if (v0 < 0 === v1 < 0) continue;
				quad(
					cellVertex[cellIdx(i - 1, j, k - 1)]!,
					cellVertex[cellIdx(i, j, k - 1)]!,
					cellVertex[cellIdx(i, j, k)]!,
					cellVertex[cellIdx(i - 1, j, k)]!
				);
			}
		}
	}
	for (let k = 0; k < cnz; k++) {
		for (let j = 1; j < cny; j++) {
			for (let i = 1; i < cnx; i++) {
				const v0 = field[i + j * nx + k * slice]!;
				const v1 = field[i + j * nx + (k + 1) * slice]!;
				if (v0 < 0 === v1 < 0) continue;
				quad(
					cellVertex[cellIdx(i - 1, j - 1, k)]!,
					cellVertex[cellIdx(i, j - 1, k)]!,
					cellVertex[cellIdx(i, j, k)]!,
					cellVertex[cellIdx(i - 1, j, k)]!
				);
			}
		}
	}

	if (!rawIndices.length) return null;

	// Drop shell triangles that just re-state the terrain surface outside the mouth,
	// otherwise the region's top double-renders against the (unpunched) terrain plane.
	const kept: number[] = [];
	for (let t = 0; t < rawIndices.length; t += 3) {
		const i0 = rawIndices[t]!;
		const i1 = rawIndices[t + 1]!;
		const i2 = rawIndices[t + 2]!;
		if (onSurface[i0] === 1 && onSurface[i1] === 1 && onSurface[i2] === 1) {
			// Ground-apron triangle. Keep it if ANY vertex is in the mouth region —
			// deliberately more generous than the terrain punch (which needs ALL
			// vertices), so the shell always reaches past the terrain's hole edge.
			// Everywhere else the terrain plane already covers this ground.
			if (inMouth[i0] !== 1 && inMouth[i1] !== 1 && inMouth[i2] !== 1) continue;
		}

		// Surface Nets quad winding depends on which way the field decreases; rather
		// than case it out, orient each triangle against its own gradient normals.
		const ax = positions[i1 * 3]! - positions[i0 * 3]!;
		const ay = positions[i1 * 3 + 1]! - positions[i0 * 3 + 1]!;
		const az = positions[i1 * 3 + 2]! - positions[i0 * 3 + 2]!;
		const bx = positions[i2 * 3]! - positions[i0 * 3]!;
		const by = positions[i2 * 3 + 1]! - positions[i0 * 3 + 1]!;
		const bz = positions[i2 * 3 + 2]! - positions[i0 * 3 + 2]!;
		const fx = ay * bz - az * by;
		const fy = az * bx - ax * bz;
		const fz = ax * by - ay * bx;
		const nx0 = normals[i0 * 3]! + normals[i1 * 3]! + normals[i2 * 3]!;
		const ny0 = normals[i0 * 3 + 1]! + normals[i1 * 3 + 1]! + normals[i2 * 3 + 1]!;
		const nz0 = normals[i0 * 3 + 2]! + normals[i1 * 3 + 2]! + normals[i2 * 3 + 2]!;
		if (fx * nx0 + fy * ny0 + fz * nz0 < 0) kept.push(i0, i2, i1);
		else kept.push(i0, i1, i2);
	}

	if (!kept.length) return null;

	// Compact away vertices the cull orphaned so bounds and the BVH stay tight.
	const remap = new Int32Array(positions.length / 3).fill(-1);
	const outPos: number[] = [];
	const outNrm: number[] = [];
	const outIdx = new Uint32Array(kept.length);
	for (let n = 0; n < kept.length; n++) {
		const src = kept[n]!;
		let dst = remap[src]!;
		if (dst < 0) {
			dst = outPos.length / 3;
			remap[src] = dst;
			outPos.push(positions[src * 3]!, positions[src * 3 + 1]!, positions[src * 3 + 2]!);
			outNrm.push(normals[src * 3]!, normals[src * 3 + 1]!, normals[src * 3 + 2]!);
		}
		outIdx[n] = dst;
	}

	return {
		positions: new Float32Array(outPos),
		normals: new Float32Array(outNrm),
		indices: outIdx,
		voxelSize: voxel,
		bounds,
		triangles: kept.length / 3,
	};
}
