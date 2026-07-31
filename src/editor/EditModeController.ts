import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { Socket } from "socket.io-client";
import type { TreeHandle } from "../entities/tree";
import type { PlacedStoneHandle } from "../entities/stone/placeStone";
import type { Pond } from "../entities/water";
import type { GrassChunkField } from "../entities/grass/GrassChunkField";
import { setIslandTerrain } from "../terrain/islandHeight";
import type { TerrainSculptTarget } from "./TerrainSculpt";
import {
	EditModeUI,
	type EditTool,
	type EditTransformMode,
	type EditViewMode,
	type RoadStyle,
	type SculptType,
} from "../ui/EditModeUI";
import { pickPlaceScale, resolveEditMesh, type EditMeshId } from "./meshCatalog";
import type { TerrainColliderHandle } from "../physics/terrainCollider";
import { createTerrainHeightfieldCollider } from "../physics/terrainCollider";
import { WorldEditStore } from "./WorldEditStore";
import { WorldEditPersistence } from "./WorldEditPersistence";
import { WorldEditApi } from "./WorldEditApi";
import { EditApplier } from "./EditApplier";
import { EditSyncTransport } from "../net/EditSyncTransport";
import type { WorldEditDocument, WorldEditOp } from "./types";
import type { WorldDefinition } from "../worlds/worldTypes";
import { isGameKeyBlocked } from "../ui/gameInputFocus";

export type EditModeHost = {
	scene: THREE.Scene;
	renderer: THREE.WebGLRenderer;
	playCamera: THREE.PerspectiveCamera;
	canvas: HTMLCanvasElement;
	getEditWorldGroup: () => THREE.Group;
	getTerrainMesh: () => THREE.Mesh | null;
	getTerrainHeights: () => Float32Array | null;
	getTerrainHandle: () => TerrainColliderHandle | null;
	setTerrainHandle: (handle: TerrainColliderHandle | null) => void;
	getGrassField: () => GrassChunkField | null;
	getActiveWorldDefinition: () => WorldDefinition;
	/** Resolve any world def known this session (island / valley / custom). */
	getWorldDefinitionById: (worldId: string) => WorldDefinition | null;
	/** Register a custom def in the in-memory catalog (e.g. after a DB fetch). */
	ensureWorldDefinition: (definition: WorldDefinition) => void;
	enableTerrainVertexColors: () => void;
	setMapMode: (enabled: boolean) => void;
	addEditorTree: (tree: TreeHandle) => void;
	addEditorStone: (stone: PlacedStoneHandle) => void;
	addEditorPond: (pond: Pond) => void;
	removeEditorTree: (tree: TreeHandle) => void;
	removeEditorStone: (stone: PlacedStoneHandle) => void;
	removeEditorPond: (pond: Pond) => void;
	getScenePropsTerrainColor: () => THREE.ColorRepresentation;
	isGameActive: () => boolean;
	getRoomCode: () => string;
	createNewLargeWorld: (sizeKm: number) => Promise<void>;
	/** Switch active world (used when joining a room bound to a worldId). */
	switchToWorldId: (worldId: string) => Promise<void>;
	/** In-memory custom world defs (created this session, not yet in the DB). */
	listLocalCustomWorlds: () => WorldDefinition[];
	/** Rebuild fluffy grass from the current terrain (used after undo/redo). */
	rebuildEditGrass: () => void;
	/** Lift car / human out of terrain that rose over them. */
	liftPlayersAboveTerrain?: () => void;
	/** The DB's saved-world list changed (e.g. after Save World). */
	onWorldsChanged?: () => void;
	getAuthToken: () => string | null;
	getAuthUser: () => { id?: string; username?: string } | null;
	getServerUrl: () => string;
};

const PAINT_MIN_INTERVAL_MS = 40;

/**
 * Edit mode: Camera navigate, sculpt, light-mud roads, meshes, water → Pond.
 * Edits live in RAM (WorldEditStore) and are written to the DB on Save World.
 */
export class EditModeController {
	readonly ui: EditModeUI;
	readonly store: WorldEditStore;
	readonly persistence: WorldEditPersistence;

	private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 5000);
	private readonly orbitCam = new THREE.PerspectiveCamera(55, 1, 0.5, 8000);
	private readonly raycaster = new THREE.Raycaster();
	private readonly pointer = new THREE.Vector2();
	private readonly hitPoint = new THREE.Vector3();
	private readonly brushHelper: THREE.Mesh;
	private readonly applier: EditApplier;
	private readonly sync: EditSyncTransport;
	private readonly keys = new Set<string>();

	private enabled = false;
	private viewMode: EditViewMode = "top";
	private tool: EditTool = "camera";
	private sculpt: SculptType = "raise";
	private meshId: EditMeshId = "tree";
	private roadStyle: RoadStyle = "mud";
	private brushRadius = 3;
	private brushStrength = 0.35;
	private frustumSize = 120;
	private target = new THREE.Vector3(0, 0, 0);
	private orbitYaw = 0.7;
	private orbitPitch = 0.55;
	private orbitDistance = 160;

	private painting = false;
	private panning = false;
	private orbiting = false;
	private lastPan = new THREE.Vector2();
	private pointerDownPos = new THREE.Vector2();
	private cameraClickFocus = false;
	private placeBusy = false;
	private historyBusy = false;
	private terrainBaselineHeights: Float32Array | null = null;
	private terrainBaselineColors: Float32Array | null = null;
	private terrainHadVertexColors = false;
	private lastPaintAt = 0;
	private selectedEntityId: string | null = null;
	private selectionHelper: THREE.BoxHelper | null = null;
	private transformControls: TransformControls | null = null;
	private transformMode: EditTransformMode = "translate";
	private transformDragging = false;
	private applyingRemote = false;
	private remoteColliderTimer: number | null = null;
	/** Skip echo of our own Save World publish. */
	private lastPublishedAt = 0;
	private applyingPublished = false;
	/**
	 * When opening a fetched document right after switchWorld, skip bindStore's
	 * cached replay so ops are not applied twice.
	 */
	private skipNextBindApply = false;
	/** Bumps on each terrain rebuild so stale async applyMany calls abort. */
	private terrainApplyGeneration = 0;
	/**
	 * Per-world edit docs kept in RAM for this tab only, so switching worlds
	 * mid-session does not lose unsaved edits. Never persisted to the browser.
	 */
	private readonly sessionDocs = new Map<string, WorldEditDocument>();
	/** In-flight world bind (edit replay), so callers can await final terrain. */
	private bindTask: Promise<void> | null = null;
	private bindTaskWorldId: string | null = null;

	constructor(private readonly host: EditModeHost) {
		const def = host.getActiveWorldDefinition();
		this.store = new WorldEditStore({
			worldId: def.id,
			worldName: def.name,
			terrainSize: def.size,
			segments: def.segments,
		});
		this.persistence = new WorldEditPersistence(this.store, {
			api: new WorldEditApi({
				serverUrl: host.getServerUrl(),
				getToken: () => host.getAuthToken(),
			}),
			getWorldDefinition: (worldId) => host.getWorldDefinitionById(worldId),
			getOwner: () => {
				const user = host.getAuthUser();
				if (!user) return null;
				return { id: user.id, name: user.username };
			},
			getVisibility: () => "unlisted",
		});

		this.applier = new EditApplier({
			get worldGroup() {
				return host.getEditWorldGroup();
			},
			renderer: host.renderer,
			scene: host.scene,
			playCamera: host.playCamera,
			getSculptTarget: () => this.getSculptTarget(),
			getTerrainMesh: () => host.getTerrainMesh(),
			getGrassField: () => host.getGrassField(),
			rebuildCollider: () => this.rebuildCollider(),
			enableTerrainVertexColors: () => host.enableTerrainVertexColors(),
			addEditorTree: (tree) => host.addEditorTree(tree),
			addEditorStone: (stone) => host.addEditorStone(stone),
			addEditorPond: (pond) => host.addEditorPond(pond),
			removeEditorTree: (tree) => host.removeEditorTree(tree),
			removeEditorStone: (stone) => host.removeEditorStone(stone),
			removeEditorPond: (pond) => host.removeEditorPond(pond),
			getScenePropsTerrainColor: () => host.getScenePropsTerrainColor(),
		});

		this.sync = new EditSyncTransport({
			getRoomCode: () => host.getRoomCode(),
			getClientId: () => this.store.authorId,
			getActiveWorldId: () => this.host.getActiveWorldDefinition().id,
			onRemoteOp: (op, worldId) => {
				void this.applyIncomingOp(op, worldId);
			},
			onRemoteSnapshot: (doc, worldId) => {
				void this.applyIncomingSnapshot(doc, worldId);
			},
			onRequestSnapshot: () => {
				if (this.store.opCount > 0) {
					this.sync.broadcastSnapshot(this.store.toJSON());
				}
			},
			onWorldSaved: (payload) => {
				void this.onWorldSaved(payload);
			},
		});

		const user = host.getAuthUser();
		if (user?.id) this.store.setAuthorId(user.id);

		this.ortho.up.set(0, 0, -1);
		this.ortho.position.set(0, 400, 0);
		this.ortho.lookAt(0, 0, 0);
		this.orbitCam.position.set(120, 90, 120);
		this.orbitCam.lookAt(0, 0, 0);

		const ring = new THREE.RingGeometry(0.92, 1, 48);
		ring.rotateX(-Math.PI / 2);
		this.brushHelper = new THREE.Mesh(
			ring,
			new THREE.MeshBasicMaterial({
				color: 0xc8e6a0,
				transparent: true,
				opacity: 0.85,
				depthTest: false,
			})
		);
		this.brushHelper.visible = false;
		this.brushHelper.renderOrder = 10;
		this.host.scene.add(this.brushHelper);

		this.transformControls = new TransformControls(
			this.ortho,
			this.host.canvas
		);
		this.transformControls.visible = false;
		this.transformControls.enabled = false;
		this.transformControls.setSize(0.9);
		this.transformControls.addEventListener("dragging-changed", (event) => {
			this.transformDragging = Boolean(
				(event as { value?: boolean }).value
			);
			if (!this.transformDragging) {
				void this.commitSelectionTransform();
			}
		});
		this.host.scene.add(this.transformControls);

		this.ui = new EditModeUI({
			onRequestEnterEdit: () => {
				void this.requestEnterEdit();
			},
			onToggleEdit: (on) => {
				if (on) void this.requestEnterEdit();
				else void this.exitEditToHub();
			},
			onToolChange: (tool) => {
				this.tool = tool;
				this.brushHelper.visible = this.enabled && this.isBrushTool(tool);
				this.updateBrushColor();
				if (tool !== "select") this.clearSelection();
				if (tool === "camera" && this.viewMode === "orbit") {
					this.syncOrbit();
				}
				this.syncTransformControlsCamera();
				this.refreshHint();
			},
			onSculptChange: (sculpt) => {
				this.sculpt = sculpt;
			},
			onBrushChange: (radius, strength) => {
				this.brushRadius = radius;
				this.brushStrength = strength;
				this.brushHelper.scale.setScalar(radius);
			},
			onViewModeChange: (mode) => {
				this.viewMode = mode;
				if (mode === "orbit") {
					const def = this.host.getActiveWorldDefinition();
					this.orbitDistance = Math.max(80, def.size * 0.18);
					this.syncOrbit();
				} else {
					this.syncOrtho();
				}
				this.syncTransformControlsCamera();
				this.refreshHint();
			},
			onMeshChange: (meshId) => {
				this.meshId = meshId;
			},
			onRoadStyleChange: (style) => {
				this.roadStyle = style;
				this.updateBrushColor();
			},
			onTransformModeChange: (mode) => {
				this.setTransformMode(mode);
			},
			onSave: () => this.saveEdits(),
			onCreateWorld: (sizeKm) => {
				void this.createAndEnterEditableWorld(sizeKm);
			},
			onOpenWorld: (worldId) => {
				void this.openEditableWorld(worldId);
			},
			onDeleteSelected: () => {
				void this.deleteSelected();
			},
			onUndo: () => {
				void this.undo();
			},
			onRedo: () => {
				void this.redo();
			},
		});
		this.ui.setVisible(false);
		this.store.subscribe(() => this.refreshStatus());
		this.refreshStatus();

		this.bindPointer();
		this.bindKeys();
		window.addEventListener("resize", () => {
			if (this.enabled) this.syncOrtho();
		});
	}

	get isEnabled() {
		return this.enabled;
	}

	get activeCamera(): THREE.Camera {
		if (!this.enabled) return this.host.playCamera;
		return this.viewMode === "orbit" ? this.orbitCam : this.ortho;
	}

	attachSocket(socket: Socket | null) {
		this.sync.attachSocket(socket);
		this.refreshStatus();
		if (socket?.connected && this.host.getRoomCode()) {
			this.sync.requestSnapshot();
		}
	}

	onGameActiveChanged(active: boolean) {
		const user = this.host.getAuthUser();
		this.store.setAuthorId(user?.id ?? null);
		// Edit Mode is only for logged-in users (worlds save to their account).
		const canEdit = active && Boolean(user?.id);
		this.ui.setVisible(canEdit);
		if (!canEdit && this.enabled) void this.exitEditToHub();
		if (active) void this.bindStoreToActiveWorld();
		this.refreshStatus();
	}

	/** Call when login / logout changes while the game is already active. */
	onAuthChanged() {
		this.onGameActiveChanged(this.host.isGameActive());
	}

	/**
	 * Call after switching island / valley / custom world.
	 * Resolves once the world's saved edits are on the terrain — callers must
	 * await this before sampling ground height (spawn placement).
	 */
	async onActiveWorldChanged(): Promise<void> {
		const applied = this.bindStoreToActiveWorld();
		this.sync.watchWorld(this.host.getActiveWorldDefinition().id);
		this.refreshStatus();
		this.syncBrushToWorld();
		if (this.enabled && this.host.getActiveWorldDefinition().kind !== "custom") {
			this.setEnabled(false);
			this.ui.syncEnabled(false);
		} else if (this.enabled) {
			this.recenterCameraOnTerrain();
		}
		await applied;
	}

	onRoomJoined() {
		this.sync.requestSnapshot();
		if (this.store.opCount > 0) {
			this.sync.broadcastSnapshot(this.store.toJSON());
		}
		this.refreshStatus();
	}

	/**
	 * Main Island / Valley are multiplayer hubs — not editable.
	 * Edit Mode opens a picker of the user's custom worlds (or New World).
	 */
	private async requestEnterEdit() {
		if (this.enabled) return;
		const user = this.host.getAuthUser();
		if (!user?.id || !this.host.getAuthToken()) {
			this.ui.setSaveState("saved", "Log in to edit your worlds.");
			return;
		}
		this.ui.openWorldPicker();
		try {
			const remote = await this.persistence.listMineWorlds();
			const byId = new Map<
				string,
				{ worldId: string; worldName: string; updatedAt: number; terrainSize?: number }
			>();
			for (const def of this.host.listLocalCustomWorlds()) {
				byId.set(def.id, {
					worldId: def.id,
					worldName: def.name,
					updatedAt: 0,
					terrainSize: def.size,
				});
			}
			for (const item of remote) {
				byId.set(item.worldId, {
					worldId: item.worldId,
					worldName: item.worldName,
					updatedAt: item.updatedAt,
					terrainSize: item.terrainSize,
				});
			}
			const worlds = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
			this.ui.setWorldPickerWorlds(worlds);
		} catch {
			this.ui.setWorldPickerError(
				"Could not load your worlds. Check your connection, or create a new one."
			);
		}
	}

	private async openEditableWorld(worldId: string) {
		this.ui.closeWorldPicker();
		try {
			const remote = await this.persistence.loadRemoteWorld(worldId);
			if (remote?.definition.kind === "custom") {
				this.host.ensureWorldDefinition(remote.definition);
				this.skipNextBindApply = true;
				await this.host.switchToWorldId(remote.definition.id);
				await this.applyPublishedDocument(remote.document, { silent: true });
				this.enableEditMode();
				return;
			}

			const local = this.host.getWorldDefinitionById(worldId);
			if (!local || local.kind !== "custom") {
				this.ui.openWorldPicker();
				this.ui.setWorldPickerError("That world could not be loaded.");
				return;
			}
			await this.host.switchToWorldId(local.id);
			this.enableEditMode();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unable to open world.";
			this.ui.openWorldPicker();
			this.ui.setWorldPickerError(message);
		}
	}

	private async createAndEnterEditableWorld(sizeKm: number) {
		try {
			await this.host.createNewLargeWorld(sizeKm);
			this.enableEditMode();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unable to create world.";
			this.ui.setSaveState("saved", message);
		}
	}

	private enableEditMode() {
		const def = this.host.getActiveWorldDefinition();
		if (def.kind !== "custom") return;
		if (!this.enabled) this.setEnabled(true);
		this.ui.syncEnabled(true);
	}

	/** Leave edit tools and return to the main multiplayer Island hub. */
	private async exitEditToHub() {
		this.ui.closeWorldPicker();
		if (this.enabled) this.setEnabled(false);
		this.ui.syncEnabled(false);
		const active = this.host.getActiveWorldDefinition();
		if (active.id !== "island") {
			try {
				await this.host.switchToWorldId("island");
			} catch {
				/* keep current world if hub switch fails */
			}
		}
	}

	setEnabled(enabled: boolean) {
		if (enabled && this.host.getActiveWorldDefinition().kind !== "custom") {
			return;
		}
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		this.host.setMapMode(enabled);
		this.painting = false;
		this.panning = false;
		this.orbiting = false;
		this.keys.clear();
		this.clearSelection();
		this.brushHelper.visible = enabled && this.isBrushTool(this.tool);

		if (this.transformControls) {
			this.transformControls.enabled = enabled && this.tool === "select";
			if (!enabled) {
				this.transformControls.detach();
				this.transformControls.visible = false;
			}
		}

		if (enabled) {
			// Edit mode: basin digs only — hide simulated water so strokes can merge.
			this.applier.setSpawnWaterSurfaces(false);
			this.applier.clearPonds();
			this.applier.forgetWaterSurfaceOps(this.store.toJSON().ops);
			this.recenterCameraOnTerrain();
			this.syncBrushToWorld();
			if (!this.terrainBaselineHeights) this.captureTerrainBaseline();
			this.refreshHint();
		} else {
			this.applier.setSpawnWaterSurfaces(true);
			void this.applyBakedWaterSurfaces().finally(() => {
				this.commitRebuildCollider();
			});
		}
		this.refreshStatus();
	}

	/** Frame the active terrain and reset orbit/top like opening a Blender scene. */
	private recenterCameraOnTerrain() {
		const mesh = this.host.getTerrainMesh();
		const def = this.host.getActiveWorldDefinition();
		if (mesh) {
			const box = new THREE.Box3().setFromObject(mesh);
			box.getCenter(this.target);
			// Keep surface height so orbiting a hill pivots around the land, not y=0.
			const hitY = this.sampleTerrainY(this.target.x, this.target.z);
			if (hitY != null) this.target.y = hitY;
		} else {
			this.target.set(0, 0, 0);
		}
		this.frustumSize = Math.max(90, def.size * 0.45);
		this.orbitDistance = Math.max(80, def.size * 0.18);
		this.syncOrtho();
		this.syncOrbit();
	}

	/** Brush radius must cover several heightfield cells or paint looks like a no-op. */
	private syncBrushToWorld() {
		const def = this.host.getActiveWorldDefinition();
		const cell = def.size / Math.max(1, def.segments);
		const minR = 0.1;
		const maxR = Math.max(24, cell * 12);
		const defaultR = Math.max(this.brushRadius, minR);
		this.brushRadius = THREE.MathUtils.clamp(defaultR, minR, maxR);
		this.ui.setBrushLimits(minR, maxR, this.brushRadius);
		this.brushHelper.scale.setScalar(this.brushRadius);
	}

	private refreshHint() {
		if (this.tool === "select") {
			this.ui.setHint(
				"Select mesh · G move · R rotate · S scale · drag gizmo · Delete removes"
			);
			return;
		}
		if (this.tool === "place-mesh") {
			this.ui.setHint(
				"Pick a thumbnail, click terrain to place · Select tool to move / rotate / scale"
			);
			return;
		}
		if (this.viewMode === "orbit") {
			this.ui.setHint(
				"Orbit: drag to rotate around target · Shift-drag / WASD pan · Scroll zoom · Q/E height · click to focus"
			);
			return;
		}
		if (this.tool === "paint-water") {
			this.ui.setHint(
				"Water: dig basin only · Save World fills continuous water · Exit Edit to see it"
			);
			return;
		}
		this.ui.setHint(
			"Top view: drag / WASD pan · Scroll zoom · switch to Orbit to look around hills"
		);
	}

	private setTransformMode(mode: EditTransformMode) {
		this.transformMode = mode;
		this.transformControls?.setMode(mode);
	}

	private syncTransformControlsCamera() {
		if (!this.transformControls) return;
		this.transformControls.camera = this.activeCamera;
	}

	private sampleTerrainY(x: number, z: number): number | null {
		const mesh = this.host.getTerrainMesh();
		const heights = this.host.getTerrainHeights();
		const def = this.host.getActiveWorldDefinition();
		if (!mesh || !heights) return null;
		const half = def.size * 0.5;
		const col = THREE.MathUtils.clamp(
			Math.round(((x + half) / def.size) * def.segments),
			0,
			def.segments
		);
		const row = THREE.MathUtils.clamp(
			Math.round(((z + half) / def.size) * def.segments),
			0,
			def.segments
		);
		return heights[row + col * (def.segments + 1)] ?? null;
	}

	update() {
		if (!this.enabled) return;
		this.updateCameraKeys();
		if (this.viewMode === "top") this.syncOrtho();
		else this.syncOrbit();
		this.syncTransformControlsCamera();
		if (this.selectionHelper && this.selectedEntityId) {
			const obj = this.applier.getEntityObject(this.selectedEntityId);
			if (obj) this.selectionHelper.setFromObject(obj);
		}
	}

	async saveEdits() {
		const user = this.host.getAuthUser();
		if (!user?.id || !this.host.getAuthToken()) {
			this.ui.setSaveState("saved", "Log in to save worlds to your account.");
			return;
		}
		this.ui.setSaveState("saving");
		await this.bakeContinuousWaterSurfaces();
		const result = await this.persistence.save({ download: false });
		this.ui.setSaveState("saved", result.message);
		this.refreshStatus();

		// Push saved world to anyone playing this worldId (same room / watchers).
		if (result.syncedToBackend) {
			this.host.onWorldsChanged?.();
			const def = this.host.getActiveWorldDefinition();
			this.lastPublishedAt = result.document.updatedAt;
			this.sync.broadcastWorldSaved({
				worldId: result.document.worldId,
				document: result.document,
				definition: def.kind === "custom" ? def : null,
				updatedAt: result.document.updatedAt,
			});
		}
	}

	/**
	 * Merge all water dig strokes into continuous basin fill ops (one Pond per lake).
	 * Dig ops stay; old createSurface ops are replaced. Ponds spawn only outside edit mode.
	 */
	private async bakeContinuousWaterSurfaces() {
		const ops = this.store.toJSON().ops;
		const stamps: Array<{ x: number; z: number; radius: number }> = [];
		for (const op of ops) {
			if (op.type !== "paint-water") continue;
			if (!op.createSurface) {
				stamps.push({ x: op.x, z: op.z, radius: op.radius });
			} else if (op.basin?.cells?.length) {
				// Legacy fills: treat saved cells as tiny stamps so re-save keeps them.
				for (const c of op.basin.cells) {
					stamps.push({ x: c.x, z: c.z, radius: 0.55 });
				}
			}
		}

		this.applier.clearPonds();
		this.applier.forgetWaterSurfaceOps(ops);
		this.store.stripWaterSurfaceOps();

		if (!stamps.length) return;

		const basins = this.applier.collectBasinsFromStamps(stamps);
		for (const basin of basins) {
			const op = this.store.createOp({
				type: "paint-water",
				x: basin.centerX,
				z: basin.centerZ,
				radius: Math.max(
					2,
					Math.hypot(basin.width, basin.depth) * 0.35
				),
				createSurface: true,
				basin,
			});
			this.store.append(op, { trackHistory: false });
			if (!this.enabled) {
				await this.applier.apply(op);
			}
		}
	}

	/** Spawn Pond meshes from baked createSurface ops (play mode). */
	private async applyBakedWaterSurfaces() {
		this.applyingRemote = true;
		try {
			for (const op of this.store.toJSON().ops) {
				if (op.type === "paint-water" && op.createSurface) {
					await this.applier.apply(op);
				}
			}
		} finally {
			this.applyingRemote = false;
		}
	}

	async reapplyStoredEdits() {
		const doc = this.store.toJSON();
		this.clearSelection();
		this.applier.clearEntities();
		this.applier.clearApplied();
		const generation = ++this.terrainApplyGeneration;
		if (!this.terrainBaselineHeights) this.captureTerrainBaseline();
		this.restoreTerrainBaseline();
		if (!doc.ops.length) {
			this.rebuildCollider();
			this.onTerrainSettled();
			this.refreshStatus();
			return;
		}
		this.applyingRemote = true;
		try {
			await this.applier.applyMany(doc.ops);
			if (generation !== this.terrainApplyGeneration) return;
			this.rebuildCollider();
			this.onTerrainSettled();
		} finally {
			this.applyingRemote = false;
		}
		this.refreshStatus();
	}

	/**
	 * Rebind the store to the active world and replay its edits.
	 * Returns a promise that resolves when the terrain is final.
	 */
	private bindStoreToActiveWorld(): Promise<void> {
		const def = this.host.getActiveWorldDefinition();
		// switchWorld calls onGameActiveChanged and onActiveWorldChanged back to
		// back; without this, two replays race over the same heights array and the
		// second captures a half-sculpted baseline as "pristine".
		if (this.bindTask && this.bindTaskWorldId === def.id) return this.bindTask;

		const task = this.runBindToActiveWorld(def);
		this.bindTask = task;
		this.bindTaskWorldId = def.id;
		void task.finally(() => {
			if (this.bindTask === task) {
				this.bindTask = null;
				this.bindTaskWorldId = null;
			}
		});
		return task;
	}

	private async runBindToActiveWorld(def: WorldDefinition): Promise<void> {
		const isHub = def.kind === "island" || def.kind === "valley";
		// Hub worlds are not editable — drop any sculpt doc that leaked onto them.
		if (isHub) {
			this.sessionDocs.delete(def.id);
		}
		// Park the outgoing world's in-progress edits in RAM before rebinding.
		this.stashActiveDoc();
		const existing = isHub ? null : this.sessionDocs.get(def.id) ?? null;
		const skipApply = this.skipNextBindApply;
		this.skipNextBindApply = false;

		this.store.switchWorld(
			{
				worldId: def.id,
				worldName: def.name,
				terrainSize: def.size,
				segments: def.segments,
			},
			existing
		);
		this.clearSelection();
		this.applier.clearEntities();
		this.applier.clearApplied();
		// Baseline = pristine terrain before any edit ops.
		this.captureTerrainBaseline();
		this.applier.setSpawnWaterSurfaces(!this.enabled);

		if (skipApply || isHub || !existing?.ops.length) {
			// Cancel any in-flight applyMany from the previous world.
			this.terrainApplyGeneration++;
			this.refreshStatus();
			return;
		}

		const generation = ++this.terrainApplyGeneration;
		await this.applier.applyMany(existing.ops);
		if (generation !== this.terrainApplyGeneration) return;
		this.rebuildCollider();
		// Grass was generated from the pristine procedural heights when the
		// world was built — resample it onto the sculpted terrain.
		this.onTerrainSettled();
		this.refreshStatus();
	}

	/**
	 * Snapshot the store into the RAM cache, so re-binding (world switch, login,
	 * game start) never rolls the live document back. Hubs are never cached.
	 */
	private stashActiveDoc() {
		if (this.store.opCount === 0) return;
		const currentId = this.store.worldId;
		const currentDef = this.host.getWorldDefinitionById(currentId);
		if (currentDef && currentDef.kind !== "custom") return;
		this.sessionDocs.set(currentId, this.store.toJSON());
	}

	private isBrushTool(tool: EditTool) {
		return tool === "sculpt" || tool === "paint-road" || tool === "paint-water";
	}

	private updateBrushColor() {
		const mat = this.brushHelper.material as THREE.MeshBasicMaterial;
		if (this.tool === "paint-road") mat.color.setHex(0xa8906e);
		else if (this.tool === "paint-water") mat.color.setHex(0x7eb8e8);
		else mat.color.setHex(0xc8e6a0);
	}

	private refreshStatus() {
		const room = this.host.getRoomCode();
		const def = this.host.getActiveWorldDefinition();
		this.ui.setSyncStatus({
			opCount: this.store.opCount,
			dirty: this.store.isDirty,
			live: Boolean(room) || typeof BroadcastChannel !== "undefined",
			roomCode: room || null,
			worldName: def.name,
		});
		this.ui.setUndoRedoState(this.store.canUndo, this.store.canRedo);
	}

	private captureTerrainBaseline() {
		const heights = this.host.getTerrainHeights();
		this.terrainBaselineHeights = heights ? heights.slice() : null;
		const mesh = this.host.getTerrainMesh();
		const geo = mesh?.geometry as THREE.BufferGeometry | undefined;
		const colorAttr = geo?.getAttribute("color") as THREE.BufferAttribute | undefined;
		this.terrainBaselineColors = colorAttr
			? Float32Array.from(colorAttr.array as ArrayLike<number>)
			: null;
		const mat = mesh?.material as THREE.MeshPhongMaterial | undefined;
		this.terrainHadVertexColors = Boolean(mat?.vertexColors);
	}

	private restoreTerrainBaseline() {
		const heights = this.host.getTerrainHeights();
		const mesh = this.host.getTerrainMesh();
		if (!heights || !mesh || !this.terrainBaselineHeights) return;
		if (heights.length !== this.terrainBaselineHeights.length) return;

		heights.set(this.terrainBaselineHeights);
		const geo = mesh.geometry as THREE.BufferGeometry;
		const positions = geo.attributes.position as THREE.BufferAttribute;
		const def = this.host.getActiveWorldDefinition();
		const half = def.size * 0.5;
		const segs = def.segments;

		for (let i = 0; i < positions.count; i++) {
			const x = positions.getX(i);
			const z = positions.getZ(i);
			const col = THREE.MathUtils.clamp(
				Math.round(((x + half) / def.size) * segs),
				0,
				segs
			);
			const row = THREE.MathUtils.clamp(
				Math.round(((z + half) / def.size) * segs),
				0,
				segs
			);
			positions.setY(i, heights[row + col * (segs + 1)]!);
		}
		positions.needsUpdate = true;
		geo.computeVertexNormals();
		geo.computeBoundingBox();
		geo.computeBoundingSphere();
		mesh.updateMatrixWorld(true);

		if (this.terrainBaselineColors) {
			let colorAttr = geo.getAttribute("color") as THREE.BufferAttribute | undefined;
			if (!colorAttr || colorAttr.array.length !== this.terrainBaselineColors.length) {
				colorAttr = new THREE.BufferAttribute(
					this.terrainBaselineColors.slice(),
					3
				);
				geo.setAttribute("color", colorAttr);
			} else {
				(colorAttr.array as Float32Array).set(this.terrainBaselineColors);
				colorAttr.needsUpdate = true;
			}
			const mat = mesh.material as THREE.MeshPhongMaterial;
			mat.vertexColors = true;
			mat.color.setHex(0xffffff);
			mat.needsUpdate = true;
		} else {
			if (geo.getAttribute("color")) geo.deleteAttribute("color");
			const mat = mesh.material as THREE.MeshPhongMaterial;
			mat.vertexColors = this.terrainHadVertexColors;
			if (!mat.vertexColors) {
				mat.color.set(this.host.getScenePropsTerrainColor());
			}
			mat.needsUpdate = true;
		}

		setIslandTerrain(mesh);
		// Grass is NOT rebuilt here — every caller applies edit ops next, and the
		// rebuild has to happen after that or blades match the flat baseline.
	}

	private async rebuildFromOps() {
		this.clearSelection();
		this.applier.clearEntities();
		this.applier.clearApplied();
		const generation = ++this.terrainApplyGeneration;
		this.restoreTerrainBaseline();
		const ops = this.store.toJSON().ops;
		if (ops.length) {
			this.applyingRemote = true;
			try {
				await this.applier.applyMany(ops);
			} finally {
				this.applyingRemote = false;
			}
		}
		if (generation !== this.terrainApplyGeneration) return;
		this.rebuildCollider();
		this.onTerrainSettled();
		this.refreshStatus();
	}

	async undo() {
		if (this.historyBusy || !this.store.canUndo) return;
		this.historyBusy = true;
		try {
			if (!this.store.undo()) return;
			await this.rebuildFromOps();
			if (!this.applyingRemote) {
				this.sync.broadcastSnapshot(this.store.toJSON());
			}
		} finally {
			this.historyBusy = false;
		}
	}

	async redo() {
		if (this.historyBusy || !this.store.canRedo) return;
		this.historyBusy = true;
		try {
			const batch = this.store.redo();
			if (!batch) return;
			await this.rebuildFromOps();
			if (!this.applyingRemote) {
				this.sync.broadcastSnapshot(this.store.toJSON());
			}
		} finally {
			this.historyBusy = false;
		}
	}

	private async commitOp(op: WorldEditOp) {
		if (!this.store.append(op)) return;
		await this.applier.apply(op);
		if (!this.applyingRemote) this.sync.broadcastOp(op);
		this.refreshStatus();
	}

	/** True when remote edits may mutate the active terrain. */
	private acceptsRemoteEditsFor(worldId: string | undefined): boolean {
		const active = this.host.getActiveWorldDefinition();
		// Never sculpt the Island / Valley hubs from remote edit traffic.
		if (active.kind !== "custom") return false;
		if (active.id !== this.store.worldId) return false;
		if (worldId && worldId !== active.id) return false;
		return true;
	}

	private async applyIncomingOp(op: WorldEditOp, worldId?: string) {
		const resolvedWorldId = worldId ?? this.store.worldId;
		if (!this.acceptsRemoteEditsFor(resolvedWorldId)) return;
		if (this.applier.hasApplied(op.id)) return;
		this.applyingRemote = true;
		try {
			this.store.append(op, { trackHistory: false });
			await this.applier.apply(op);
			if (op.type === "sculpt") this.scheduleRemoteColliderFlush();
		} finally {
			this.applyingRemote = false;
		}
		this.refreshStatus();
	}

	private scheduleRemoteColliderFlush() {
		if (this.remoteColliderTimer != null) window.clearTimeout(this.remoteColliderTimer);
		this.remoteColliderTimer = window.setTimeout(() => {
			this.applier.flushColliderIfNeeded();
			this.rebuildCollider();
			// Debounce doubles as "remote stroke ended" — one resample per burst,
			// so a peer's hills do not swallow our grass.
			this.onTerrainSettled();
			this.remoteColliderTimer = null;
		}, 120);
	}

	private async applyIncomingSnapshot(
		doc: WorldEditDocument,
		worldId?: string
	) {
		const resolvedWorldId = worldId ?? doc.worldId;
		if (!this.acceptsRemoteEditsFor(resolvedWorldId)) return;
		if (doc.worldId && doc.worldId !== this.host.getActiveWorldDefinition().id) {
			return;
		}
		if (this.store.opCount > doc.ops.length) return;
		await this.applyPublishedDocument(doc, { silent: true });
	}

	/**
	 * Owner saved the world — players already in it apply the new document
	 * without reload or UI interruption.
	 */
	private async onWorldSaved(payload: {
		worldId: string;
		document: WorldEditDocument;
		definition?: import("../worlds/worldTypes").WorldDefinition | null;
		updatedAt: number;
	}) {
		if (!payload?.document || !payload.worldId) return;
		if (payload.updatedAt && payload.updatedAt <= this.lastPublishedAt) return;

		const activeId = this.host.getActiveWorldDefinition().id;
		if (payload.worldId !== activeId && payload.document.worldId !== activeId) {
			return;
		}
		if (!this.acceptsRemoteEditsFor(payload.worldId)) return;

		// Editor who just saved already has this content.
		if (this.enabled && this.store.toJSON().updatedAt >= payload.document.updatedAt) {
			this.lastPublishedAt = Math.max(this.lastPublishedAt, payload.document.updatedAt);
			return;
		}

		if (payload.definition?.kind === "custom") {
			this.host.ensureWorldDefinition(payload.definition);
		}

		await this.applyPublishedDocument(payload.document, { silent: true });
		this.lastPublishedAt = Math.max(
			this.lastPublishedAt,
			payload.document.updatedAt || payload.updatedAt || 0
		);
	}

	/** Authoritative rebuild from a published / remote document (baseline + ops). */
	private async applyPublishedDocument(
		doc: WorldEditDocument,
		options?: { silent?: boolean }
	) {
		const active = this.host.getActiveWorldDefinition();
		if (doc.worldId && doc.worldId !== active.id) return;
		if (active.kind !== "custom") return;

		if (this.applyingPublished) return;
		this.applyingPublished = true;
		this.applyingRemote = true;
		const generation = ++this.terrainApplyGeneration;
		try {
			this.clearSelection();
			this.applier.setSpawnWaterSurfaces(!this.enabled);
			this.applier.clearEntities();
			this.applier.clearApplied();
			this.store.loadDocument(doc);
			this.sessionDocs.set(this.store.worldId, this.store.toJSON());
			if (!this.terrainBaselineHeights) this.captureTerrainBaseline();
			this.restoreTerrainBaseline();
			if (doc.ops.length) {
				await this.applier.applyMany(doc.ops);
			}
			if (generation !== this.terrainApplyGeneration) return;
			this.rebuildCollider();
			this.onTerrainSettled();
		} finally {
			this.applyingRemote = false;
			this.applyingPublished = false;
		}
		this.refreshStatus();
		if (!options?.silent) {
			this.ui.setSaveState("saved", "World updated.");
		}
	}

	/**
	 * Called when a multiplayer room reports its bound worldId.
	 * Loads that world, then peers exchange edit snapshots over the socket.
	 */
	async onRoomWorldBound(worldId: string) {
		if (!worldId) return;
		this.sync.watchWorld(worldId);
		const active = this.host.getActiveWorldDefinition();
		if (active.id !== worldId) {
			let def = this.host.getWorldDefinitionById(worldId);
			if (!def) {
				const remote = await this.persistence.loadRemoteWorld(worldId);
				if (remote) {
					this.host.ensureWorldDefinition(remote.definition);
					def = remote.definition;
					this.skipNextBindApply = true;
					await this.host.switchToWorldId(def.id);
					await this.applyPublishedDocument(remote.document, { silent: true });
					this.refreshStatus();
					return;
				}
			}
			if (def) await this.host.switchToWorldId(worldId);
		}
		this.onRoomJoined();
	}

	/** Active world id for create-room / join payloads. */
	getActiveWorldId() {
		return this.host.getActiveWorldDefinition().id;
	}

	/** The logged-in user's worlds from the DB (never from browser storage). */
	async listMyWorlds() {
		return this.persistence.listMineWorlds();
	}

	/** Drop RAM-cached edit docs (logout) so the next account starts clean. */
	forgetCachedWorlds(keepWorldId?: string) {
		for (const worldId of [...this.sessionDocs.keys()]) {
			if (worldId !== keepWorldId) this.sessionDocs.delete(worldId);
		}
	}

	/**
	 * Fetch a saved world from the DB so the host can switch into it.
	 * Its edit document is cached in RAM so the following bind replays it.
	 */
	async loadWorldFromDb(worldId: string): Promise<WorldDefinition | null> {
		const remote = await this.persistence.loadRemoteWorld(worldId);
		if (!remote) return null;
		this.sessionDocs.set(remote.definition.id, remote.document);
		return remote.definition;
	}

	/** Publish current world JSON to the DB (requires login). */
	async publishWorld() {
		return this.saveEdits();
	}

	private syncOrtho() {
		const aspect =
			this.host.canvas.clientWidth / Math.max(1, this.host.canvas.clientHeight);
		const halfH = this.frustumSize * 0.5;
		const halfW = halfH * aspect;
		this.ortho.left = -halfW;
		this.ortho.right = halfW;
		this.ortho.top = halfH;
		this.ortho.bottom = -halfH;
		const camY = Math.max(220, this.host.getActiveWorldDefinition().size * 0.35);
		this.ortho.position.set(this.target.x, camY, this.target.z);
		this.ortho.lookAt(this.target.x, 0, this.target.z);
		this.ortho.updateProjectionMatrix();
	}

	private syncOrbit() {
		const aspect =
			this.host.canvas.clientWidth / Math.max(1, this.host.canvas.clientHeight);
		this.orbitCam.aspect = aspect;
		const cosPitch = Math.cos(this.orbitPitch);
		this.orbitCam.position.set(
			this.target.x + Math.sin(this.orbitYaw) * cosPitch * this.orbitDistance,
			this.target.y + Math.sin(this.orbitPitch) * this.orbitDistance,
			this.target.z + Math.cos(this.orbitYaw) * cosPitch * this.orbitDistance
		);
		this.orbitCam.lookAt(this.target.x, this.target.y, this.target.z);
		this.orbitCam.updateProjectionMatrix();
	}

	private getSculptTarget(): TerrainSculptTarget | null {
		const mesh = this.host.getTerrainMesh();
		const heights = this.host.getTerrainHeights();
		const def = this.host.getActiveWorldDefinition();
		if (!mesh || !heights) return null;
		return {
			mesh,
			heights,
			nrows: def.segments,
			ncols: def.segments,
			size: def.size,
		};
	}

	private rebuildCollider() {
		const heights = this.host.getTerrainHeights();
		const mesh = this.host.getTerrainMesh();
		const def = this.host.getActiveWorldDefinition();
		if (!heights || !mesh) return;

		this.host.getTerrainHandle()?.dispose();
		const handle = createTerrainHeightfieldCollider(
			heights,
			def.segments,
			def.segments,
			def.size
		);
		this.host.setTerrainHandle(handle);
		setIslandTerrain(mesh);
	}

	private commitRebuildCollider() {
		this.applier.flushColliderIfNeeded();
		const op = this.store.createOp({ type: "rebuild-collider" });
		void this.commitOp(op).then(() => this.onTerrainSettled());
	}

	/**
	 * The heightfield is final — re-fit everything that was placed against the
	 * old surface. Must run AFTER edit ops are applied.
	 *
	 * Grass positions are baked into instance matrices, so without this, blades
	 * sit inside raised terrain (visible through the hollow underside) or float
	 * over dug ground. Same for the player, who can be left inside a hill.
	 */
	private onTerrainSettled() {
		// Slopes steeper than 65° stay bare — the filter re-runs on every rebuild.
		this.host.rebuildEditGrass();
		void this.reapplyGrassMasksOnly();
		this.host.liftPlayersAboveTerrain?.();
	}

	/** After grass rebuild, re-apply road/water grass clears without resetting terrain. */
	private async reapplyGrassMasksOnly() {
		const grass = this.host.getGrassField();
		if (!grass) return;
		for (const op of this.store.toJSON().ops) {
			if (op.type === "paint-road") {
				grass.maskRoadCircle(op.x, op.z, op.radius);
			} else if (op.type === "paint-water" && op.createSurface) {
				const r =
					op.basin?.digRadius ??
					op.radius ??
					Math.max(op.basin?.width ?? 0, op.basin?.depth ?? 0) * 0.55;
				if (r > 0) {
					grass.maskRoadCircle(
						op.basin?.centerX ?? op.x,
						op.basin?.centerZ ?? op.z,
						r + 1
					);
				}
			}
		}
	}

	private bindKeys() {
		window.addEventListener("keydown", (event) => {
			if (!this.enabled) return;
			// Editor shortcuts must not fire while a form / field has focus.
			if (isGameKeyBlocked(event)) {
				this.keys.clear();
				return;
			}
			const key = (event.key ?? "").toLowerCase();
			const mod = event.metaKey || event.ctrlKey;
			if (mod && key === "z") {
				event.preventDefault();
				if (event.shiftKey) void this.redo();
				else void this.undo();
				return;
			}
			if (mod && key === "y") {
				event.preventDefault();
				void this.redo();
				return;
			}
			if (
				(event.key === "Delete" || event.key === "Backspace") &&
				this.tool === "select" &&
				this.selectedEntityId
			) {
				event.preventDefault();
				void this.deleteSelected();
				return;
			}
			if (this.tool === "select" && this.selectedEntityId) {
				if (key === "g") {
					event.preventDefault();
					this.ui.setTransformMode("translate");
					return;
				}
				if (key === "r") {
					event.preventDefault();
					this.ui.setTransformMode("rotate");
					return;
				}
				if (key === "s" && !(event.metaKey || event.ctrlKey)) {
					event.preventDefault();
					this.ui.setTransformMode("scale");
					return;
				}
			}
			if (this.tool !== "camera") return;
			if (["w", "a", "s", "d", "q", "e"].includes(key)) {
				this.keys.add(key);
				event.preventDefault();
			}
		});
		window.addEventListener("keyup", (event) => {
			const key = (event.key ?? "").toLowerCase();
			if (key) this.keys.delete(key);
		});
	}

	private updateCameraKeys() {
		if (this.tool !== "camera" || this.keys.size === 0) return;
		const speed =
			(this.viewMode === "orbit" ? this.orbitDistance : this.frustumSize) * 0.012;

		const right = new THREE.Vector3();
		const forward = new THREE.Vector3();
		if (this.viewMode === "orbit") {
			this.orbitCam.getWorldDirection(forward);
			forward.y = 0;
			forward.normalize();
			right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
		} else {
			forward.set(0, 0, -1);
			right.set(1, 0, 0);
		}

		if (this.keys.has("w")) this.target.addScaledVector(forward, speed);
		if (this.keys.has("s")) this.target.addScaledVector(forward, -speed);
		if (this.keys.has("a")) this.target.addScaledVector(right, -speed);
		if (this.keys.has("d")) this.target.addScaledVector(right, speed);
		if (this.keys.has("q")) this.target.y = Math.max(-40, this.target.y - speed * 0.5);
		if (this.keys.has("e")) this.target.y = Math.min(120, this.target.y + speed * 0.5);

		this.clampTargetToMap();
	}

	private bindPointer() {
		const el = this.host.canvas;

		el.addEventListener(
			"pointerdown",
			(event) => {
				if (!this.enabled) return;
				if (this.transformDragging) return;

				// Blender-like navigation (any tool):
				//   MMB / Alt+LMB / RMB = orbit   ·   Shift+drag those = pan
				const wantOrbitNav =
					this.viewMode === "orbit" &&
					(event.button === 1 ||
						event.button === 2 ||
						(event.button === 0 && event.altKey));

				if (wantOrbitNav) {
					this.lastPan.set(event.clientX, event.clientY);
					if (event.shiftKey) this.panning = true;
					else this.orbiting = true;
					el.setPointerCapture(event.pointerId);
					event.preventDefault();
					return;
				}

				if (event.button === 1 || event.button === 2) {
					this.lastPan.set(event.clientX, event.clientY);
					this.panning = true;
					el.setPointerCapture(event.pointerId);
					event.preventDefault();
					return;
				}

				if (event.button !== 0) return;

				// Camera tool: LMB drag orbits (look around hills); Shift+LMB pans.
				// Short click still snaps focus to the surface hit.
				if (this.tool === "camera") {
					this.lastPan.set(event.clientX, event.clientY);
					this.pointerDownPos.set(event.clientX, event.clientY);
					this.cameraClickFocus = true;
					if (this.viewMode === "orbit" && !event.shiftKey) {
						this.orbiting = true;
					} else {
						this.panning = true;
					}
					el.setPointerCapture(event.pointerId);
					event.preventDefault();
					return;
				}

				if (this.tool === "select") {
					// Let TransformControls own the pointer when hovering a gizmo axis.
					if (this.transformControls?.axis) return;
					this.handleSelectClick(event.clientX, event.clientY);
					event.preventDefault();
					return;
				}

				if (
					this.tool === "sculpt" ||
					this.tool === "paint-road" ||
					this.tool === "paint-water"
				) {
					const hit = this.pickTerrain(event.clientX, event.clientY);
					if (hit) {
						this.store.beginStroke();
						this.painting = true;
						this.pointerDownPos.set(event.clientX, event.clientY);
						this.cameraClickFocus = true; // might become a focus if not dragged
						void this.brushAt(hit);
						el.setPointerCapture(event.pointerId);
					}
					return;
				}

				if (this.tool === "place-mesh") {
					const hit = this.pickTerrain(event.clientX, event.clientY);
					if (hit) void this.placeAt(hit);
				}
			},
			{ passive: false }
		);

		el.addEventListener("pointermove", (event) => {
			if (!this.enabled) return;
			if (this.transformDragging) return;

			if (this.orbiting) {
				const dx = event.clientX - this.lastPan.x;
				const dy = event.clientY - this.lastPan.y;
				this.lastPan.set(event.clientX, event.clientY);
				this.cameraClickFocus = false;
				this.orbitYaw -= dx * 0.005;
				this.orbitPitch = THREE.MathUtils.clamp(
					this.orbitPitch + dy * 0.005,
					0.05,
					1.45
				);
				this.syncOrbit();
				return;
			}

			if (this.panning) {
				const dx = event.clientX - this.lastPan.x;
				const dy = event.clientY - this.lastPan.y;
				this.lastPan.set(event.clientX, event.clientY);
				if (Math.hypot(dx, dy) > 2) this.cameraClickFocus = false;
				this.panCamera(dx, dy);
				return;
			}

			const hit = this.pickTerrain(event.clientX, event.clientY);
			if (hit) {
				this.brushHelper.position.set(hit.x, hit.y + 0.15, hit.z);
				this.brushHelper.visible = this.isBrushTool(this.tool);
				if (
					this.painting &&
					(this.tool === "sculpt" ||
						this.tool === "paint-road" ||
						this.tool === "paint-water")
				) {
					void this.brushAt(hit);
				}
			}
		});

		el.addEventListener("pointerup", (event) => {
			if (!this.enabled) return;
			if (this.painting) {
				const finishingTerrain =
					this.tool === "sculpt" || this.tool === "paint-water";
				this.painting = false;
				if (finishingTerrain) this.commitRebuildCollider();
				this.store.endStroke();
			}

			// Short click focuses the camera on that map spot (surface height).
			if (
				this.tool === "camera" &&
				this.cameraClickFocus &&
				event.button === 0
			) {
				const moved = Math.hypot(
					event.clientX - this.pointerDownPos.x,
					event.clientY - this.pointerDownPos.y
				);
				if (moved < 6) {
					const hit = this.pickTerrain(event.clientX, event.clientY);
					if (hit) {
						this.target.copy(hit);
						this.clampTargetToMap();
						if (this.viewMode === "orbit") this.syncOrbit();
						else this.syncOrtho();
					}
				}
			}

			this.cameraClickFocus = false;
			this.panning = false;
			this.orbiting = false;
			try {
				el.releasePointerCapture(event.pointerId);
			} catch {
				/* ignore */
			}
		});

		el.addEventListener(
			"wheel",
			(event) => {
				if (!this.enabled) return;
				event.preventDefault();
				const size = this.host.getActiveWorldDefinition().size;
				if (this.viewMode === "orbit") {
					const next = this.orbitDistance * (event.deltaY > 0 ? 1.1 : 0.9);
					this.orbitDistance = THREE.MathUtils.clamp(next, 12, size * 0.95);
					this.syncOrbit();
				} else {
					const next = this.frustumSize * (event.deltaY > 0 ? 1.1 : 0.9);
					this.frustumSize = THREE.MathUtils.clamp(next, 40, size * 1.2);
					this.syncOrtho();
				}
			},
			{ passive: false }
		);

		el.addEventListener("contextmenu", (event) => {
			if (this.enabled) event.preventDefault();
		});
	}

	/** Move look-at / ortho center across the map (orbit + top). */
	private panCamera(dx: number, dy: number) {
		if (this.viewMode === "orbit") {
			const right = new THREE.Vector3();
			const forward = new THREE.Vector3();
			this.orbitCam.getWorldDirection(forward);
			forward.y = 0;
			if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
			else forward.normalize();
			right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
			const scale = this.orbitDistance * 0.0035;
			this.target.addScaledVector(right, -dx * scale);
			this.target.addScaledVector(forward, dy * scale);
			this.clampTargetToMap();
			this.syncOrbit();
			return;
		}

		const aspect =
			this.host.canvas.clientWidth / Math.max(1, this.host.canvas.clientHeight);
		const worldPerPxY = this.frustumSize / this.host.canvas.clientHeight;
		const worldPerPxX = (this.frustumSize * aspect) / this.host.canvas.clientWidth;
		this.target.x -= dx * worldPerPxX;
		this.target.z -= dy * worldPerPxY;
		this.clampTargetToMap();
	}

	private clampTargetToMap() {
		const half = this.host.getActiveWorldDefinition().size * 0.48;
		this.target.x = THREE.MathUtils.clamp(this.target.x, -half, half);
		this.target.z = THREE.MathUtils.clamp(this.target.z, -half, half);
	}

	private pickTerrain(clientX: number, clientY: number): THREE.Vector3 | null {
		const rect = this.host.canvas.getBoundingClientRect();
		this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
		this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
		this.raycaster.setFromCamera(this.pointer, this.activeCamera);
		const mesh = this.host.getTerrainMesh();
		if (!mesh) return null;
		const hits = this.raycaster.intersectObject(mesh, false);
		if (!hits.length) return null;
		this.hitPoint.copy(hits[0].point);
		return this.hitPoint;
	}

	private async brushAt(point: THREE.Vector3) {
		const now = performance.now();
		if (now - this.lastPaintAt < PAINT_MIN_INTERVAL_MS) return;
		this.lastPaintAt = now;

		if (this.tool === "sculpt") {
			const op = this.store.createOp({
				type: "sculpt",
				brush: this.sculpt,
				x: point.x,
				z: point.z,
				radius: this.brushRadius,
				strength: this.brushStrength,
			});
			await this.commitOp(op);
			return;
		}

		if (this.tool === "paint-road") {
			await this.commitOp(
				this.store.createOp({
					type: "paint-road",
					x: point.x,
					z: point.z,
					radius: this.brushRadius,
				})
			);
		}

		if (this.tool === "paint-water") {
			await this.commitOp(
				this.store.createOp({
					type: "paint-water",
					x: point.x,
					z: point.z,
					radius: this.brushRadius,
					createSurface: false,
				})
			);
		}
	}

	private handleSelectClick(clientX: number, clientY: number) {
		const rect = this.host.canvas.getBoundingClientRect();
		this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
		this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
		this.raycaster.setFromCamera(this.pointer, this.activeCamera);
		const hits = this.raycaster.intersectObjects(
			this.applier.getSelectableObjects(),
			true
		);
		if (!hits.length) {
			this.clearSelection();
			return;
		}
		const entityId = this.applier.getEntityIdAtObject(hits[0].object);
		if (!entityId) {
			this.clearSelection();
			return;
		}
		// First click selects; second click on same object deselects.
		if (this.selectedEntityId === entityId) {
			this.clearSelection();
			return;
		}
		this.setSelection(entityId);
	}

	private setSelection(entityId: string) {
		this.selectedEntityId = entityId;
		const obj = this.applier.getEntityObject(entityId);
		if (!obj) {
			this.clearSelection();
			return;
		}
		if (this.selectionHelper) {
			this.host.scene.remove(this.selectionHelper);
			this.selectionHelper = null;
		}
		this.selectionHelper = new THREE.BoxHelper(obj, 0xffe08a);
		this.selectionHelper.name = "edit-selection";
		this.host.scene.add(this.selectionHelper);

		if (this.transformControls && this.applier.canTransformEntity(entityId)) {
			this.syncTransformControlsCamera();
			this.transformControls.setMode(this.transformMode);
			this.transformControls.attach(obj);
			this.transformControls.enabled = this.tool === "select";
			this.transformControls.visible = true;
		} else {
			this.transformControls?.detach();
			if (this.transformControls) this.transformControls.visible = false;
		}
		this.refreshHint();
	}

	private clearSelection() {
		this.selectedEntityId = null;
		this.transformDragging = false;
		if (this.transformControls) {
			this.transformControls.detach();
			this.transformControls.visible = false;
			this.transformControls.enabled = false;
		}
		if (this.selectionHelper) {
			this.host.scene.remove(this.selectionHelper);
			(this.selectionHelper.geometry as THREE.BufferGeometry | undefined)?.dispose();
			(this.selectionHelper.material as THREE.Material | undefined)?.dispose();
			this.selectionHelper = null;
		}
	}

	private async commitSelectionTransform() {
		if (!this.selectedEntityId || !this.applier.canTransformEntity(this.selectedEntityId)) {
			return;
		}
		const obj = this.applier.getEntityObject(this.selectedEntityId);
		if (!obj) return;
		const scale = (obj.scale.x + obj.scale.y + obj.scale.z) / 3;
		await this.commitOp(
			this.store.createOp({
				type: "transform-entity",
				entityId: this.selectedEntityId,
				x: obj.position.x,
				y: obj.position.y,
				z: obj.position.z,
				scale: Math.max(0.05, scale),
				rotationY: obj.rotation.y,
				rotationX: obj.rotation.x,
				rotationZ: obj.rotation.z,
			})
		);
		this.selectionHelper?.setFromObject(obj);
	}

	private async deleteSelected() {
		if (!this.selectedEntityId) return;
		const entityId = this.selectedEntityId;
		this.clearSelection();
		await this.commitOp(
			this.store.createOp({
				type: "delete-entity",
				entityId,
			})
		);
	}

	private async placeAt(point: THREE.Vector3) {
		if (this.placeBusy || this.tool !== "place-mesh") return;
		this.placeBusy = true;
		try {
			const entry = resolveEditMesh(this.meshId);
			await this.commitOp(
				this.store.createOp({
					type: "place-mesh",
					meshId: entry.id,
					x: point.x,
					z: point.z,
					scale: pickPlaceScale(entry),
					rotationY: Math.random() * Math.PI * 2,
				})
			);
		} finally {
			this.placeBusy = false;
		}
	}
}
