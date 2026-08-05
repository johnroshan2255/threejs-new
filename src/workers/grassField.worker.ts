import {
	buildGrassPlacement,
	type GrassPlacementRequest,
	type GrassPlacementResult,
} from "../entities/grass/grassPlacementCore";
import { serveWorker } from "./workerClient";

serveWorker<GrassPlacementRequest, GrassPlacementResult>((payload) => {
	const result = buildGrassPlacement(payload);
	// Transfer every chunk's matrix buffer so the main thread adopts it zero-copy.
	return {
		result,
		transfer: result.chunks.map((chunk) => chunk.matrices.buffer),
	};
});
