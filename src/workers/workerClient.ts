/**
 * Minimal request/response wrapper around a module Worker.
 *
 * Every job is one postMessage with a job id; the worker echoes the id back so
 * concurrent jobs on one worker cannot cross wires. Buffers move by transfer
 * (zero-copy) in both directions — the whole point of these workers is bulk
 * typed-array data, and structured-cloning a few megabytes per job would eat the
 * time we are trying to save.
 *
 * Callers must keep a synchronous fallback: workers are unavailable in some
 * embeddings, and a failed job must degrade to a hitch, never to a broken world.
 */

export type WorkerRequest<T> = {
	id: number;
	payload: T;
};

export type WorkerResponse<R> = {
	id: number;
	ok: boolean;
	result?: R;
	error?: string;
};

export type WorkerClient<Req, Res> = {
	run: (payload: Req, transfer?: Transferable[]) => Promise<Res>;
	dispose: () => void;
	readonly available: boolean;
};

export function workersSupported(): boolean {
	return typeof Worker !== "undefined";
}

/**
 * `factory` must construct the Worker, e.g.
 *   () => new Worker(new URL("./grassField.worker.ts", import.meta.url), { type: "module" })
 *
 * The worker is created lazily on first use so a feature nobody touches costs
 * nothing, and so a module-load failure surfaces at the call site (where the
 * fallback lives) rather than at import time.
 */
export function createWorkerClient<Req, Res>(
	factory: () => Worker,
	label: string
): WorkerClient<Req, Res> {
	const poolSize = typeof navigator !== "undefined" ? Math.max(1, navigator.hardwareConcurrency || 4) : 1;
	const workers: Worker[] = [];
	let broken = !workersSupported();
	let nextId = 1;
	let nextWorkerIndex = 0;
	
	const pending = new Map<
		number,
		{ resolve: (value: Res) => void; reject: (error: Error) => void }
	>();

	const failAll = (error: Error) => {
		for (const entry of pending.values()) entry.reject(error);
		pending.clear();
	};

	const getWorker = (): Worker | null => {
		if (broken) return null;
		
		if (workers.length < poolSize) {
			try {
				const worker = factory();
				worker.onmessage = (event: MessageEvent<WorkerResponse<Res>>) => {
					const data = event.data;
					const entry = pending.get(data.id);
					if (!entry) return;
					pending.delete(data.id);
					if (data.ok) entry.resolve(data.result as Res);
					else entry.reject(new Error(data.error ?? `[worker:${label}] failed`));
				};
				worker.onerror = (event) => {
					// We just log and remove broken workers. If all fail, it falls back.
					const error = new Error(`[worker:${label}] ${event.message || "worker error"}`);
					console.warn(error.message);
					failAll(error);
					worker.terminate();
					const idx = workers.indexOf(worker);
					if (idx !== -1) workers.splice(idx, 1);
					if (workers.length === 0) broken = true;
				};
				workers.push(worker);
			} catch (error) {
				broken = true;
				console.warn(`[worker:${label}] unavailable, using main thread`, error);
				return null;
			}
		}

		if (workers.length === 0) return null;

		const worker = workers[nextWorkerIndex % workers.length];
		nextWorkerIndex++;
		return worker;
	};

	return {
		get available() {
			return !broken;
		},
		run(payload, transfer) {
			const active = getWorker();
			if (!active) {
				return Promise.reject(new Error(`[worker:${label}] unavailable`));
			}
			const id = nextId++;
			return new Promise<Res>((resolve, reject) => {
				pending.set(id, { resolve, reject });
				try {
					active.postMessage({ id, payload }, transfer ?? []);
				} catch (error) {
					pending.delete(id);
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
		},
		dispose() {
			failAll(new Error(`[worker:${label}] disposed`));
			for (const worker of workers) worker.terminate();
			workers.length = 0;
		},
	};
}

/**
 * Worker-side counterpart: wires one handler to onmessage with id plumbing and
 * error forwarding, so worker files contain only their actual computation.
 */
export function serveWorker<Req, Res>(
	handler: (payload: Req) => { result: Res; transfer?: Transferable[] }
) {
	self.onmessage = (event: MessageEvent<WorkerRequest<Req>>) => {
		const { id, payload } = event.data;
		try {
			const { result, transfer } = handler(payload);
			(self as unknown as Worker).postMessage(
				{ id, ok: true, result },
				transfer ?? []
			);
		} catch (error) {
			(self as unknown as Worker).postMessage({
				id,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
}
