import * as THREE from "three";

export type SculptBrush = "raise" | "lower" | "smooth" | "flatten";

export type TerrainSculptTarget = {
	mesh: THREE.Mesh;
	heights: Float32Array;
	nrows: number;
	ncols: number;
	size: number;
};

/**
 * Apply a sculpt brush at world (x, z). Mutates mesh Y and heightfield samples.
 */
export function applyTerrainBrush(
	target: TerrainSculptTarget,
	worldX: number,
	worldZ: number,
	brush: SculptBrush,
	radius: number,
	strength: number
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
	geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	mesh.updateMatrixWorld(true);
}

/** Soft water basin for brush painting (~0.8 m deep, wide gentle banks). */
export function digWaterBrush(
	target: TerrainSculptTarget,
	worldX: number,
	worldZ: number,
	radius: number
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
	geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	mesh.updateMatrixWorld(true);
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
	geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	mesh.updateMatrixWorld(true);
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
