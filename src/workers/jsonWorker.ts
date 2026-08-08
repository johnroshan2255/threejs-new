self.onmessage = (e: MessageEvent<{ id: number; buffer: ArrayBuffer }>) => {
	try {
		const { id, buffer } = e.data;
		
		// Decode ArrayBuffer back to a JSON string
		const decoder = new TextDecoder("utf-8");
		const text = decoder.decode(buffer);
		
		// Parse the massive JSON string off the main thread
		const obj = JSON.parse(text);
		
		self.postMessage({ id, success: true, data: obj });
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		self.postMessage({ id: e.data.id, success: false, error });
	}
};
