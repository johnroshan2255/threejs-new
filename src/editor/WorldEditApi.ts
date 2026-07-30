import type { WorldDefinition } from "../worlds/worldTypes";
import type { WorldEditDocument } from "./types";

export type WorldVisibility = "private" | "unlisted" | "public";

/** Full JSON blob stored per user-created / edited place. */
export type SavedWorldPayload = {
	definition: WorldDefinition;
	document: WorldEditDocument;
	visibility: WorldVisibility;
	ownerId?: string;
	ownerName?: string;
	updatedAt?: number;
};

export type WorldListItem = {
	worldId: string;
	worldName: string;
	ownerId?: string;
	ownerName?: string;
	visibility: WorldVisibility;
	updatedAt: number;
	terrainSize?: number;
};

export type WorldEditApiOptions = {
	serverUrl: string;
	getToken: () => string | null;
};

/**
 * Frontend API client for saving / loading user worlds as JSON.
 *
 * REST (auth Bearer token):
 *   PUT    /api/worlds/:worldId     body: SavedWorldPayload
 *   GET    /api/worlds/:worldId     → SavedWorldPayload
 *   GET    /api/worlds?mine=1       → { worlds: WorldListItem[] }
 *   GET    /api/worlds?public=1     → { worlds: WorldListItem[] }
 *   DELETE /api/worlds/:worldId
 */
export class WorldEditApi {
	constructor(private readonly options: WorldEditApiOptions) {}

	async saveWorld(payload: SavedWorldPayload): Promise<{ ok: boolean; synced: boolean; error?: string }> {
		const token = this.options.getToken();
		if (!token) {
			return { ok: false, synced: false, error: "Not logged in." };
		}

		try {
			const res = await fetch(
				`${this.options.serverUrl}/api/worlds/${encodeURIComponent(payload.definition.id)}`,
				{
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({
						...payload,
						updatedAt: Date.now(),
					}),
				}
			);

			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
				return {
					ok: false,
					synced: false,
					error: data.error || `Save failed (${res.status})`,
				};
			}

			return { ok: true, synced: true };
		} catch {
			return { ok: false, synced: false, error: "Offline — could not reach server." };
		}
	}

	async fetchWorld(worldId: string): Promise<SavedWorldPayload | null> {
		try {
			const headers: Record<string, string> = {};
			const token = this.options.getToken();
			if (token) headers.Authorization = `Bearer ${token}`;

			const res = await fetch(
				`${this.options.serverUrl}/api/worlds/${encodeURIComponent(worldId)}`,
				{ headers }
			);
			if (!res.ok) return null;
			return (await res.json()) as SavedWorldPayload;
		} catch {
			return null;
		}
	}

	async listWorlds(scope: "mine" | "public" = "public"): Promise<WorldListItem[]> {
		const token = this.options.getToken();
		if (scope === "mine" && !token) return [];

		try {
			const headers: Record<string, string> = {};
			if (token) headers.Authorization = `Bearer ${token}`;
			const q = scope === "mine" ? "mine=1" : "public=1";
			const res = await fetch(`${this.options.serverUrl}/api/worlds?${q}`, { headers });
			if (!res.ok) return [];
			const data = (await res.json()) as { worlds?: WorldListItem[] };
			return Array.isArray(data.worlds) ? data.worlds : [];
		} catch {
			return [];
		}
	}
}
