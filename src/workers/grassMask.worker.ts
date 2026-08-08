import { serveWorker } from "./workerClient";
import type { GrassMaskRequest, GrassMaskResult } from "./grassMaskClient";

serveWorker<GrassMaskRequest, GrassMaskResult>((payload) => {
	const { matrices, circles, originX, originZ } = payload;
	const cx = new Float64Array(circles.length);
	const cz = new Float64Array(circles.length);
	const cr2 = new Float64Array(circles.length);

	for (let n = 0; n < circles.length; n++) {
		cx[n] = circles[n]!.x - originX;
		cz[n] = circles[n]!.z - originZ;
		cr2[n] = circles[n]!.radius * circles[n]!.radius;
	}

	const totalCount = matrices.length / 16;
	let changed = false;

	for (let i = 0; i < totalCount; i++) {
		const offset = i * 16;
		// If already sunk, skip it (optimization and prevents double-scaling)
		if (matrices[offset + 13] === -50) continue;

		const posX = matrices[offset + 12]!;
		const posZ = matrices[offset + 14]!;

		let inside = false;
		for (let n = 0; n < circles.length; n++) {
			const dx = posX - cx[n]!;
			const dz = posZ - cz[n]!;
			if (dx * dx + dz * dz <= cr2[n]!) {
				inside = true;
				break;
			}
		}

		if (inside) {
			matrices[offset + 13] = -50;
			matrices[offset + 0] *= 0.001;
			matrices[offset + 5] *= 0.001;
			matrices[offset + 10] *= 0.001;
			changed = true;
		}
	}

	return {
		result: { matrices },
		transfer: [matrices.buffer],
	};
});
