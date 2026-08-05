import { createWorkerClient } from "./workerClient";
import type { CaveMeshData, CaveMeshRequest } from "../terrain/caveMeshCore";

/**
 * Cave shell meshing worker. Surface Nets over a few million voxel samples takes
 * a few hundred milliseconds — long enough to be a visible freeze the moment a
 * cave is carved, and again on every world load that replays cave ops.
 */
export const caveMeshWorker = createWorkerClient<
	CaveMeshRequest,
	CaveMeshData | null
>(
	() =>
		new Worker(new URL("./caveMesh.worker.ts", import.meta.url), {
			type: "module",
		}),
	"cave-mesh"
);
