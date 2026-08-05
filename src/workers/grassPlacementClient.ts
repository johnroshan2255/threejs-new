import { createWorkerClient } from "./workerClient";
import type {
	GrassPlacementRequest,
	GrassPlacementResult,
} from "../entities/grass/grassPlacementCore";

/**
 * Shared grass placement worker. One instance is enough — jobs are serialised by
 * id, and grass is only rebuilt on world load or after a sculpt stroke settles.
 */
export const grassPlacementWorker = createWorkerClient<
	GrassPlacementRequest,
	GrassPlacementResult
>(
	() =>
		new Worker(new URL("./grassField.worker.ts", import.meta.url), {
			type: "module",
		}),
	"grass"
);
