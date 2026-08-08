let worker: Worker | null = null;
let jobId = 0;
const callbacks = new Map<number, { resolve: (data: any) => void; reject: (err: any) => void }>();

/**
 * Decodes and parses a massive JSON buffer in a WebWorker.
 * This completely avoids freezing the main thread's UI/frame loop when fetching large world save files.
 */
export function parseJsonAsync(buffer: ArrayBuffer): Promise<any> {
	if (!worker) {
		worker = new Worker(new URL("./jsonWorker.ts", import.meta.url), {
			type: "module",
		});
		worker.onmessage = (e) => {
			const { id, success, data, error } = e.data;
			const cb = callbacks.get(id);
			if (cb) {
				callbacks.delete(id);
				if (success) {
					cb.resolve(data);
				} else {
					cb.reject(new Error(error));
				}
			}
		};
	}

	return new Promise((resolve, reject) => {
		const id = jobId++;
		callbacks.set(id, { resolve, reject });
		
		// Send the buffer to the worker, and TRANSFER ownership so we don't copy the massive block of memory
		worker!.postMessage({ id, buffer }, [buffer]);
	});
}
