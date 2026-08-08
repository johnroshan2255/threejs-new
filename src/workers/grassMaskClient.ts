import { createWorkerClient } from "./workerClient";

export type GrassMaskCircle = {
	x: number;
	z: number;
	radius: number;
};

export type GrassMaskRequest = {
	matrices: Float32Array;
	circles: GrassMaskCircle[];
	originX: number;
	originZ: number;
};

export type GrassMaskResult = {
	matrices: Float32Array;
};

export const grassMaskClient = createWorkerClient<GrassMaskRequest, GrassMaskResult>(
	() => new Worker(new URL("./grassMask.worker.ts", import.meta.url), { type: "module" }),
	"grassMask"
);
