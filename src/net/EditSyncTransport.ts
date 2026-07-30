import type { Socket } from "socket.io-client";
import type { WorldDefinition } from "../worlds/worldTypes";
import {
	WORLD_EDIT_CHANNEL,
	WORLD_EDIT_SOCKET,
	type WorldEditDocument,
	type WorldEditOp,
	type WorldEditWireMessage,
	type WorldSavedMessage,
} from "../editor/types";

export type WorldSavedPayload = {
	worldId: string;
	document: WorldEditDocument;
	definition?: WorldDefinition | null;
	updatedAt: number;
};

export type EditSyncHandlers = {
	onRemoteOp: (op: WorldEditOp, worldId?: string) => void;
	onRemoteSnapshot: (document: WorldEditDocument, worldId?: string) => void;
	onRequestSnapshot: () => void;
	/** Owner published a saved world — apply live for players in that world. */
	onWorldSaved: (payload: WorldSavedPayload) => void;
	getRoomCode: () => string;
	getClientId: () => string;
	/** Active editable world — used to drop cross-world BroadcastChannel leaks. */
	getActiveWorldId: () => string;
};

/**
 * Live edit transport for multiplayer + same-origin tabs.
 *
 * Socket.IO events (backend must relay to the room — frontend already emits/listens):
 *   world-edit-op                 { roomCode, op }
 *   world-edit-snapshot           { roomCode, document }
 *   world-edit-request-snapshot   { roomCode }
 *   world-saved                   { worldId, document, definition?, updatedAt }
 *   watch-world                   worldId
 *
 * BroadcastChannel fallback: other tabs see edits without a backend.
 */
export class EditSyncTransport {
	private socket: Socket | null = null;
	private channel: BroadcastChannel | null = null;
	private readonly handlers: EditSyncHandlers;
	private watchedWorldId: string | null = null;

	constructor(handlers: EditSyncHandlers) {
		this.handlers = handlers;
		if (typeof BroadcastChannel !== "undefined") {
			this.channel = new BroadcastChannel(WORLD_EDIT_CHANNEL);
			this.channel.onmessage = (event: MessageEvent<WorldEditWireMessage>) => {
				this.handleMessage(event.data, "broadcast");
			};
		}
	}

	attachSocket(socket: Socket | null) {
		if (this.socket === socket) return;
		this.detachSocketListeners();
		this.socket = socket;
		if (!socket) return;

		socket.on(
			WORLD_EDIT_SOCKET.op,
			(payload: { op?: WorldEditOp; roomCode?: string; worldId?: string }) => {
				if (!payload?.op) return;
				if (payload.op.authorId === this.handlers.getClientId()) return;
				const room = this.handlers.getRoomCode();
				if (payload.roomCode && room && payload.roomCode !== room) return;
				const worldId = payload.worldId;
				if (worldId && worldId !== this.handlers.getActiveWorldId()) return;
				this.handlers.onRemoteOp(payload.op, worldId);
			}
		);

		socket.on(
			WORLD_EDIT_SOCKET.snapshot,
			(payload: {
				document?: WorldEditDocument;
				roomCode?: string;
				worldId?: string;
			}) => {
				if (!payload?.document) return;
				const room = this.handlers.getRoomCode();
				if (payload.roomCode && room && payload.roomCode !== room) return;
				const worldId = payload.worldId ?? payload.document.worldId;
				if (worldId && worldId !== this.handlers.getActiveWorldId()) return;
				this.handlers.onRemoteSnapshot(payload.document, worldId);
			}
		);

		socket.on(WORLD_EDIT_SOCKET.requestSnapshot, (payload: { roomCode?: string }) => {
			const room = this.handlers.getRoomCode();
			if (payload?.roomCode && room && payload.roomCode !== room) return;
			this.handlers.onRequestSnapshot();
		});

		socket.on(WORLD_EDIT_SOCKET.saved, (payload: WorldSavedPayload) => {
			if (!payload?.document || !payload.worldId) return;
			this.handlers.onWorldSaved(payload);
		});

		if (this.watchedWorldId) {
			socket.emit(WORLD_EDIT_SOCKET.watchWorld, this.watchedWorldId);
		}
	}

	private detachSocketListeners() {
		if (!this.socket) return;
		this.socket.off(WORLD_EDIT_SOCKET.op);
		this.socket.off(WORLD_EDIT_SOCKET.snapshot);
		this.socket.off(WORLD_EDIT_SOCKET.requestSnapshot);
		this.socket.off(WORLD_EDIT_SOCKET.saved);
	}

	/** Subscribe to `world-saved` for this worldId (socket room `world:{id}`). */
	watchWorld(worldId: string | null) {
		this.watchedWorldId = worldId;
		if (this.socket?.connected) {
			this.socket.emit(WORLD_EDIT_SOCKET.watchWorld, worldId);
		}
	}

	broadcastOp(op: WorldEditOp) {
		const roomCode = this.handlers.getRoomCode();
		const worldId = this.handlers.getActiveWorldId();
		const message: WorldEditWireMessage = { kind: "op", roomCode, worldId, op };

		if (this.socket?.connected && roomCode) {
			this.socket.emit(WORLD_EDIT_SOCKET.op, { roomCode, worldId, op });
		}
		this.channel?.postMessage(message);
	}

	broadcastSnapshot(document: WorldEditDocument) {
		const roomCode = this.handlers.getRoomCode();
		const worldId = document.worldId || this.handlers.getActiveWorldId();
		const message: WorldEditWireMessage = {
			kind: "snapshot",
			roomCode,
			worldId,
			document,
		};
		if (this.socket?.connected && roomCode) {
			this.socket.emit(WORLD_EDIT_SOCKET.snapshot, {
				roomCode,
				worldId,
				document,
			});
		}
		this.channel?.postMessage(message);
	}

	/** Push authoritative saved world to room peers + BroadcastChannel tabs. */
	broadcastWorldSaved(payload: WorldSavedPayload) {
		const roomCode = this.handlers.getRoomCode();
		const message: WorldSavedMessage = {
			kind: "world-saved",
			worldId: payload.worldId,
			roomCode,
			document: payload.document,
			definition: payload.definition ?? null,
			updatedAt: payload.updatedAt,
		};
		if (this.socket?.connected) {
			this.socket.emit(WORLD_EDIT_SOCKET.saved, {
				...payload,
				roomCode,
			});
		}
		this.channel?.postMessage(message);
	}

	requestSnapshot() {
		const roomCode = this.handlers.getRoomCode();
		const message: WorldEditWireMessage = {
			kind: "request-snapshot",
			roomCode,
		};
		if (this.socket?.connected && roomCode) {
			this.socket.emit(WORLD_EDIT_SOCKET.requestSnapshot, { roomCode });
		}
		this.channel?.postMessage(message);
	}

	private handleMessage(
		message: WorldEditWireMessage,
		_source: "broadcast" | "socket"
	) {
		if (!message || typeof message !== "object") return;
		const room = this.handlers.getRoomCode();
		const activeWorldId = this.handlers.getActiveWorldId();
		// BroadcastChannel has no rooms — require worldId match to avoid hub leaks.
		if (message.kind === "op") {
			if (message.op.authorId === this.handlers.getClientId()) return;
			if (room && message.roomCode && message.roomCode !== room) return;
			const worldId = message.worldId;
			if (worldId && worldId !== activeWorldId) return;
			// Legacy messages without worldId: only accept inside a matching room.
			if (!worldId && !room) return;
			this.handlers.onRemoteOp(message.op, worldId);
			return;
		}
		if (message.kind === "snapshot") {
			if (room && message.roomCode && message.roomCode !== room) return;
			const worldId = message.worldId ?? message.document?.worldId;
			if (worldId && worldId !== activeWorldId) return;
			if (!worldId && !room) return;
			this.handlers.onRemoteSnapshot(message.document, worldId);
			return;
		}
		if (message.kind === "request-snapshot") {
			if (room && message.roomCode && message.roomCode !== room) return;
			this.handlers.onRequestSnapshot();
			return;
		}
		if (message.kind === "world-saved") {
			if (message.worldId && message.worldId !== activeWorldId) return;
			if (message.document?.worldId && message.document.worldId !== activeWorldId) {
				return;
			}
			this.handlers.onWorldSaved({
				worldId: message.worldId,
				document: message.document,
				definition: message.definition,
				updatedAt: message.updatedAt,
			});
		}
	}

	dispose() {
		this.detachSocketListeners();
		this.socket = null;
		this.channel?.close();
		this.channel = null;
	}
}
