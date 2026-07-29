import { EDIT_MESH_CATALOG, type EditMeshId } from "../editor/meshCatalog";

export type EditTool =
	| "camera"
	| "sculpt"
	| "paint-road"
	| "place-mesh"
	| "paint-water"
	| "select";

export type SculptType = "raise" | "lower" | "smooth" | "flatten";

export type RoadStyle = "mud";

export type EditSyncStatus = {
	opCount: number;
	dirty: boolean;
	live: boolean;
	roomCode: string | null;
	worldName: string;
};

export type EditViewMode = "top" | "orbit";

export type EditModeUIOptions = {
	onToggleEdit: (enabled: boolean) => void;
	onToolChange: (tool: EditTool) => void;
	onSculptChange: (sculpt: SculptType) => void;
	onBrushChange: (radius: number, strength: number) => void;
	onViewModeChange: (mode: EditViewMode) => void;
	onMeshChange: (meshId: EditMeshId) => void;
	onRoadStyleChange: (style: RoadStyle) => void;
	onSave: () => void;
	/** Create a custom world; sizeKm is 0.1–10. */
	onCreateWorld: (sizeKm: number) => void;
	onDeleteSelected: () => void;
	onUndo: () => void;
	onRedo: () => void;
};

/**
 * Blender-like edit chrome: Camera, Sculpt, Road, Meshes, Water.
 */
export class EditModeUI {
	readonly root: HTMLElement;
	private readonly editBtn: HTMLButtonElement;
	private readonly topBar: HTMLElement;
	private readonly leftBar: HTMLElement;
	private readonly meshPanel: HTMLElement;
	private readonly roadPanel: HTMLElement;
	private readonly cameraPanel: HTMLElement;
	private readonly selectPanel: HTMLElement;
	private readonly hint: HTMLElement;
	private readonly saveBtn: HTMLButtonElement;
	private readonly undoBtn: HTMLButtonElement;
	private readonly redoBtn: HTMLButtonElement;
	private readonly statusEl: HTMLElement;
	private readonly createModal: HTMLElement;
	private enabled = false;
	private tool: EditTool = "camera";
	private sculpt: SculptType = "raise";
	private meshId: EditMeshId = "tree";
	private roadStyle: RoadStyle = "mud";

	constructor(private readonly options: EditModeUIOptions) {
		const meshButtons = EDIT_MESH_CATALOG.map(
			(entry, i) =>
				`<button type="button" data-mesh="${entry.id}" class="edit-asset${i === 0 ? " is-active" : ""}"><span>${entry.label}</span></button>`
		).join("");

		this.root = document.createElement("div");
		this.root.id = "edit-mode-ui";
		this.root.innerHTML = `
			<button type="button" class="edit-mode-toggle" id="edit-mode-toggle" title="Edit Mode">Edit Mode</button>
			<div class="edit-top-bar" id="edit-top-bar" hidden>
				<div class="edit-bar-label">Sculpt</div>
				<div class="edit-tool-row" id="edit-sculpt-tools">
					<button type="button" data-sculpt="raise" class="edit-chip is-active">Raise</button>
					<button type="button" data-sculpt="lower" class="edit-chip">Lower</button>
					<button type="button" data-sculpt="smooth" class="edit-chip">Smooth</button>
					<button type="button" data-sculpt="flatten" class="edit-chip">Flatten</button>
				</div>
				<label class="edit-slider edit-slider-pencil">
					<span id="edit-brush-size-label">Pencil</span>
					<input type="range" id="edit-brush-radius" min="0.5" max="24" step="0.5" value="3" />
					<span class="edit-slider-value" id="edit-brush-radius-value">3</span>
				</label>
				<label class="edit-slider edit-slider-strength">
					<span>Strength</span>
					<input type="range" id="edit-brush-strength" min="0.05" max="1.5" step="0.05" value="0.35" />
				</label>
				<button type="button" class="edit-chip" id="edit-undo-btn" title="Undo (Ctrl/⌘ Z)" disabled>Undo</button>
				<button type="button" class="edit-chip" id="edit-redo-btn" title="Redo (Ctrl/⌘ Shift Z)" disabled>Redo</button>
				<button type="button" class="edit-chip edit-save" id="edit-save-btn">Save World</button>
				<button type="button" class="edit-chip" id="edit-create-world-btn">New World</button>
				<button type="button" class="edit-chip edit-exit" id="edit-exit-btn">Exit Edit</button>
			</div>
			<aside class="edit-left-bar" id="edit-left-bar" hidden>
				<div class="edit-bar-label">Tools</div>
				<button type="button" data-tool="camera" class="edit-asset is-active"><span>Camera</span></button>
				<button type="button" data-tool="sculpt" class="edit-asset"><span>Sculpt</span></button>
				<button type="button" data-tool="paint-road" class="edit-asset"><span>Road</span></button>
				<button type="button" data-tool="place-mesh" class="edit-asset"><span>Meshes</span></button>
				<button type="button" data-tool="paint-water" class="edit-asset"><span>Water</span></button>
				<button type="button" data-tool="select" class="edit-asset"><span>Select</span></button>
				<div class="edit-sub-panel" id="edit-select-panel" hidden>
					<div class="edit-bar-label">Select</div>
					<button type="button" class="edit-asset" id="edit-delete-btn"><span>Delete</span></button>
				</div>
				<div class="edit-sub-panel" id="edit-camera-panel">
					<div class="edit-bar-label">View</div>
					<button type="button" data-view="top" class="edit-asset is-active"><span>Top</span></button>
					<button type="button" data-view="orbit" class="edit-asset"><span>Orbit</span></button>
				</div>
				<div class="edit-sub-panel" id="edit-road-panel" hidden>
					<div class="edit-bar-label">Road</div>
					<button type="button" data-road="mud" class="edit-asset is-active"><span>Light mud</span></button>
				</div>
				<div class="edit-sub-panel" id="edit-mesh-panel" hidden>
					<div class="edit-bar-label">Place</div>
					${meshButtons}
				</div>
				<div class="edit-sync-status" id="edit-sync-status">Island · 0 edits</div>
			</aside>
			<div class="edit-mode-hint" id="edit-mode-hint" hidden>
				Water: dig basin only · Save World fills continuous water · Exit Edit to see it
			</div>
			<div class="edit-create-modal" id="edit-create-modal" hidden>
				<div class="edit-create-dialog" role="dialog" aria-labelledby="edit-create-title">
					<h3 id="edit-create-title">Create world</h3>
					<p class="edit-create-copy">Choose map size, then create. Larger maps use a coarser grid for performance.</p>
					<label class="edit-create-size">
						<span>Size</span>
						<input type="range" id="edit-world-size-km" min="0.1" max="10" step="0.1" value="1" />
						<strong id="edit-world-size-label">1.0 km</strong>
					</label>
					<div class="edit-create-actions">
						<button type="button" class="edit-chip" id="edit-create-cancel">Cancel</button>
						<button type="button" class="edit-chip edit-save" id="edit-create-confirm">Create world</button>
					</div>
				</div>
			</div>
		`;

		document.body.appendChild(this.root);
		this.editBtn = this.root.querySelector("#edit-mode-toggle")!;
		this.topBar = this.root.querySelector("#edit-top-bar")!;
		this.leftBar = this.root.querySelector("#edit-left-bar")!;
		this.meshPanel = this.root.querySelector("#edit-mesh-panel")!;
		this.roadPanel = this.root.querySelector("#edit-road-panel")!;
		this.cameraPanel = this.root.querySelector("#edit-camera-panel")!;
		this.selectPanel = this.root.querySelector("#edit-select-panel")!;
		this.hint = this.root.querySelector("#edit-mode-hint")!;
		this.saveBtn = this.root.querySelector("#edit-save-btn")!;
		this.undoBtn = this.root.querySelector("#edit-undo-btn")!;
		this.redoBtn = this.root.querySelector("#edit-redo-btn")!;
		this.statusEl = this.root.querySelector("#edit-sync-status")!;
		this.createModal = this.root.querySelector("#edit-create-modal")!;

		this.editBtn.addEventListener("click", () => this.setEnabled(!this.enabled));
		this.root.querySelector("#edit-exit-btn")!.addEventListener("click", () => {
			this.setEnabled(false);
		});
		this.saveBtn.addEventListener("click", () => this.options.onSave());
		this.undoBtn.addEventListener("click", () => this.options.onUndo());
		this.redoBtn.addEventListener("click", () => this.options.onRedo());
		this.root.querySelector("#edit-create-world-btn")!.addEventListener("click", () => {
			this.openCreateWorldModal();
		});
		this.root.querySelector("#edit-create-cancel")!.addEventListener("click", () => {
			this.closeCreateWorldModal();
		});
		this.root.querySelector("#edit-create-confirm")!.addEventListener("click", () => {
			const input = this.root.querySelector<HTMLInputElement>("#edit-world-size-km")!;
			const sizeKm = Number(input.value);
			this.closeCreateWorldModal();
			this.options.onCreateWorld(sizeKm);
		});
		this.createModal.addEventListener("click", (event) => {
			if (event.target === this.createModal) this.closeCreateWorldModal();
		});
		const sizeInput = this.root.querySelector<HTMLInputElement>("#edit-world-size-km")!;
		const sizeLabel = this.root.querySelector<HTMLElement>("#edit-world-size-label")!;
		const syncSizeLabel = () => {
			sizeLabel.textContent = `${Number(sizeInput.value).toFixed(1)} km`;
		};
		sizeInput.addEventListener("input", syncSizeLabel);
		syncSizeLabel();

		this.root.querySelector("#edit-delete-btn")!.addEventListener("click", () => {
			this.options.onDeleteSelected();
		});

		this.leftBar.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((btn) => {
			btn.addEventListener("click", () => {
				this.setTool(btn.dataset.tool as EditTool);
			});
		});

		this.leftBar.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((btn) => {
			btn.addEventListener("click", () => {
				this.setViewMode(btn.dataset.view as EditViewMode);
			});
		});

		this.meshPanel.querySelectorAll<HTMLButtonElement>("[data-mesh]").forEach((btn) => {
			btn.addEventListener("click", () => {
				this.setMesh(btn.dataset.mesh as EditMeshId);
			});
		});

		this.roadPanel.querySelectorAll<HTMLButtonElement>("[data-road]").forEach((btn) => {
			btn.addEventListener("click", () => {
				this.setRoadStyle(btn.dataset.road as RoadStyle);
			});
		});

		this.topBar.querySelectorAll<HTMLButtonElement>("[data-sculpt]").forEach((btn) => {
			btn.addEventListener("click", () => {
				this.setSculpt(btn.dataset.sculpt as SculptType);
			});
		});

		const radius = this.root.querySelector<HTMLInputElement>("#edit-brush-radius")!;
		const strength = this.root.querySelector<HTMLInputElement>("#edit-brush-strength")!;
		const radiusValue = this.root.querySelector<HTMLElement>("#edit-brush-radius-value")!;
		const emitBrush = () => {
			radiusValue.textContent = String(Number(radius.value));
			this.options.onBrushChange(Number(radius.value), Number(strength.value));
		};
		radius.addEventListener("input", emitBrush);
		strength.addEventListener("input", emitBrush);
		emitBrush();

		this.syncPanels();
	}

	get isEnabled() {
		return this.enabled;
	}

	get currentTool() {
		return this.tool;
	}

	get currentMeshId() {
		return this.meshId;
	}

	get currentRoadStyle() {
		return this.roadStyle;
	}

	setVisible(visible: boolean) {
		this.editBtn.hidden = !visible;
		if (!visible && this.enabled) this.setEnabled(false);
	}

	setEnabled(enabled: boolean) {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		this.editBtn.classList.toggle("is-active", enabled);
		this.editBtn.textContent = enabled ? "Playing" : "Edit Mode";
		this.topBar.classList.toggle("is-open", enabled);
		this.leftBar.classList.toggle("is-open", enabled);
		this.hint.classList.toggle("is-open", enabled);
		this.topBar.hidden = !enabled;
		this.leftBar.hidden = !enabled;
		this.hint.hidden = !enabled;
		document.body.classList.toggle("edit-mode-active", enabled);
		this.syncPanels();
		this.options.onToggleEdit(enabled);
	}

	setSyncStatus(status: EditSyncStatus) {
		const liveLabel = status.roomCode
			? `live · ${status.roomCode}`
			: status.live
				? "live peers"
				: "local";
		const dirty = status.dirty ? " · unsaved" : "";
		this.statusEl.textContent = `${status.worldName} · ${status.opCount} edits · ${liveLabel}${dirty}`;
	}

	setSaveState(state: "idle" | "saving" | "saved", message?: string) {
		if (state === "saving") {
			this.saveBtn.textContent = "Saving…";
			this.saveBtn.disabled = true;
			return;
		}
		this.saveBtn.disabled = false;
		this.saveBtn.textContent = state === "saved" ? "Saved" : "Save World";
		if (message) this.statusEl.textContent = message;
		if (state === "saved") {
			window.setTimeout(() => {
				this.saveBtn.textContent = "Save World";
			}, 1600);
		}
	}

	setUndoRedoState(canUndo: boolean, canRedo: boolean) {
		this.undoBtn.disabled = !canUndo;
		this.redoBtn.disabled = !canRedo;
	}

	private openCreateWorldModal() {
		this.createModal.hidden = false;
	}

	private closeCreateWorldModal() {
		this.createModal.hidden = true;
	}

	/** Match pencil range to the active world's cell size (1km needs larger brushes). */
	setBrushLimits(min: number, max: number, value: number) {
		const radius = this.root.querySelector<HTMLInputElement>("#edit-brush-radius");
		const radiusValue = this.root.querySelector<HTMLElement>("#edit-brush-radius-value");
		if (!radius) return;
		const step = min < 1 ? 0.1 : 0.5;
		radius.min = String(min);
		radius.max = String(max);
		radius.step = String(step);
		radius.value = String(value);
		if (radiusValue) radiusValue.textContent = radius.value;
		this.options.onBrushChange(Number(radius.value), this.currentBrushStrength());
	}

	private currentBrushStrength() {
		const strength = this.root.querySelector<HTMLInputElement>("#edit-brush-strength");
		return strength ? Number(strength.value) : 0.35;
	}

	private setTool(tool: EditTool) {
		this.tool = tool;
		this.leftBar.querySelectorAll("[data-tool]").forEach((el) => {
			el.classList.toggle("is-active", (el as HTMLElement).dataset.tool === tool);
		});
		this.syncPanels();
		this.options.onToolChange(tool);
	}

	private syncPanels() {
		const showMeshes = this.enabled && this.tool === "place-mesh";
		const showRoad = this.enabled && this.tool === "paint-road";
		const showCamera = this.enabled && this.tool === "camera";
		const showSelect = this.enabled && this.tool === "select";
		const showSculpt = this.enabled && this.tool === "sculpt";
		const showBrush =
			this.enabled &&
			(this.tool === "sculpt" ||
				this.tool === "paint-road" ||
				this.tool === "paint-water");

		this.meshPanel.hidden = !showMeshes;
		this.meshPanel.classList.toggle("is-open", showMeshes);
		this.roadPanel.hidden = !showRoad;
		this.roadPanel.classList.toggle("is-open", showRoad);
		this.cameraPanel.hidden = !showCamera;
		this.cameraPanel.classList.toggle("is-open", showCamera);
		this.selectPanel.hidden = !showSelect;
		this.selectPanel.classList.toggle("is-open", showSelect);
		this.topBar.classList.toggle("is-sculpt-active", showSculpt);
		this.topBar.classList.toggle("is-brush-active", showBrush);

		const sizeLabel = this.root.querySelector<HTMLElement>("#edit-brush-size-label");
		if (sizeLabel) {
			sizeLabel.textContent =
				this.tool === "paint-water"
					? "Size"
					: showSculpt
						? "Radius"
						: "Pencil";
		}
	}

	private setMesh(meshId: EditMeshId) {
		this.meshId = meshId;
		this.meshPanel.querySelectorAll("[data-mesh]").forEach((el) => {
			el.classList.toggle("is-active", (el as HTMLElement).dataset.mesh === meshId);
		});
		this.options.onMeshChange(meshId);
	}

	private setRoadStyle(style: RoadStyle) {
		this.roadStyle = style;
		this.roadPanel.querySelectorAll("[data-road]").forEach((el) => {
			el.classList.toggle("is-active", (el as HTMLElement).dataset.road === style);
		});
		this.options.onRoadStyleChange(style);
	}

	private setViewMode(mode: EditViewMode) {
		this.leftBar.querySelectorAll("[data-view]").forEach((el) => {
			el.classList.toggle("is-active", (el as HTMLElement).dataset.view === mode);
		});
		this.options.onViewModeChange(mode);
	}

	private setSculpt(sculpt: SculptType) {
		this.sculpt = sculpt;
		this.topBar.querySelectorAll("[data-sculpt]").forEach((el) => {
			el.classList.toggle("is-active", (el as HTMLElement).dataset.sculpt === sculpt);
		});
		this.options.onSculptChange(sculpt);
	}
}
