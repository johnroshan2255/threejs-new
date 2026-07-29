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

type XZ = { x: number; z: number };

function pk(x: number, z: number): string {
	return `${Math.round(x * 1000)},${Math.round(z * 1000)}`;
}

function ek(a: XZ, b: XZ): string {
	const ka = pk(a.x, a.z);
	const kb = pk(b.x, b.z);
	return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/** Signed area on XZ (positive ≈ CCW when viewed from +Y). */
function ringArea(pts: XZ[]): number {
	let a = 0;
	for (let i = 0; i < pts.length; i++) {
		const p = pts[i]!;
		const q = pts[(i + 1) % pts.length]!;
		a += p.x * q.z - q.x * p.z;
	}
	return a * 0.5;
}

function chaikinClosed(pts: XZ[], iterations: number): XZ[] {
	let cur = pts;
	for (let n = 0; n < iterations; n++) {
		if (cur.length < 3) break;
		const next: XZ[] = [];
		for (let i = 0; i < cur.length; i++) {
			const p0 = cur[i]!;
			const p1 = cur[(i + 1) % cur.length]!;
			next.push({
				x: p0.x * 0.75 + p1.x * 0.25,
				z: p0.z * 0.75 + p1.z * 0.25,
			});
			next.push({
				x: p0.x * 0.25 + p1.x * 0.75,
				z: p0.z * 0.25 + p1.z * 0.75,
			});
		}
		cur = next;
	}
	return cur;
}

/** Offset polygon along averaged edge normals. Positive dist = inward for CCW rings. */
function offsetRing(pts: XZ[], dist: number): XZ[] {
	const n = pts.length;
	if (n < 3) return pts.slice();
	const out: XZ[] = [];
	for (let i = 0; i < n; i++) {
		const prev = pts[(i - 1 + n) % n]!;
		const curr = pts[i]!;
		const next = pts[(i + 1) % n]!;
		const e1x = curr.x - prev.x;
		const e1z = curr.z - prev.z;
		const e2x = next.x - curr.x;
		const e2z = next.z - curr.z;
		const l1 = Math.hypot(e1x, e1z) || 1;
		const l2 = Math.hypot(e2x, e2z) || 1;
		// Left normals of CCW edges point inward.
		let nx = -e1z / l1 - e2z / l2;
		let nz = e1x / l1 + e2x / l2;
		const nl = Math.hypot(nx, nz) || 1;
		nx /= nl;
		nz /= nl;
		out.push({ x: curr.x + nx * dist, z: curr.z + nz * dist });
	}
	return out;
}

function stitchBoundaryLoops(
	edges: Array<{ a: XZ; b: XZ }>
): XZ[][] {
	const adj = new Map<string, XZ[]>();
	const pts = new Map<string, XZ>();
	const link = (p: XZ, q: XZ) => {
		const k = pk(p.x, p.z);
		pts.set(k, p);
		let list = adj.get(k);
		if (!list) {
			list = [];
			adj.set(k, list);
		}
		list.push(q);
	};
	for (const e of edges) {
		link(e.a, e.b);
		link(e.b, e.a);
	}

	const used = new Set<string>();
	const loops: XZ[][] = [];

	for (const start of pts.values()) {
		const startN = adj.get(pk(start.x, start.z)) ?? [];
		for (const first of startN) {
			if (used.has(ek(start, first))) continue;
			const loop: XZ[] = [start];
			let prev = start;
			let curr = first;
			used.add(ek(prev, curr));
			let guard = 0;
			while (guard++ < edges.length + 4) {
				if (pk(curr.x, curr.z) === pk(start.x, start.z)) break;
				loop.push(curr);
				const nexts = adj.get(pk(curr.x, curr.z)) ?? [];
				let next: XZ | null = null;
				for (const cand of nexts) {
					if (pk(cand.x, cand.z) === pk(prev.x, prev.z)) continue;
					if (used.has(ek(curr, cand))) continue;
					next = cand;
					break;
				}
				if (!next) break;
				used.add(ek(curr, next));
				prev = curr;
				curr = next;
			}
			if (loop.length >= 3) loops.push(loop);
		}
	}
	return loops;
}

/**
 * Smooth shoreline mesh: Chaikin-rounded outline + soft alpha rim (no grid stairs).
 * Falls back to cell quads if outline extraction fails.
 */
function geometryFromSmoothedShore(
	cells: BasinCellSpec[],
	cellSize: number,
	centerX: number,
	centerZ: number,
	width: number,
	depth: number
): THREE.BufferGeometry | null {
	const half = cellSize * 0.5;
	const edgeCount = new Map<string, { a: XZ; b: XZ; n: number }>();
	const addEdge = (x0: number, z0: number, x1: number, z1: number) => {
		const a = { x: x0, z: z0 };
		const b = { x: x1, z: z1 };
		const k = ek(a, b);
		const e = edgeCount.get(k);
		if (e) e.n += 1;
		else edgeCount.set(k, { a, b, n: 1 });
	};

	for (const c of cells) {
		const x0 = c.x - half;
		const x1 = c.x + half;
		const z0 = c.z - half;
		const z1 = c.z + half;
		addEdge(x0, z0, x0, z1);
		addEdge(x0, z1, x1, z1);
		addEdge(x1, z1, x1, z0);
		addEdge(x1, z0, x0, z0);
	}

	const boundary: Array<{ a: XZ; b: XZ }> = [];
	for (const e of edgeCount.values()) {
		if (e.n === 1) boundary.push({ a: e.a, b: e.b });
	}
	if (boundary.length < 3) return null;

	const loops = stitchBoundaryLoops(boundary);
	if (!loops.length) return null;
	loops.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
	let ring = loops[0]!;
	if (ring.length < 3) return null;
	if (ringArea(ring) < 0) ring = ring.slice().reverse();

	// Round off stair-steps, then build a soft fade band into the mud.
	const smoothed = chaikinClosed(ring, 3);
	const soft = Math.max(0.4, cellSize * 0.55);
	const outer = offsetRing(smoothed, -soft * 0.45);
	const inner = offsetRing(smoothed, soft * 0.7);
	if (outer.length < 3 || inner.length < 3) return null;
	if (ringArea(inner) < 0) return null;

	const positions: number[] = [];
	const uvs: number[] = [];
	const shores: number[] = [];
	const indices: number[] = [];

	const pushVert = (p: XZ, shore: number) => {
		const lx = p.x - centerX;
		const lz = p.z - centerZ;
		positions.push(lx, 0, lz);
		uvs.push(lx / width + 0.5, 0.5 - lz / depth);
		shores.push(shore);
		return shores.length - 1;
	};

	const innerIdx: number[] = [];
	for (const p of inner) innerIdx.push(pushVert(p, 1));
	const outerIdx: number[] = [];
	for (const p of outer) outerIdx.push(pushVert(p, 0));

	const contour = inner.map((p) => new THREE.Vector2(p.x - centerX, p.z - centerZ));
	let faces: number[][];
	try {
		faces = THREE.ShapeUtils.triangulateShape(contour, []);
	} catch {
		return null;
	}
	if (!faces.length) return null;
	for (const face of faces) {
		const a = face[0]!;
		const b = face[1]!;
		const c = face[2]!;
		// ShapeUtils winding in XY → map to XZ with +Y up.
		indices.push(innerIdx[a]!, innerIdx[c]!, innerIdx[b]!);
	}

	const n = Math.min(innerIdx.length, outerIdx.length);
	for (let i = 0; i < n; i++) {
		const i0 = innerIdx[i]!;
		const i1 = innerIdx[(i + 1) % n]!;
		const o0 = outerIdx[i]!;
		const o1 = outerIdx[(i + 1) % n]!;
		indices.push(i0, o0, o1);
		indices.push(i0, o1, i1);
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute(
		"position",
		new THREE.Float32BufferAttribute(positions, 3)
	);
	geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
	geometry.setAttribute("aShore", new THREE.Float32BufferAttribute(shores, 1));
	geometry.setIndex(indices);
	geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	return geometry;
}

/** Legacy cell-quad mesh (pixelated) — only used if outline smoothing fails. */
function geometryFromCellQuads(
	cells: BasinCellSpec[],
	cellSize: number,
	centerX: number,
	centerZ: number,
	width: number,
	depth: number
): THREE.BufferGeometry {
	const halfCell = cellSize * 0.56;
	const positions: number[] = [];
	const uvs: number[] = [];
	const shores: number[] = [];
	const indices: number[] = [];
	let vert = 0;

	for (const c of cells) {
		const x0 = c.x - halfCell - centerX;
		const x1 = c.x + halfCell - centerX;
		const z0 = c.z - halfCell - centerZ;
		const z1 = c.z + halfCell - centerZ;
		positions.push(x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0);
		const u0 = x0 / width + 0.5;
		const u1 = x1 / width + 0.5;
		const v0 = 0.5 - z0 / depth;
		const v1 = 0.5 - z1 / depth;
		uvs.push(u0, v0, u0, v1, u1, v1, u1, v0);
		shores.push(1, 1, 1, 1);
		indices.push(vert, vert + 1, vert + 2, vert, vert + 2, vert + 3);
		vert += 4;
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute(
		"position",
		new THREE.Float32BufferAttribute(positions, 3)
	);
	geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
	geometry.setAttribute("aShore", new THREE.Float32BufferAttribute(shores, 1));
	geometry.setIndex(indices);
	geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	return geometry;
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
	const spanX = Math.max(maxX - minX, cellSize);
	const spanZ = Math.max(maxZ - minZ, cellSize);
	// Extra pad so the soft outer rim stays inside the sim UV / AABB.
	const softPad = Math.max(0.4, cellSize * 0.55) * 1.2;
	const width = Math.max(spanX + cellSize + softPad * 2, 4);
	const depth = Math.max(spanZ + cellSize + softPad * 2, 4);

	const geometry =
		geometryFromSmoothedShore(
			cells,
			cellSize,
			centerX,
			centerZ,
			width,
			depth
		) ?? geometryFromCellQuads(cells, cellSize, centerX, centerZ, width, depth);

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
