/** Shared world-edit protocol (client ↔ peers / future DB). */

export type SculptBrush = "raise" | "lower" | "smooth" | "flatten";

export type WorldEditOpBase = {
	id: string;
	authorId: string;
	t: number;
};

export type SculptOp = WorldEditOpBase & {
	type: "sculpt";
	brush: SculptBrush;
	x: number;
	z: number;
	radius: number;
	strength: number;
};

export type PlaceTreeOp = WorldEditOpBase & {
	type: "place-tree";
	x: number;
	z: number;
	scale: number;
	rotationY: number;
};

export type PlaceStoneOp = WorldEditOpBase & {
	type: "place-stone";
	x: number;
	z: number;
	scale: number;
	rotationY: number;
};

export type PlaceWaterOp = WorldEditOpBase & {
	type: "place-water";
	x: number;
	z: number;
	radius: number;
};

export type PaintRoadOp = WorldEditOpBase & {
	type: "paint-road";
	x: number;
	z: number;
	radius: number;
};

/** Paint / place water. createSurface + basin cells rebuild the water mesh exactly. */
export type PaintWaterOp = WorldEditOpBase & {
	type: "paint-water";
	x: number;
	z: number;
	radius: number;
	createSurface: boolean;
	/** Saved basin footprint — water fills ONLY these coordinates. */
	basin?: {
		waterY: number;
		centerX: number;
		centerZ: number;
		width: number;
		depth: number;
		cells: Array<{ x: number; z: number }>;
		digRadius?: number;
	};
};

export type PlaceMeshOp = WorldEditOpBase & {
	type: "place-mesh";
	meshId: "tree" | "stone";
	x: number;
	z: number;
	scale: number;
	rotationY: number;
};

export type ForestTreeSpec = {
	x: number;
	z: number;
	scale: number;
	rotationY: number;
};

/** @deprecated Prefer placing trees via place-mesh. Kept for old docs. */
export type PaintForestOp = WorldEditOpBase & {
	type: "paint-forest";
	x: number;
	z: number;
	radius: number;
	trees: ForestTreeSpec[];
};

export type RebuildColliderOp = WorldEditOpBase & {
	type: "rebuild-collider";
};

/** Remove a previously placed tree / stone / water tile (entityId = creating op id). */
export type DeleteEntityOp = WorldEditOpBase & {
	type: "delete-entity";
	entityId: string;
};

export type WorldEditOp =
	| SculptOp
	| PlaceTreeOp
	| PlaceStoneOp
	| PlaceWaterOp
	| PlaceMeshOp
	| PaintRoadOp
	| PaintWaterOp
	| PaintForestOp
	| RebuildColliderOp
	| DeleteEntityOp;

export type WorldEditDocument = {
	version: 1;
	/** island | valley | custom-* */
	worldId: string;
	worldName?: string;
	terrainSize: number;
	segments: number;
	createdAt: number;
	updatedAt: number;
	ops: WorldEditOp[];
};

export type WorldEditOpMessage = {
	kind: "op";
	roomCode: string;
	op: WorldEditOp;
};

export type WorldEditSnapshotMessage = {
	kind: "snapshot";
	roomCode: string;
	document: WorldEditDocument;
};

export type WorldEditRequestSnapshotMessage = {
	kind: "request-snapshot";
	roomCode: string;
};

export type WorldEditWireMessage =
	| WorldEditOpMessage
	| WorldEditSnapshotMessage
	| WorldEditRequestSnapshotMessage;

export const WORLD_EDIT_SOCKET = {
	op: "world-edit-op",
	snapshot: "world-edit-snapshot",
	requestSnapshot: "world-edit-request-snapshot",
} as const;

/**
 * Room create/join should carry the editable world so peers load the same place:
 *   create-room → { user, worldId, worldDefinition? }
 *   join-room   → { roomCode, userData, worldId? }
 *   callback    → { success, roomCode, worldId? }
 */
export type RoomWorldBinding = {
	worldId: string;
	worldDefinition?: import("../worlds/worldTypes").WorldDefinition;
};

export const WORLD_EDIT_STORAGE_KEY = "the-car-game:world-edit-draft:v1";
export const WORLD_EDIT_DOCS_KEY = "the-car-game:world-edit-docs:v1";
export const WORLD_EDIT_CHANNEL = "the-car-game:world-edit";
export const CUSTOM_WORLDS_KEY = "the-car-game:custom-worlds:v1";
