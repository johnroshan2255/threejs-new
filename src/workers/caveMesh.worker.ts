import {
	buildCaveMeshData,
	type CaveMeshData,
	type CaveMeshRequest,
} from "../terrain/caveMeshCore";
import { serveWorker } from "./workerClient";

serveWorker<CaveMeshRequest, CaveMeshData | null>((payload) => {
	const result = buildCaveMeshData(payload);
	if (!result) return { result: null };
	// Hand the geometry buffers over zero-copy; the worker keeps nothing.
	return {
		result,
		transfer: [
			result.positions.buffer,
			result.normals.buffer,
			result.terrainBlend.buffer,
			result.indices.buffer,
		],
	};
});
