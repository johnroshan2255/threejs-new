import {
	WORLD_EDIT_DOCS_KEY,
	WORLD_EDIT_STORAGE_KEY,
	type WorldEditDocument,
	type WorldEditOp,
} from "./types";

function newId() {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function getOrCreateClientId(): string {
	const key = "the-car-game:edit-client-id";
	try {
		const existing = sessionStorage.getItem(key);
		if (existing) return existing;
		const id = newId();
		sessionStorage.setItem(key, id);
		return id;
	} catch {
		return newId();
	}
}

export type CreateEmptyDocOptions = {
	worldId: string;
	worldName?: string;
	terrainSize: number;
	segments: number;
};

/**
 * In-memory append-only edit log. Serializable to JSON for later DB save.
 * Drafts are stored per worldId.
 */
export class WorldEditStore {
	readonly clientId = getOrCreateClientId();
	private authorIdOverride: string | null = null;
	private document: WorldEditDocument;
	private dirty = false;
	private readonly listeners = new Set<() => void>();
	/** Op counts per undoable action (stroke or single place/delete). */
	private undoUnits: number[] = [];
	private redoStack: WorldEditOp[][] = [];
	private strokeActive = false;
	private strokeOpCount = 0;

	constructor(options?: CreateEmptyDocOptions) {
		this.document = WorldEditStore.createEmpty(
			options ?? {
				worldId: "island",
				worldName: "Island",
				terrainSize: 200,
				segments: 112,
			}
		);
	}

	/** Prefer logged-in user id for op authorship (multiplayer + DB). */
	setAuthorId(authorId: string | null) {
		this.authorIdOverride = authorId;
	}

	get authorId() {
		return this.authorIdOverride ?? this.clientId;
	}

	static createEmpty(options: CreateEmptyDocOptions): WorldEditDocument {
		const now = Date.now();
		return {
			version: 1,
			worldId: options.worldId,
			worldName: options.worldName,
			terrainSize: options.terrainSize,
			segments: options.segments,
			createdAt: now,
			updatedAt: now,
			ops: [],
		};
	}

	get snapshot(): WorldEditDocument {
		return this.document;
	}

	get worldId() {
		return this.document.worldId;
	}

	get opCount() {
		return this.document.ops.length;
	}

	get isDirty() {
		return this.dirty;
	}

	switchWorld(options: CreateEmptyDocOptions, existing?: WorldEditDocument | null) {
		if (existing && existing.worldId === options.worldId) {
			this.document = structuredClone(existing);
		} else {
			this.document = WorldEditStore.createEmpty(options);
		}
		this.dirty = false;
		this.clearHistory();
		// Each saved op is its own undo step so history survives reload.
		this.undoUnits = this.document.ops.map(() => 1);
		this.emit();
	}

	reset(options: CreateEmptyDocOptions) {
		this.document = WorldEditStore.createEmpty(options);
		this.dirty = false;
		this.clearHistory();
		this.emit();
	}

	append(op: WorldEditOp, options?: { trackHistory?: boolean }): boolean {
		if (this.document.ops.some((entry) => entry.id === op.id)) return false;
		this.document.ops.push(op);
		this.document.updatedAt = Date.now();
		this.dirty = true;
		const track = options?.trackHistory !== false;
		if (track) {
			if (this.strokeActive) {
				this.strokeOpCount += 1;
			} else {
				this.undoUnits.push(1);
				this.redoStack = [];
			}
		}
		this.emit();
		return true;
	}

	/** Group many paint samples into one Undo step (one finger / mouse stroke). */
	beginStroke() {
		if (this.strokeActive) this.endStroke();
		this.strokeActive = true;
		this.strokeOpCount = 0;
	}

	endStroke() {
		if (!this.strokeActive) return;
		if (this.strokeOpCount > 0) {
			this.undoUnits.push(this.strokeOpCount);
			this.redoStack = [];
		}
		this.strokeActive = false;
		this.strokeOpCount = 0;
		this.emit();
	}

	get canUndo() {
		return this.undoUnits.length > 0;
	}

	get canRedo() {
		return this.redoStack.length > 0;
	}

	/** Remove the last undo unit from the op list. Caller must rebuild the world. */
	undo(): WorldEditOp[] | null {
		this.endStroke();
		if (!this.undoUnits.length) return null;
		const count = this.undoUnits.pop()!;
		const start = Math.max(0, this.document.ops.length - count);
		const removed = this.document.ops.splice(start, count);
		if (!removed.length) return null;
		this.redoStack.push(removed);
		this.document.updatedAt = Date.now();
		this.dirty = true;
		this.emit();
		return removed;
	}

	/** Re-append the last undone unit. Caller must apply the returned ops. */
	redo(): WorldEditOp[] | null {
		this.endStroke();
		const batch = this.redoStack.pop();
		if (!batch?.length) return null;
		this.document.ops.push(...batch);
		this.undoUnits.push(batch.length);
		this.document.updatedAt = Date.now();
		this.dirty = true;
		this.emit();
		return batch;
	}

	/** Clear undo/redo stacks (world switch / load). */
	clearHistory() {
		this.undoUnits = [];
		this.redoStack = [];
		this.strokeActive = false;
		this.strokeOpCount = 0;
	}

	createOp<T extends Omit<WorldEditOp, "id" | "authorId" | "t">>(
		partial: T
	): WorldEditOp {
		return {
			...partial,
			id: newId(),
			authorId: this.authorId,
			t: Date.now(),
		} as WorldEditOp;
	}

	toJSON(): WorldEditDocument {
		return structuredClone(this.document);
	}

	toJSONString(pretty = true): string {
		return JSON.stringify(this.toJSON(), null, pretty ? 2 : undefined);
	}

	loadDocument(doc: WorldEditDocument) {
		this.document = structuredClone(doc);
		this.dirty = false;
		this.clearHistory();
		this.undoUnits = this.document.ops.map(() => 1);
		this.emit();
	}

	markSaved() {
		this.dirty = false;
		this.emit();
	}

	/** Drop baked water fill ops (createSurface). Dig strokes remain the source of truth. */
	stripWaterSurfaceOps(): number {
		const before = this.document.ops.length;
		this.document.ops = this.document.ops.filter(
			(op) => !(op.type === "paint-water" && op.createSurface)
		);
		const removed = before - this.document.ops.length;
		if (removed > 0) {
			this.document.updatedAt = Date.now();
			this.dirty = true;
			// Fills were derived — rebuild undo as one step per remaining op.
			this.undoUnits = this.document.ops.map(() => 1);
			this.redoStack = [];
			this.emit();
		}
		return removed;
	}

	subscribe(listener: () => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit() {
		for (const listener of this.listeners) listener();
	}

	persistDraftLocal() {
		try {
			localStorage.setItem(WORLD_EDIT_STORAGE_KEY, this.toJSONString(false));
			const all = WorldEditStore.loadAllDocs();
			all[this.document.worldId] = this.toJSON();
			localStorage.setItem(WORLD_EDIT_DOCS_KEY, JSON.stringify(all));
		} catch {
			/* quota / private mode */
		}
	}

	static loadAllDocs(): Record<string, WorldEditDocument> {
		try {
			const raw = localStorage.getItem(WORLD_EDIT_DOCS_KEY);
			if (!raw) return {};
			return JSON.parse(raw) as Record<string, WorldEditDocument>;
		} catch {
			return {};
		}
	}

	static loadDocForWorld(worldId: string): WorldEditDocument | null {
		return WorldEditStore.loadAllDocs()[worldId] ?? null;
	}

	/** Drop a polluted / hub draft so island edits cannot leak across sessions. */
	static clearDocForWorld(worldId: string) {
		try {
			const all = WorldEditStore.loadAllDocs();
			if (!(worldId in all)) return;
			delete all[worldId];
			localStorage.setItem(WORLD_EDIT_DOCS_KEY, JSON.stringify(all));
			const draft = WorldEditStore.loadDraftLocal();
			if (draft?.worldId === worldId) {
				localStorage.removeItem(WORLD_EDIT_STORAGE_KEY);
			}
		} catch {
			/* quota / private mode */
		}
	}

	static loadDraftLocal(): WorldEditDocument | null {
		try {
			const raw = localStorage.getItem(WORLD_EDIT_STORAGE_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as WorldEditDocument;
			if (parsed?.version !== 1 || !Array.isArray(parsed.ops)) return null;
			return parsed;
		} catch {
			return null;
		}
	}
}
