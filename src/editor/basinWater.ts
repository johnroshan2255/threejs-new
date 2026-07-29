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
 * Dense plane clipped to an expanded basin outline.
 * Interior verts are required so ripple heightfield displacement shows waves
 * (outline-only triangulation had almost no verts → flat water).
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

	// Push water past the dug banks so the rim hides the edge.
	const smoothed = chaikinClosed(ring, 3);
	const expand = Math.max(2.0, cellSize * 2.4);
	const fill = offsetRing(smoothed, -expand);
	if (fill.length < 3 || ringArea(fill) < 0) return null;

	const segs = Math.min(
		96,
		Math.max(40, Math.round(Math.max(width, depth) * 1.6))
	);
	const geometry = new THREE.PlaneGeometry(width, depth, segs, segs);
	geometry.rotateX(-Math.PI / 2);

	const positions = geometry.attributes.position as THREE.BufferAttribute;
	const shores = new Float32Array(positions.count);
	const localPoly = fill.map((p) => ({
		x: p.x - centerX,
		z: p.z - centerZ,
	}));

	for (let i = 0; i < positions.count; i++) {
		const lx = positions.getX(i);
		const lz = positions.getZ(i);
		const inside = pointInPolyXZ(lx, lz, localPoly);
		if (!inside) {
			shores[i] = 0;
			continue;
		}
		const dist = distToPolyEdge(lx, lz, localPoly);
		// Soft band near edge; interior stays fully wet for waves.
		const soft = Math.max(0.35, cellSize * 0.45);
		shores[i] = THREE.MathUtils.clamp(dist / soft, 0, 1);
		if (shores[i]! < 0.15) shores[i] = 0.15; // keep slightly opaque at rim
	}

	geometry.setAttribute("aShore", new THREE.Float32BufferAttribute(shores, 1));
	geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	return geometry;
}

function pointInPolyXZ(x: number, z: number, poly: XZ[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i]!.x;
		const zi = poly[i]!.z;
		const xj = poly[j]!.x;
		const zj = poly[j]!.z;
		const intersect =
			zi > z !== zj > z &&
			x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

function distToPolyEdge(x: number, z: number, poly: XZ[]): number {
	let best = Infinity;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i]!;
		const b = poly[(i + 1) % poly.length]!;
		const abx = b.x - a.x;
		const abz = b.z - a.z;
		const apx = x - a.x;
		const apz = z - a.z;
		const ab2 = abx * abx + abz * abz || 1e-8;
		const t = THREE.MathUtils.clamp((apx * abx + apz * abz) / ab2, 0, 1);
		const px = a.x + abx * t;
		const pz = a.z + abz * t;
		best = Math.min(best, Math.hypot(x - px, z - pz));
	}
	return best;
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
	const halfCell = cellSize * 0.95;
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
	// Extra pad: water plane is larger than the dug basin so banks bury the edge.
	const pad = Math.max(4.5, cellSize * 4);
	const width = Math.max(spanX + pad * 2, 4);
	const depth = Math.max(spanZ + pad * 2, 4);

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
 * Collect wet cells strictly from brush stamps (exact painted shape).
 * Does not flood-fill hills/flats — only grid samples under the pencil path.
 */
export function collectBasinFromBrushStamps(
	target: TerrainSculptTarget,
	stamps: Array<{ x: number; z: number; radius: number }>
): BasinFootprint | null {
	if (!stamps.length) return null;
	const g = gridHelpers(target);
	const cellMap = new Map<string, BasinCellSpec>();

	for (const stamp of stamps) {
		const r = Math.max(0.1, stamp.radius);
		const rSq = r * r;
		const minCol = g.toCol(stamp.x - r - g.cell);
		const maxCol = g.toCol(stamp.x + r + g.cell);
		const minRow = g.toRow(stamp.z - r - g.cell);
		const maxRow = g.toRow(stamp.z + r + g.cell);
		for (let col = minCol; col <= maxCol; col++) {
			for (let row = minRow; row <= maxRow; row++) {
				const w = g.worldOf(row, col);
				const dx = w.x - stamp.x;
				const dz = w.z - stamp.z;
				if (dx * dx + dz * dz > rSq) continue;
				cellMap.set(pk(w.x, w.z), { x: w.x, z: w.z });
			}
		}
	}

	const cells = [...cellMap.values()];
	if (cells.length < 3) return null;

	// Rim height from neighbors just outside the painted set.
	const inSet = new Set(cells.map((c) => pk(c.x, c.z)));
	const rimSamples: number[] = [];
	const dirs = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
	] as const;
	for (const c of cells) {
		const col = g.toCol(c.x);
		const row = g.toRow(c.z);
		for (const [dr, dc] of dirs) {
			const nr = row + dr;
			const nc = col + dc;
			if (nr < 0 || nc < 0 || nr > g.nrows || nc > g.ncols) continue;
			const w = g.worldOf(nr, nc);
			if (inSet.has(pk(w.x, w.z))) continue;
			rimSamples.push(g.heights[g.idx(nr, nc)]);
		}
	}

	let waterY: number;
	if (rimSamples.length) {
		rimSamples.sort((a, b) => a - b);
		// Sit below the rim so expanded water width reads as a filled pool.
		waterY = rimSamples[Math.floor(rimSamples.length * 0.5)]! - 0.32;
	} else {
		let maxH = -Infinity;
		for (const c of cells) {
			maxH = Math.max(maxH, g.heights[g.idx(g.toRow(c.z), g.toCol(c.x))]);
		}
		waterY = maxH - 0.2;
	}

	const wet = cells.filter((c) => {
		const h = g.heights[g.idx(g.toRow(c.z), g.toCol(c.x))];
		return h < waterY + 0.12;
	});
	const finalCells = wet.length >= 3 ? wet : cells;
	return footprintFromCells(finalCells, waterY, g.cell);
}

/**
 * Same as collectBasinFromBrushStamps, but one footprint per connected blob
 * so separate lakes stay separate while overlapping strokes merge.
 */
export function collectBasinsFromBrushStamps(
	target: TerrainSculptTarget,
	stamps: Array<{ x: number; z: number; radius: number }>
): BasinFootprint[] {
	const combined = collectBasinFromBrushStamps(target, stamps);
	if (!combined) return [];
	const g = gridHelpers(target);
	const components = splitConnectedCellGroups(combined.cells, g);
	const out: BasinFootprint[] = [];
	for (const group of components) {
		if (group.length < 3) continue;
		const fp = footprintFromCells(group, combined.waterY, g.cell);
		if (fp) out.push(fp);
	}
	return out.length ? out : [combined];
}

function splitConnectedCellGroups(
	cells: BasinCellSpec[],
	g: GridHelpers
): BasinCellSpec[][] {
	const keyOf = (row: number, col: number) => `${row},${col}`;
	const cellByKey = new Map<string, BasinCellSpec>();
	for (const c of cells) {
		cellByKey.set(keyOf(g.toRow(c.z), g.toCol(c.x)), c);
	}
	const visited = new Set<string>();
	const groups: BasinCellSpec[][] = [];
	const dirs = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
		[1, 1],
		[1, -1],
		[-1, 1],
		[-1, -1],
	] as const;

	for (const [startKey, startCell] of cellByKey) {
		if (visited.has(startKey)) continue;
		const group: BasinCellSpec[] = [];
		const queue = [startKey];
		visited.add(startKey);
		while (queue.length) {
			const key = queue.pop()!;
			const cell = cellByKey.get(key);
			if (!cell) continue;
			group.push(cell);
			const row = g.toRow(cell.z);
			const col = g.toCol(cell.x);
			for (const [dr, dc] of dirs) {
				const nk = keyOf(row + dr, col + dc);
				if (visited.has(nk) || !cellByKey.has(nk)) continue;
				visited.add(nk);
				queue.push(nk);
			}
		}
		groups.push(group);
	}
	return groups;
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
	const radius = pondRadius;
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
	const maxR = Math.min(maxRadius, 80);
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
	const radius = maxRadius;
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
