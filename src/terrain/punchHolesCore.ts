import {
	createHeightSampler,
	isMouthColumn,
	maxCaveRadius,
	punchDilate,
	type CaveNode,
} from "./caveShape";

export type PunchHolesRequest = {
	baseIndex: Uint32Array;
	positions: Float32Array;
	caves: { nodes: CaveNode[] }[];
	heights: Float32Array;
	nrows: number;
	ncols: number;
	size: number;
	cellSize: number;
};

export type PunchHolesResult = {
	newIndex: Uint32Array;
	removedCount: number;
};

export function buildPunchHolesData(req: PunchHolesRequest): PunchHolesResult {
	const active = req.caves.filter((c) => c.nodes.length > 0);
	if (!active.length) {
		return { newIndex: new Uint32Array(req.baseIndex), removedCount: 0 };
	}

	const sampleHeight = createHeightSampler(
		req.heights,
		req.nrows,
		req.ncols,
		req.size
	);
	const dilate = punchDilate(req.cellSize);

	const regions = active.map((cave) => {
		const pad = maxCaveRadius(cave.nodes) + dilate + 1.1;
		let minX = Infinity;
		let maxX = -Infinity;
		let minZ = Infinity;
		let maxZ = -Infinity;
		for (const n of cave.nodes) {
			minX = Math.min(minX, n.x);
			maxX = Math.max(maxX, n.x);
			minZ = Math.min(minZ, n.z);
			maxZ = Math.max(maxZ, n.z);
		}
		return {
			nodes: cave.nodes,
			minX: minX - pad,
			maxX: maxX + pad,
			minZ: minZ - pad,
			maxZ: maxZ + pad,
		};
	});

	const kept: number[] = [];
	let removed = 0;
	const base = req.baseIndex;
	const pos = req.positions;

	for (let t = 0; t < base.length; t += 3) {
		const i0 = base[t]!;
		const i1 = base[t + 1]!;
		const i2 = base[t + 2]!;

		let punch = false;
		for (const region of regions) {
			let hit = false;
			for (const vi of [i0, i1, i2]) {
				const vx = pos[vi * 3];
				const vz = pos[vi * 3 + 2];
				if (
					vx >= region.minX &&
					vx <= region.maxX &&
					vz >= region.minZ &&
					vz <= region.maxZ &&
					isMouthColumn(region.nodes, sampleHeight, vx, vz, dilate)
				) {
					hit = true;
					break;
				}
			}
			if (!hit) {
				const cx = (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3;
				const cz = (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3;
				hit =
					cx >= region.minX &&
					cx <= region.maxX &&
					cz >= region.minZ &&
					cz <= region.maxZ &&
					isMouthColumn(region.nodes, sampleHeight, cx, cz, dilate);
			}
			if (hit) {
				punch = true;
				break;
			}
		}
		if (punch) {
			removed++;
			continue;
		}
		kept.push(i0, i1, i2);
	}

	return {
		newIndex: new Uint32Array(kept),
		removedCount: removed,
	};
}
