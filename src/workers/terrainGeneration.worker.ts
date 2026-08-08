import { serveWorker } from "./workerClient";
import {
	buildTerrainGeneration,
	type TerrainGenerationRequest,
	type TerrainGenerationResult,
} from "../worlds/terrainGenerationCore";

serveWorker<TerrainGenerationRequest, TerrainGenerationResult>((payload) => {
	const result = buildTerrainGeneration(payload);
	// Transfer large typed arrays so the main thread adopts them zero-copy.
	return {
		result,
		transfer: [result.positions.buffer, result.normals.buffer, result.heights.buffer],
	};
});
