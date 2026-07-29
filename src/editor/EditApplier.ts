import * as THREE from "three";
import { createTree, type TreeHandle } from "../entities/tree";
import { placeStone, type PlacedStoneHandle } from "../entities/stone/placeStone";
import { Pond } from "../entities/water";
import { getWorldTerrainY, setIslandTerrain } from "../terrain/islandHeight";
import {
	paintTerrainMud,
	paintTerrainMudShore,
} from "../worlds/createProceduralTerrain";
import type { GrassChunkField } from "../entities/grass/GrassChunkField";
import {
	applyTerrainBrush,
	digPondBasin,
	smoothBasinRim,
	type TerrainSculptTarget,
} from "./TerrainSculpt";
import {
	basinSpecFromFootprint,
	collectBasinInsideRadius,
	collectBasinNearClick,
	footprintFromBasinSpec,
	refillBasinToRim,
	type BasinFootprint,
	type BasinSpec,
} from "./basinWater";
import type { WorldEditOp } from "./types";

/** Default dig radius when placing water on flat ground. */
export const DEFAULT_WATER_RADIUS = 10;

type TrackedEntity =
	| { kind: "tree"; tree: TreeHandle }
	| { kind: "stone"; stone: PlacedStoneHandle }
	| { kind: "pond"; pond: Pond };

export type EditApplierHost = {
	worldGroup: THREE.Group;
	renderer: THREE.WebGLRenderer;
	scene: THREE.Scene;
	playCamera: THREE.PerspectiveCamera;
	getSculptTarget: () => TerrainSculptTarget | null;
	getTerrainMesh: () => THREE.Mesh | null;
	getGrassField: () => GrassChunkField | null;
	rebuildCollider: () => void;
	enableTerrainVertexColors: () => void;
	addEditorTree: (tree: TreeHandle) => void;
	addEditorStone: (stone: PlacedStoneHandle) => void;
	addEditorPond: (pond: Pond) => void;
	removeEditorTree: (tree: TreeHandle) => void;
	removeEditorStone: (stone: PlacedStoneHandle) => void;
	removeEditorPond: (pond: Pond) => void;
	getScenePropsTerrainColor: () => THREE.ColorRepresentation;
};

/**
 * Applies world-edit ops locally. Used for the authoring client and remote peers.
 */
export class EditApplier {
	private readonly applied = new Set<string>();
	private readonly entities = new Map<string, TrackedEntity>();
	private colliderDirty = false;
	private deferColliderRebuild = false;

	constructor(private readonly host: EditApplierHost) {}

	hasApplied(opId: string) {
		return this.applied.has(opId);
	}

	clearApplied() {
		this.applied.clear();
		this.colliderDirty = false;
	}

	/** Selectable roots tagged with userData.editEntityId. */
	getSelectableObjects(): THREE.Object3D[] {
		const list: THREE.Object3D[] = [];
		for (const entry of this.entities.values()) {
			if (entry.kind === "tree") list.push(entry.tree.group);
			else if (entry.kind === "stone") list.push(entry.stone.group);
			else list.push(entry.pond.mesh);
		}
		return list;
	}

	getEntityIdAtObject(obj: THREE.Object3D | null): string | null {
		let cur: THREE.Object3D | null = obj;
		while (cur) {
			const id = cur.userData?.editEntityId;
			if (typeof id === "string" && this.entities.has(id)) return id;
			cur = cur.parent;
		}
		return null;
	}

	getEntityObject(entityId: string): THREE.Object3D | null {
		const entry = this.entities.get(entityId);
		if (!entry) return null;
		if (entry.kind === "tree") return entry.tree.group;
		if (entry.kind === "stone") return entry.stone.group;
		return entry.pond.mesh;
	}

	async apply(op: WorldEditOp): Promise<boolean> {
		if (this.applied.has(op.id)) return false;
		this.applied.add(op.id);

		switch (op.type) {
			case "sculpt": {
				const target = this.host.getSculptTarget();
				if (!target) return false;
				applyTerrainBrush(
					target,
					op.x,
					op.z,
					op.brush,
					op.radius,
					op.strength
				);
				setIslandTerrain(target.mesh);
				this.colliderDirty = true;
				return true;
			}
			case "place-tree": {
				const tree = await createTree({
					position: [op.x, 0, op.z],
					placeOnTerrain: true,
					scale: op.scale,
					rotationY: op.rotationY,
					leafColor: "#3f6d21",
				});
				this.tagEntity(tree.group, op.id);
				this.host.worldGroup.add(tree.group);
				this.host.addEditorTree(tree);
				this.entities.set(op.id, { kind: "tree", tree });
				return true;
			}
			case "place-mesh": {
				if (op.meshId === "stone") {
					const stone = await placeStone({
						position: new THREE.Vector3(op.x, 0, op.z),
						scale: op.scale,
						rotationY: op.rotationY,
					});
					this.tagEntity(stone.group, op.id);
					this.host.worldGroup.add(stone.group);
					this.host.addEditorStone(stone);
					this.entities.set(op.id, { kind: "stone", stone });
					return true;
				}
				const tree = await createTree({
					position: [op.x, 0, op.z],
					placeOnTerrain: true,
					scale: op.scale,
					rotationY: op.rotationY,
					leafColor: "#3f6d21",
				});
				this.tagEntity(tree.group, op.id);
				this.host.worldGroup.add(tree.group);
				this.host.addEditorTree(tree);
				this.entities.set(op.id, { kind: "tree", tree });
				return true;
			}
			case "place-stone": {
				const stone = await placeStone({
					position: new THREE.Vector3(op.x, 0, op.z),
					scale: op.scale,
					rotationY: op.rotationY,
				});
				this.tagEntity(stone.group, op.id);
				this.host.worldGroup.add(stone.group);
				this.host.addEditorStone(stone);
				this.entities.set(op.id, { kind: "stone", stone });
				return true;
			}
			case "place-water": {
				await this.spawnPond({
					entityId: op.id,
					x: op.x,
					z: op.z,
					radius: op.radius,
				});
				return true;
			}
			case "paint-road": {
				const mesh = this.host.getTerrainMesh();
				if (mesh) {
					this.host.enableTerrainVertexColors();
					paintTerrainMud(mesh, op.x, op.z, op.radius);
				}
				this.host.getGrassField()?.maskRoadCircle(op.x, op.z, op.radius);
				return true;
			}
			case "paint-water": {
				if (op.createSurface) {
					await this.spawnPond({
						entityId: op.id,
						x: op.x,
						z: op.z,
						radius: op.radius,
						basin: op.basin,
					});
					return true;
				}
				this.host.getGrassField()?.maskRoadCircle(op.x, op.z, op.radius);
				return true;
			}
			case "paint-forest": {
				for (const treeSpec of op.trees) {
					const tree = await createTree({
						position: [treeSpec.x, 0, treeSpec.z],
						placeOnTerrain: true,
						scale: treeSpec.scale,
						rotationY: treeSpec.rotationY,
						leafColor: "#3f6d21",
					});
					this.host.worldGroup.add(tree.group);
					this.host.addEditorTree(tree);
				}
				return true;
			}
			case "delete-entity": {
				this.removeEntity(op.entityId);
				return true;
			}
			case "rebuild-collider": {
				this.host.rebuildCollider();
				this.colliderDirty = false;
				return true;
			}
			default:
				return false;
		}
	}

	removeEntity(entityId: string): boolean {
		const entry = this.entities.get(entityId);
		if (!entry) return false;
		this.entities.delete(entityId);
		if (entry.kind === "tree") {
			this.host.removeEditorTree(entry.tree);
			entry.tree.dispose();
		} else if (entry.kind === "stone") {
			this.host.removeEditorStone(entry.stone);
			entry.stone.dispose();
		} else {
			this.host.removeEditorPond(entry.pond);
			entry.pond.mesh.removeFromParent();
			entry.pond.dispose();
		}
		return true;
	}

	/** Drop all tracked props (before full reapply). */
	clearEntities() {
		for (const id of [...this.entities.keys()]) {
			this.removeEntity(id);
		}
	}

	private tagEntity(obj: THREE.Object3D, entityId: string) {
		obj.userData.editEntityId = entityId;
	}

	/**
	 * Build a basin footprint for a click (authoring).
	 * Prefer an existing hole near the click; otherwise dig a limited-radius basin.
	 * Result is serializable into the paint-water op JSON.
	 */
	prepareBasinAt(
		x: number,
		z: number,
		radius = DEFAULT_WATER_RADIUS
	): BasinSpec | null {
		const target = this.host.getSculptTarget();
		if (!target) return null;
		const digRadius = Math.max(4, radius);

		let footprint =
			collectBasinNearClick(target, x, z, digRadius) ??
			collectBasinNearClick(target, x, z, Math.min(digRadius * 1.5, 48));

		if (footprint && footprint.cells.length >= 6) {
			return basinSpecFromFootprint(footprint);
		}

		const surfaceY = getWorldTerrainY(x, z);
		digPondBasin(target, x, z, digRadius);
		setIslandTerrain(target.mesh);
		this.colliderDirty = true;
		// Fill nearly to original ground so banks aren't left dry.
		const waterY = surfaceY - 0.02;
		footprint = collectBasinInsideRadius(
			target,
			x,
			z,
			digRadius * 1.55,
			waterY
		);
		if (!footprint) return null;
		return basinSpecFromFootprint(footprint, digRadius);
	}

	/**
	 * Place shader water ONLY on saved basin cells (or prepare a radius-limited dig).
	 */
	private async spawnPond(options: {
		entityId: string;
		x: number;
		z: number;
		radius?: number;
		basin?: BasinSpec;
	}) {
		const target = this.host.getSculptTarget();
		if (!target) return;
		const digRadius = Math.max(4, options.radius ?? DEFAULT_WATER_RADIUS);
		const cellSize = target.size / target.ncols;

		let footprint: BasinFootprint | null = null;
		let basin = options.basin;

		if (!basin?.cells?.length) {
			basin = this.prepareBasinAt(options.x, options.z, digRadius) ?? undefined;
		} else if (basin.digRadius != null) {
			digPondBasin(target, options.x, options.z, basin.digRadius);
			setIslandTerrain(target.mesh);
			this.colliderDirty = true;
		}

		if (!basin?.cells?.length) return;
		// Hard safety: never build a world-scale water sheet.
		const maxCells = 4500;
		const maxSpan = (basin.digRadius ?? digRadius) * 3;
		if (basin.cells.length > maxCells) return;
		if (basin.width > maxSpan * 2 || basin.depth > maxSpan * 2) {
			basin = {
				...basin,
				cells: basin.cells.filter((c) => {
					const dx = c.x - basin!.centerX;
					const dz = c.z - basin!.centerZ;
					return dx * dx + dz * dz <= maxSpan * maxSpan;
				}),
			};
		}

		const pondRadius =
			basin.digRadius ??
			Math.max(4, Math.hypot(basin.width, basin.depth) * 0.42);

		// Soften irregular sculpted banks when filling an existing hole.
		if (basin.digRadius == null) {
			smoothBasinRim(
				target,
				basin.centerX,
				basin.centerZ,
				pondRadius * 0.45,
				pondRadius * 1.25,
				3
			);
			setIslandTerrain(target.mesh);
			this.colliderDirty = true;
		}

		// Raise / expand water to the rim so banks aren't left dry (incl. old saves).
		footprint =
			refillBasinToRim(target, basin, pondRadius) ??
			footprintFromBasinSpec(basin, cellSize);
		if (!footprint || footprint.cells.length < 3) return;

		// Clear grass over the basin AABB (water shape still comes from JSON cells).
		const grassR = Math.max(footprint.width, footprint.depth) * 0.55 + 1;
		this.host.getGrassField()?.maskRoadCircle(
			footprint.centerX,
			footprint.centerZ,
			grassR
		);

		// Green → muddy bank → water (floor + shore ring).
		const mesh = this.host.getTerrainMesh();
		if (mesh) {
			this.host.enableTerrainVertexColors();
			const waterR = Math.max(
				Math.max(footprint.width, footprint.depth) * 0.42,
				pondRadius * 0.85
			);
			paintTerrainMudShore(
				mesh,
				footprint.centerX,
				footprint.centerZ,
				waterR,
				grassR + 2.5
			);
		}

		const pond = new Pond({
			width: Math.max(footprint.width, 4),
			height: Math.max(footprint.depth, 4),
			circular: false,
			geometry: footprint.geometry,
			color: 0x3a7ab0,
			bottomColor: 0x2f6a9a,
			brightness: 1.14,
			clarity: 0.72,
			shoreFoam: 0.35,
			renderer: this.host.renderer,
			scene: this.host.scene,
			camera: this.host.playCamera,
			sunDirection: new THREE.Vector3(1, 1, 1).normalize(),
		});
		pond.mesh.position.set(footprint.centerX, footprint.waterY, footprint.centerZ);
		pond.mesh.renderOrder = 1;
		pond.mesh.userData.waterRadius = pondRadius;
		pond.mesh.userData.waterHalfW = footprint.width * 0.5;
		pond.mesh.userData.waterHalfD = footprint.depth * 0.5;
		this.tagEntity(pond.mesh, options.entityId);
		this.host.worldGroup.add(pond.mesh);
		this.host.addEditorPond(pond);
		this.entities.set(options.entityId, { kind: "pond", pond });

		if (!this.deferColliderRebuild && this.colliderDirty) {
			this.host.rebuildCollider();
			this.colliderDirty = false;
		}
	}

	async applyMany(ops: WorldEditOp[]) {
		this.deferColliderRebuild = true;
		try {
			for (const op of ops) {
				await this.apply(op);
			}
		} finally {
			this.deferColliderRebuild = false;
		}
		if (this.colliderDirty) {
			this.host.rebuildCollider();
			this.colliderDirty = false;
		}
	}

	flushColliderIfNeeded() {
		if (!this.colliderDirty) return;
		this.host.rebuildCollider();
		this.colliderDirty = false;
	}
}
