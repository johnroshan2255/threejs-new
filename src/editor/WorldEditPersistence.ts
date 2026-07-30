import type { WorldDefinition } from "../worlds/worldTypes";
import type { WorldEditDocument } from "./types";
import { WorldEditStore } from "./WorldEditStore";
import { WorldEditApi, type WorldVisibility } from "./WorldEditApi";

export type SaveWorldEditResult = {
	ok: boolean;
	document: WorldEditDocument;
	savedLocally: boolean;
	syncedToBackend: boolean;
	pendingBackend: boolean;
	message: string;
};

export type WorldEditPersistenceOptions = {
	api: WorldEditApi;
	getWorldDefinition: (worldId: string) => WorldDefinition | null;
	getOwner?: () => { id?: string; name?: string } | null;
	getVisibility?: () => WorldVisibility;
};

/**
 * Persistence facade.
 * - Always writes JSON to localStorage (draft / offline).
 * - When logged in, PUTs SavedWorldPayload to /api/worlds/:id (owned by user).
 * - Multiplayer peers sync live via socket ops/snapshots (EditSyncTransport).
 */
export class WorldEditPersistence {
	constructor(
		private readonly store: WorldEditStore,
		private readonly options: WorldEditPersistenceOptions
	) {}

	autosaveDraft() {
		this.store.persistDraftLocal();
	}

	async save(options?: { download?: boolean }): Promise<SaveWorldEditResult> {
		const doc = this.store.toJSON();
		this.store.persistDraftLocal();

		if (options?.download === true) {
			this.downloadJson(doc);
		}

		const owner = this.options.getOwner?.() ?? null;
		if (!owner?.id) {
			return {
				ok: false,
				document: doc,
				savedLocally: true,
				syncedToBackend: false,
				pendingBackend: true,
				message: "Log in to save this world to your account.",
			};
		}

		const backend = await this.saveToBackend(doc);
		if (backend.synced) this.store.markSaved();

		const message = backend.synced
			? "Saved to your account."
			: backend.error
				? `Draft kept locally (${backend.error})`
				: "Saved to localStorage.";

		return {
			ok: backend.ok,
			document: doc,
			savedLocally: true,
			syncedToBackend: backend.synced,
			pendingBackend: !backend.synced,
			message,
		};
	}

	/** Load a published / shared world JSON (visit other players' places). */
	async loadRemoteWorld(worldId: string): Promise<{
		definition: WorldDefinition;
		document: WorldEditDocument;
	} | null> {
		const payload = await this.options.api.fetchWorld(worldId);
		if (!payload?.definition || !payload?.document) return null;
		return { definition: payload.definition, document: payload.document };
	}

	/** Logged-in user's worlds from GET /api/worlds?mine=1. */
	async listMineWorlds() {
		return this.options.api.listWorlds("mine");
	}

	private async saveToBackend(doc: WorldEditDocument) {
		const definition = this.options.getWorldDefinition(doc.worldId);
		if (!definition) {
			return { ok: true, synced: false, error: "Missing world definition." };
		}

		const owner = this.options.getOwner?.() ?? null;
		return this.options.api.saveWorld({
			definition,
			document: doc,
			visibility: this.options.getVisibility?.() ?? "unlisted",
			ownerId: owner?.id,
			ownerName: owner?.name,
		});
	}

	private downloadJson(doc: WorldEditDocument) {
		const blob = new Blob([JSON.stringify(doc, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const anchor = window.document.createElement("a");
		anchor.href = url;
		anchor.download = `world-edit-${doc.worldId}-${doc.updatedAt}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	}
}
