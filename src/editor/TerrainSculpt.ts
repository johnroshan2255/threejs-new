import * as THREE from "three";
import {
	caveMouthRuns,
	createHeightSampler,
	mouthAnchor,
	punchDilate,
	sampleCaveSpine,
	terrainCellSize,
	type CaveNode,
} from "../terrain/caveShape";

export type SculptBrush = "raise" | "lower" | "smooth" | "flatten";

export type TerrainSculptTarget = {
	mesh: THREE.Mesh;
	heights: Float32Array;
	nrows: number;
	ncols: number;
	size: number;
	deferUpdate?: boolean;
};

/**
 * The patch of terrain a brush actually touched, in world units.
 *
 * Passing this to `flushTerrainUpdate` is what keeps a brush stroke cheap — see
 * the note there.
 */
export type TerrainRegion = {
	/** Brush centre. */
	x: number;
	z: number;
	/** World-space radius affected. */
	radius: number;
	/** Grid segments per side; vertices per side is `segs + 1`. */
	segs: number;
	/** Terrain extent on X/Z. */
	size: number;
};

// Scratch vectors — this runs per face, so it must not allocate.
const _pA = /*#__PURE__*/ new THREE.Vector3();
const _pB = /*#__PURE__*/ new THREE.Vector3();
const _pC = /*#__PURE__*/ new THREE.Vector3();
const _cb = /*#__PURE__*/ new THREE.Vector3();
const _ab = /*#__PURE__*/ new THREE.Vector3();
const _pt = /*#__PURE__*/ new THREE.Vector3();

/**
 * `computeVertexNormals`, restricted to the grid cells a brush touched.
 *
 * Terrain is a `PlaneGeometry(size, size, segs, segs)` rotated flat, so vertex
 * `(col, row)` lives at `col + row * (segs + 1)` and cell `(c, r)` is the two
 * triangles `(a,b,d)` and `(b,c,d)` — the same layout three builds. That makes
 * the affected faces pure index arithmetic instead of a scan of all 129k
 * triangles.
 *
 * Face normals are accumulated unnormalised, exactly as three does, so the patch
 * is bit-identical to a full recompute and leaves no seam against untouched
 * terrain.
 *
 * Returns false if the geometry is not the grid this assumes, so the caller can
 * fall back to the full recompute.
 */
function recomputeNormalsRegion(
	geometry: THREE.BufferGeometry,
	region: TerrainRegion
): boolean {
	const index = geometry.index;
	const pos = geometry.attributes.position as THREE.BufferAttribute | undefined;
	const nrm = geometry.attributes.normal as THREE.BufferAttribute | undefined;
	if (!index || !pos || !nrm) return false;

	const { segs, size } = region;
	const gridX1 = segs + 1;
	if (pos.count !== gridX1 * gridX1) return false;

	const half = size * 0.5;
	const cell = size / segs;
	const toGrid = (world: number) => (world + half) / cell;

	// Vertices the brush moved.
	const mc0 = Math.floor(toGrid(region.x - region.radius));
	const mc1 = Math.ceil(toGrid(region.x + region.radius));
	const mr0 = Math.floor(toGrid(region.z - region.radius));
	const mr1 = Math.ceil(toGrid(region.z + region.radius));

	// Moving a vertex also changes its neighbours' normals, so widen by one.
	const vc0 = Math.max(0, mc0 - 1);
	const vc1 = Math.min(segs, mc1 + 1);
	const vr0 = Math.max(0, mr0 - 1);
	const vr1 = Math.min(segs, mr1 + 1);
	if (vc0 > vc1 || vr0 > vr1) return true; // brush is off the grid

	const nArr = nrm.array as Float32Array;

	for (let r = vr0; r <= vr1; r++) {
		const rowBase = r * gridX1;
		for (let c = vc0; c <= vc1; c++) {
			const o = (rowBase + c) * 3;
			nArr[o] = 0;
			nArr[o + 1] = 0;
			nArr[o + 2] = 0;
		}
	}

	// Every cell touching a rebuilt vertex, which is one further out on the low
	// side. Vertices inside [vc0..vc1] x [vr0..vr1] then see all of their
	// adjacent faces, which is what makes the result exact.
	const cc0 = Math.max(0, vc0 - 1);
	const cc1 = Math.min(segs - 1, vc1);
	const cr0 = Math.max(0, vr0 - 1);
	const cr1 = Math.min(segs - 1, vr1);

	const addFace = (ia: number, ib: number, ic: number) => {
		_pA.fromBufferAttribute(pos, ia);
		_pB.fromBufferAttribute(pos, ib);
		_pC.fromBufferAttribute(pos, ic);
		_cb.subVectors(_pC, _pB);
		_ab.subVectors(_pA, _pB);
		_cb.cross(_ab);

		for (let k = 0; k < 3; k++) {
			const i = k === 0 ? ia : k === 1 ? ib : ic;
			const c = i % gridX1;
			const r = (i / gridX1) | 0;
			// Vertices outside the window keep the normals they already have.
			if (c < vc0 || c > vc1 || r < vr0 || r > vr1) continue;
			const o = i * 3;
			nArr[o] += _cb.x;
			nArr[o + 1] += _cb.y;
			nArr[o + 2] += _cb.z;
		}
	};

	for (let r = cr0; r <= cr1; r++) {
		for (let c = cc0; c <= cc1; c++) {
			const a = c + gridX1 * r;
			const b = c + gridX1 * (r + 1);
			const d = c + 1 + gridX1 * r;
			const e = c + 1 + gridX1 * (r + 1);
			addFace(a, b, d);
			addFace(b, e, d);
		}
	}

	for (let r = vr0; r <= vr1; r++) {
		const rowBase = r * gridX1;
		for (let c = vc0; c <= vc1; c++) {
			const o = (rowBase + c) * 3;
			const x = nArr[o]!;
			const y = nArr[o + 1]!;
			const z = nArr[o + 2]!;
			const len = Math.sqrt(x * x + y * y + z * z);
			if (len > 0) {
				const inv = 1 / len;
				nArr[o] = x * inv;
				nArr[o + 1] = y * inv;
				nArr[o + 2] = z * inv;
			}
		}
	}

	nrm.needsUpdate = true;

	// Bounds: grow to cover the patch rather than rescanning 65k vertices.
	// Conservative is fine — these only drive culling and raycast early-out.
	if (geometry.boundingBox) {
		for (let r = vr0; r <= vr1; r++) {
			const rowBase = r * gridX1;
			for (let c = vc0; c <= vc1; c++) {
				_pt.fromBufferAttribute(pos, rowBase + c);
				geometry.boundingBox.expandByPoint(_pt);
			}
		}
		if (geometry.boundingSphere) {
			geometry.boundingBox.getBoundingSphere(geometry.boundingSphere);
		}
	}

	return true;
}

/**
 * Push terrain edits through to normals, bounds and the raycast BVH.
 *
 * Without `region` this rescans the whole mesh, which on the 254-segment terrain
 * measured **17.7 ms per brush dab** — 12.6 ms of it `computeVertexNormals` —
 * and cost the same whether the brush radius was 2 m or 40 m, because every step
 * was O(all 129k triangles) no matter how little moved.
 *
 * With `region` only the touched cells are rebuilt. The BVH refit stays: the
 * brush raycasts against it every dab, so letting it go stale makes the cursor
 * drift off the surface it is editing.
 */
export function flushTerrainUpdate(mesh: THREE.Mesh, region?: TerrainRegion) {
	const geometry = mesh.geometry as THREE.BufferGeometry;

	if (!region || !recomputeNormalsRegion(geometry, region)) {
		geometry.computeVertexNormals();
		geometry.computeBoundingBox();
		geometry.computeBoundingSphere();
	}

	if (geometry.boundsTree) geometry.boundsTree.refit();
	mesh.updateMatrixWorld(true);
}

/**
 * Apply a sculpt brush at world (x, z). Mutates mesh Y and heightfield samples.
 */
export function applyTerrainBrush(
	target: TerrainSculptTarget,
	worldX: number,
	worldZ: number,
	brush: SculptBrush,
	radius: number,
	strength: number,
	deferUpdate = false
) {
	const { mesh, heights, nrows, ncols, size } = target;
	const geometry = mesh.geometry as THREE.BufferGeometry;
	const positions = geometry.attributes.position as THREE.BufferAttribute;
	const half = size * 0.5;
	const radiusSq = radius * radius;
	const invRadius = 1 / Math.max(radius, 0.0001);

	let flattenHeight = 0;
	let flattenWeight = 0;
	if (brush === "flatten" || brush === "smooth") {
		for (let i = 0; i < positions.count; i++) {
			const dx = positions.getX(i) - worldX;
			const dz = positions.getZ(i) - worldZ;
			const d2 = dx * dx + dz * dz;
			if (d2 > radiusSq) continue;
			const w = 1 - Math.sqrt(d2) * invRadius;
			flattenHeight += positions.getY(i) * w;
			flattenWeight += w;
		}
		if (flattenWeight > 0) flattenHeight /= flattenWeight;
	}

	for (let i = 0; i < positions.count; i++) {
		const x = positions.getX(i);
		const z = positions.getZ(i);
		const dx = x - worldX;
		const dz = z - worldZ;
		const d2 = dx * dx + dz * dz;
		if (d2 > radiusSq) continue;

		const t = 1 - Math.sqrt(d2) * invRadius;
		const falloff = t * t * (3 - 2 * t);
		const y = positions.getY(i);
		let next = y;

		if (brush === "raise") next = y + strength * falloff;
		else if (brush === "lower") next = y - strength * falloff;
		else if (brush === "smooth") next = THREE.MathUtils.lerp(y, flattenHeight, strength * 0.35 * falloff);
		else if (brush === "flatten") next = THREE.MathUtils.lerp(y, flattenHeight, strength * 0.55 * falloff);

		positions.setY(i, next);
	}

	// Keep Rapier heightfield in sync (same XZ sampling grid).
	for (let col = 0; col <= ncols; col++) {
		for (let row = 0; row <= nrows; row++) {
			const x = -half + (col / ncols) * size;
			const z = -half + (row / nrows) * size;
			const dx = x - worldX;
			const dz = z - worldZ;
			const d2 = dx * dx + dz * dz;
			if (d2 > radiusSq) continue;

			const t = 1 - Math.sqrt(d2) * invRadius;
			const falloff = t * t * (3 - 2 * t);
			const index = row + col * (nrows + 1);
			const y = heights[index];
			let next = y;

			if (brush === "raise") next = y + strength * falloff;
			else if (brush === "lower") next = y - strength * falloff;
			else if (brush === "smooth") next = THREE.MathUtils.lerp(y, flattenHeight, strength * 0.35 * falloff);
			else if (brush === "flatten") next = THREE.MathUtils.lerp(y, flattenHeight, strength * 0.55 * falloff);

			heights[index] = next;
		}
	}

	positions.needsUpdate = true;
	if (!target.deferUpdate && !deferUpdate) {
		flushTerrainUpdate(mesh, {
			x: worldX,
			z: worldZ,
			radius,
			segs: ncols,
			size,
		});
	}
}

/** Soft water basin for brush painting (~0.8 m deep, wide gentle banks). */
export function digWaterBrush(
	target: TerrainSculptTarget,
	worldX: number,
	worldZ: number,
	radius: number,
	deferUpdate = false
) {
	const { mesh, heights, nrows, ncols, size } = target;
	const geometry = mesh.geometry as THREE.BufferGeometry;
	const positions = geometry.attributes.position as THREE.BufferAttribute;
	const half = size * 0.5;
	const depth = 0.8;
	// Wide bank so cliff faces tilt up (less “open shell” look from outside).
	const inner = radius * 0.55;
	const outer = radius * 2.1;

	const smootherstep = (t: number) => {
		const x = THREE.MathUtils.clamp(t, 0, 1);
		return x * x * x * (x * (x * 6 - 15) + 10);
	};

	const applyAt = (x: number, z: number, y: number) => {
		const dist = Math.hypot(x - worldX, z - worldZ);
		if (dist >= outer) return y;
		if (dist <= inner) {
			const floorT = smootherstep(dist / Math.max(inner, 0.0001));
			const dip = -depth + depth * 0.12 * floorT;
			return Math.min(y, y + dip);
		}
		const bankT = smootherstep((dist - inner) / Math.max(outer - inner, 0.0001));
		const dip = -depth * (1 - bankT);
		return Math.min(y, y + dip);
	};

	for (let i = 0; i < positions.count; i++) {
		positions.setY(i, applyAt(positions.getX(i), positions.getZ(i), positions.getY(i)));
	}
	for (let col = 0; col <= ncols; col++) {
		for (let row = 0; row <= nrows; row++) {
			const x = -half + (col / ncols) * size;
			const z = -half + (row / nrows) * size;
			const index = row + col * (nrows + 1);
			heights[index] = applyAt(x, z, heights[index]);
		}
	}
	positions.needsUpdate = true;
	if (!target.deferUpdate && !deferUpdate) {
		// `outer` is the real reach here, not `radius`.
		flushTerrainUpdate(mesh, { x: worldX, z: worldZ, radius: outer, segs: ncols, size });
	}
}

/** Dig a soft-banked pond basin (rounded sides, no sharp cliffs). */
export function digPondBasin(
	target: TerrainSculptTarget,
	worldX: number,
	worldZ: number,
	pondRadius: number
) {
	const inner = pondRadius * 0.55;
	const outer = pondRadius * 1.65;
	const depth = Math.max(0.3, Math.min(5.2, pondRadius * 0.4));
	const { mesh, heights, nrows, ncols, size } = target;
	const geometry = mesh.geometry as THREE.BufferGeometry;
	const positions = geometry.attributes.position as THREE.BufferAttribute;
	const half = size * 0.5;

	const smootherstep = (t: number) => {
		const x = THREE.MathUtils.clamp(t, 0, 1);
		return x * x * x * (x * (x * 6 - 15) + 10);
	};

	const applyAt = (x: number, z: number, y: number) => {
		const dist = Math.hypot(x - worldX, z - worldZ);
		if (dist >= outer) return y;
		if (dist <= inner) {
			const floorT = smootherstep(dist / Math.max(inner, 0.0001));
			const dip = -depth + depth * 0.22 * floorT;
			return y + dip;
		}
		const bankT = smootherstep((dist - inner) / Math.max(outer - inner, 0.0001));
		const dip = -depth * 0.78 * (1 - bankT);
		return y + dip;
	};

	for (let i = 0; i < positions.count; i++) {
		const x = positions.getX(i);
		const z = positions.getZ(i);
		positions.setY(i, applyAt(x, z, positions.getY(i)));
	}

	for (let col = 0; col <= ncols; col++) {
		for (let row = 0; row <= nrows; row++) {
			const x = -half + (col / ncols) * size;
			const z = -half + (row / nrows) * size;
			const index = row + col * (nrows + 1);
			heights[index] = applyAt(x, z, heights[index]);
		}
	}

	smoothBasinRim(target, worldX, worldZ, outer * 0.72, outer + pondRadius * 0.4);

	positions.needsUpdate = true;
	if (!target.deferUpdate) {
		// Covers the rim smoothing above, which reaches past `outer`.
		flushTerrainUpdate(mesh, {
			x: worldX,
			z: worldZ,
			radius: outer + pondRadius * 0.4,
			segs: ncols,
			size,
		});
	}
}

/** Soften basin banks so edit-mode holes don't look faceted. */
export function smoothBasinRim(
	target: TerrainSculptTarget,
	worldX: number,
	worldZ: number,
	innerRadius: number,
	outerRadius: number,
	passes = 2
) {
	const { mesh, heights, nrows, ncols, size } = target;
	const geometry = mesh.geometry as THREE.BufferGeometry;
	const positions = geometry.attributes.position as THREE.BufferAttribute;
	const half = size * 0.5;
	const innerSq = innerRadius * innerRadius;
	const outerSq = outerRadius * outerRadius;
	const idx = (row: number, col: number) => row + col * (nrows + 1);
	const inRim = (x: number, z: number) => {
		const d2 = (x - worldX) ** 2 + (z - worldZ) ** 2;
		return d2 >= innerSq && d2 <= outerSq;
	};

	for (let pass = 0; pass < passes; pass++) {
		const next = heights.slice();
		for (let col = 1; col < ncols; col++) {
			for (let row = 1; row < nrows; row++) {
				const x = -half + (col / ncols) * size;
				const z = -half + (row / nrows) * size;
				if (!inRim(x, z)) continue;
				const i = idx(row, col);
				const avg =
					(heights[idx(row - 1, col)] +
						heights[idx(row + 1, col)] +
						heights[idx(row, col - 1)] +
						heights[idx(row, col + 1)] +
						heights[i]) /
					5;
				next[i] = THREE.MathUtils.lerp(heights[i], avg, 0.65);
			}
		}
		heights.set(next);
	}

	for (let i = 0; i < positions.count; i++) {
		const x = positions.getX(i);
		const z = positions.getZ(i);
		if (!inRim(x, z)) continue;
		const col = THREE.MathUtils.clamp(
			Math.round(((x + half) / size) * ncols),
			0,
			ncols
		);
		const row = THREE.MathUtils.clamp(
			Math.round(((z + half) / size) * nrows),
			0,
			nrows
		);
		positions.setY(i, heights[idx(row, col)]);
	}
}

/**
 * Sculpt terrain down into a ramp at every place the tunnel breaks the surface.
 *
 * Every place, not just the spine's ends: a tunnel bored through a hill and out
 * the far side surfaces mid-spine, and that opening needs the same ramp as the
 * entrance the author started from.
 */
export function sculptCaveMouths(target: TerrainSculptTarget, nodes: CaveNode[]) {
	if (nodes.length === 0) return;
	const { mesh, heights, nrows, ncols, size } = target;
	const geometry = mesh.geometry as THREE.BufferGeometry;
	const positions = geometry.attributes.position as THREE.BufferAttribute;
	const half = size * 0.5;

	const processMouth = (node: CaveNode) => {
		// Find the original surface height directly above the node
		const fc = THREE.MathUtils.clamp(((node.x + half) / size) * ncols, 0, ncols);
		const fr = THREE.MathUtils.clamp(((node.z + half) / size) * nrows, 0, nrows);
		const index = Math.floor(fr) + Math.floor(fc) * (nrows + 1);
		const surfaceY = heights[index] ?? 0;

		// If the node is completely buried underground, do not carve a sinkhole!
		if (node.y + node.r + 1.5 < surfaceY) return;

		const radius = node.r * 2.0;
		const radiusSq = radius * radius;
		const invRadius = 1 / Math.max(radius, 0.0001);
		// Target height is slightly above the very bottom of the cave sphere
		// to create a nice driving surface entering the tunnel
		const targetHeight = node.y - node.r + 0.3;

		for (let i = 0; i < positions.count; i++) {
			const x = positions.getX(i);
			const z = positions.getZ(i);
			const dx = x - node.x;
			const dz = z - node.z;
			const d2 = dx * dx + dz * dz;
			if (d2 > radiusSq) continue;

			const t = 1 - Math.sqrt(d2) * invRadius;
			const falloff = t * t * (3 - 2 * t);
			const y = positions.getY(i);

			// Only lower the terrain; if the terrain is already lower than the cave floor, leave it.
			if (y > targetHeight) {
				const next = THREE.MathUtils.lerp(y, targetHeight, falloff * 0.95);
				positions.setY(i, next);
			}
		}

		for (let col = 0; col <= ncols; col++) {
			for (let row = 0; row <= nrows; row++) {
				const x = -half + (col / ncols) * size;
				const z = -half + (row / nrows) * size;
				const dx = x - node.x;
				const dz = z - node.z;
				const d2 = dx * dx + dz * dz;
				if (d2 > radiusSq) continue;

				const t = 1 - Math.sqrt(d2) * invRadius;
				const falloff = t * t * (3 - 2 * t);
				const idx = row + col * (nrows + 1);
				const y = heights[idx];

				if (y > targetHeight) {
					const next = THREE.MathUtils.lerp(y, targetHeight, falloff * 0.95);
					heights[idx] = next;
				}
			}
		}
	};

	// Measured against the pre-sculpt heightfield, so a ramp cut at one mouth
	// cannot drag a neighbouring column into looking like a mouth of its own.
	const sampleHeight = createHeightSampler(heights, nrows, ncols, size);
	const runs = caveMouthRuns(
		sampleCaveSpine(nodes, sampleHeight),
		punchDilate(terrainCellSize(size, nrows, ncols))
	);
	for (const run of runs) processMouth(mouthAnchor(run));

	positions.needsUpdate = true;
	if (!target.deferUpdate) {
		flushTerrainUpdate(mesh);
	}
}
