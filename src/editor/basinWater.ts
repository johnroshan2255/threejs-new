import * as THREE from "three";
import type { TerrainSculptTarget } from "./TerrainSculpt";

/** One terrain grid sample included in a water basin (world XZ). */
export type BasinCellSpec = {
	x: number;
	z: number;
};

/**
 * Serializable basin footprint — saved in paint-water ops for localStorage / DB / multiplayer.
 * Water is rebuilt ONLY from these cells (never a world-wide flood fill).
 */
export type BasinSpec = {
	waterY: number;
	centerX: number;
	centerZ: number;
	width: number;
	depth: number;
	cells: Array<{ x: number; z: number }>;
	/** If set, peers/reload should dig this radius before placing water. */
	digRadius?: number;
};

export type BasinFootprint = BasinSpec & {
	geometry: THREE.BufferGeometry;
};

type GridHelpers = {
	half: number;
	cell: number;
	nrows: number;
	ncols: number;
	size: number;
	heights: Float32Array;
	toCol: (x: number) => number;
	toRow: (z: number) => number;
	idx: (row: number, col: number) => number;
	worldOf: (row: number, col: number) => { x: number; z: number };
};

function gridHelpers(target: TerrainSculptTarget): GridHelpers {
	const { heights, nrows, ncols, size } = target;
	const half = size * 0.5;
	const cell = size / ncols;
	return {
		half,
		cell,
		nrows,
		ncols,
		size,
		heights,
		toCol: (x) =>
			THREE.MathUtils.clamp(Math.round(((x + half) / size) * ncols), 0, ncols),
		toRow: (z) =>
			THREE.MathUtils.clamp(Math.round(((z + half) / size) * nrows), 0, nrows),
		idx: (row, col) => row + col * (nrows + 1),
		worldOf: (row, col) => ({
			x: -half + (col / ncols) * size,
			z: -half + (row / nrows) * size,
		}),
	};
}

function footprintFromCells(
	cells: BasinCellSpec[],
	waterY: number,
	cellSize: number
): BasinFootprint | null {
	if (cells.length < 3) return null;

	let minX = Infinity;
	let maxX = -Infinity;
	let minZ = Infinity;
	let maxZ = -Infinity;
	for (const c of cells) {
		minX = Math.min(minX, c.x);
		maxX = Math.max(maxX, c.x);
		minZ = Math.min(minZ, c.z);
		maxZ = Math.max(maxZ, c.z);
	}

	const centerX = (minX + maxX) * 0.5;
	const centerZ = (minZ + maxZ) * 0.5;
	// Slight overlap so the basin fill has no grid gaps.
	const halfCell = cellSize * 0.56;
	const spanX = Math.max(maxX - minX, cellSize);
	const spanZ = Math.max(maxZ - minZ, cellSize);

	const positions: number[] = [];
	const uvs: number[] = [];
	const indices: number[] = [];
	let vert = 0;

	const width = Math.max(spanX + cellSize, 4);
	const depth = Math.max(spanZ + cellSize, 4);

	for (const c of cells) {
		const x0 = c.x - halfCell - centerX;
		const x1 = c.x + halfCell - centerX;
		const z0 = c.z - halfCell - centerZ;
		const z1 = c.z + halfCell - centerZ;
		// Quad on XZ with +Y normals (CCW when viewed from above).
		positions.push(x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0);

		// Match PlaneGeometry + rotateX(-PI/2) UVs used by RippleSimulation.worldToUv.
		const u0 = x0 / width + 0.5;
		const u1 = x1 / width + 0.5;
		const v0 = 0.5 - z0 / depth;
		const v1 = 0.5 - z1 / depth;
		uvs.push(u0, v0, u0, v1, u1, v1, u1, v0);

		indices.push(vert, vert + 1, vert + 2, vert, vert + 2, vert + 3);
		vert += 4;
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute(
		"position",
		new THREE.Float32BufferAttribute(positions, 3)
	);
	geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
	geometry.setIndex(indices);
	geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();

	return {
		geometry,
		waterY,
		centerX,
		centerZ,
		width,
		depth,
		cells,
	};
}

/**
 * Collect wet cells strictly inside a dig radius (after digPondBasin).
 * Never walks the whole map.
 */
export function collectBasinInsideRadius(
	target: TerrainSculptTarget,
	worldX: number,
	worldZ: number,
	pondRadius: number,
	waterY: number
): BasinFootprint | null {
	const g = gridHelpers(target);
	const radius = Math.max(2, pondRadius);
	const radiusSq = radius * radius;
	const cells: BasinCellSpec[] = [];

	const minCol = g.toCol(worldX - radius - g.cell);
	const maxCol = g.toCol(worldX + radius + g.cell);
	const minRow = g.toRow(worldZ - radius - g.cell);
	const maxRow = g.toRow(worldZ + radius + g.cell);

	for (let col = minCol; col <= maxCol; col++) {
		for (let row = minRow; row <= maxRow; row++) {
			const w = g.worldOf(row, col);
			const dx = w.x - worldX;
			const dz = w.z - worldZ;
			if (dx * dx + dz * dz > radiusSq) continue;
			const h = g.heights[g.idx(row, col)];
			if (h >= waterY + 0.02) continue;
			cells.push({ x: w.x, z: w.z });
		}
	}

	return footprintFromCells(cells, waterY, g.cell);
}

/**
 * Flood-fill a depression, hard-capped to maxRadius from the click.
 * Used when the user already sculpted a basin and clicks inside it.
 */
export function collectBasinNearClick(
	target: TerrainSculptTarget,
	worldX: number,
	worldZ: number,
	maxRadius: number
): BasinFootprint | null {
	const g = gridHelpers(target);
	const maxR = Math.max(4, Math.min(maxRadius, 80));
	const maxRSq = maxR * maxR;
	const maxCells = Math.min(4000, Math.ceil(Math.PI * (maxR / g.cell) ** 2) + 8);

	const startCol = g.toCol(worldX);
	const startRow = g.toRow(worldZ);
	const startH = g.heights[g.idx(startRow, startCol)];

	// Sample rim height outside the hole so water can fill to the bank top.
	const rimSamples: number[] = [];
	const ring = maxR * 1.05;
	for (let i = 0; i < 32; i++) {
		const a = (i / 32) * Math.PI * 2;
		const sx = worldX + Math.cos(a) * ring;
		const sz = worldZ + Math.sin(a) * ring;
		rimSamples.push(g.heights[g.idx(g.toRow(sz), g.toCol(sx))]);
	}
	rimSamples.sort((a, b) => a - b);
	const rimY = rimSamples[Math.floor(rimSamples.length * 0.7)]!;
	// Fill almost to the rim — leave a tiny freeboard so water doesn't spill.
	const waterY = rimY - 0.02;

	// Click must actually be in a hole, not flat ground.
	if (startH > waterY - 0.25) return null;

	const visited = new Uint8Array((g.nrows + 1) * (g.ncols + 1));
	const cells: BasinCellSpec[] = [];
	const queue: Array<{ row: number; col: number }> = [
		{ row: startRow, col: startCol },
	];
	visited[g.idx(startRow, startCol)] = 1;

	const dirs = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
	] as const;

	while (queue.length && cells.length < maxCells) {
		const cur = queue.pop()!;
		const w = g.worldOf(cur.row, cur.col);
		const dx = w.x - worldX;
		const dz = w.z - worldZ;
		if (dx * dx + dz * dz > maxRSq) continue;

		const h = g.heights[g.idx(cur.row, cur.col)];
		// Include bank cells right up to the waterline.
		if (h >= waterY + 0.02) continue;
		cells.push({ x: w.x, z: w.z });

		for (const [dr, dc] of dirs) {
			const nr = cur.row + dr;
			const nc = cur.col + dc;
			if (nr < 0 || nc < 0 || nr > g.nrows || nc > g.ncols) continue;
			const ni = g.idx(nr, nc);
			if (visited[ni]) continue;
			const nw = g.worldOf(nr, nc);
			const ndx = nw.x - worldX;
			const ndz = nw.z - worldZ;
			if (ndx * ndx + ndz * ndz > maxRSq) continue;
			if (g.heights[ni] >= waterY + 0.02) continue;
			visited[ni] = 1;
			queue.push({ row: nr, col: nc });
		}
	}

	return footprintFromCells(cells, waterY, g.cell);
}

/**
 * Raise water nearly to the surrounding rim and expand wet cells to that shoreline.
 * Used when replaying older basin specs that left dry banks.
 */
export function refillBasinToRim(
	target: TerrainSculptTarget,
	spec: BasinSpec,
	maxRadius: number
): BasinFootprint | null {
	const g = gridHelpers(target);
	const cx = spec.centerX;
	const cz = spec.centerZ;
	const radius = Math.max(4, maxRadius);
	const rimSamples: number[] = [];
	const ring = radius * 1.05;
	for (let i = 0; i < 32; i++) {
		const a = (i / 32) * Math.PI * 2;
		const sx = cx + Math.cos(a) * ring;
		const sz = cz + Math.sin(a) * ring;
		rimSamples.push(g.heights[g.idx(g.toRow(sz), g.toCol(sx))]);
	}
	rimSamples.sort((a, b) => a - b);
	const rimY = rimSamples[Math.floor(rimSamples.length * 0.7)]!;
	const waterY = Math.max(spec.waterY, rimY - 0.02);

	const expanded = collectBasinInsideRadius(target, cx, cz, radius * 1.55, waterY);
	if (expanded && expanded.cells.length >= spec.cells.length) {
		return expanded;
	}

	// Fallback: keep cells, just raise the water surface.
	return footprintFromCells(spec.cells, waterY, g.cell);
}

/** Rebuild mesh from a saved BasinSpec (multiplayer / DB replay). */
export function footprintFromBasinSpec(spec: BasinSpec, cellSize = 1): BasinFootprint | null {
	return footprintFromCells(spec.cells, spec.waterY, cellSize);
}

export function basinSpecFromFootprint(
	fp: BasinFootprint,
	digRadius?: number
): BasinSpec {
	return {
		waterY: fp.waterY,
		centerX: fp.centerX,
		centerZ: fp.centerZ,
		width: fp.width,
		depth: fp.depth,
		cells: fp.cells.map((c) => ({ x: c.x, z: c.z })),
		digRadius,
	};
}
