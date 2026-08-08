import { createWorkerClient } from "./workerClient";
import type {
	TerrainGenerationRequest,
	TerrainGenerationResult,
} from "../worlds/terrainGenerationCore";

/**
 * Shared terrain generation worker. One instance is enough — jobs are serialized by
 * id, and terrain is only generated on world load/switch.
 */
export const terrainGenerationWorker = createWorkerClient<
	TerrainGenerationRequest,
	TerrainGenerationResult
>(
	() =>
		new Worker(new URL("./terrainGeneration.worker.ts", import.meta.url), {
			type: "module",
		}),
	"terrain"
);
