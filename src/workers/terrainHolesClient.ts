import { createWorkerClient } from "./workerClient";
import type { PunchHolesRequest, PunchHolesResult } from "../terrain/punchHolesCore";

export const terrainHolesWorker = createWorkerClient<
	PunchHolesRequest,
	PunchHolesResult | null
>(
	() =>
		new Worker(new URL("./terrainHoles.worker.ts", import.meta.url), {
			type: "module",
		}),
	"terrain-holes"
);
