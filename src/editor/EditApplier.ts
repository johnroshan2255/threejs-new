import * as THREE from "three";
import { createTree, type TreeHandle } from "../entities/tree";
import { placeStone, type PlacedStoneHandle } from "../entities/stone/placeStone";
import {
	Pond,
	REFERENCE_TEXELS_PER_METER,
	REFERENCE_WATER_LOOK,
} from "../entities/water";
import { debugLine } from "../ui/debugOverlay";
import { getWorldTerrainY, setIslandTerrain } from "../terrain/islandHeight";
import {
	paintTerrainMud,
	paintTerrainMudShore,
	paintTerrainWater,
} from "../worlds/createProceduralTerrain";
import type { GrassChunkField } from "../entities/grass/GrassChunkField";
import {
	applyTerrainBrush,
	digPondBasin,
	digWaterBrush,
	smoothBasinRim,
	sculptCaveMouths,
	type TerrainSculptTarget,
} from "./TerrainSculpt";
import {
	basinSpecFromFootprint,
	collectBasinFromBrushStamps,
	collectBasinsFromBrushStamps,
	collectBasinInsideRadius,
	collectBasinNearClick,
	footprintFromBasinSpec,
	refillBasinToRim,
	type BasinFootprint,
	type BasinSpec,
} from "./basinWater";
import type { WorldEditOp } from "./types";
import { resolveEditMesh } from "./meshCatalog";
import { createCave, type CaveHandle } from "../entities/cave/createCave";
import { punchTerrainHoles, restoreTerrainHoles } from "../terrain/caveMesh";
import {
	caveMouthMaskCircles,
	createHeightSampler,
	terrainCellSize,
} from "../terrain/caveShape";
import { getCaveSpecs, hasCaves } from "../terrain/caveRegistry";
import { paintSnowCircle } from "../terrain/snowMask";

/** Default dig radius when placing water on flat ground. */
export const DEFAULT_WATER_RADIUS = 10;

type TrackedEntity =
	| { kind: "tree"; tree: TreeHandle }
	| { kind: "stone"; stone: PlacedStoneHandle }
	| { kind: "pond"; pond: Pond }
	| { kind: "cave"; cave: CaveHandle };

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
	getTreeManager: () => import("../entities/tree/TreeInstancedMesh").TreeInstancedMesh | null;
};

/**
 * Applies world-edit ops locally. Used for the authoring client and remote peers.
 */
export class EditApplier {
	private readonly applied = new Set<string>();
	private readonly entities = new Map<string, TrackedEntity>();
	private colliderDirty = false;
	private caveTerrainDirty = false;
	private deferColliderRebuild = false;
	/** When false (edit mode), dig basins only — no Pond meshes. */
	private spawnWaterSurfaces = true;

	constructor(private readonly host: EditApplierHost) {}

	setSpawnWaterSurfaces(enabled: boolean) {
		this.spawnWaterSurfaces = enabled;
	}

	hasApplied(opId: string) {
		return this.applied.has(opId);
	}

	clearApplied() {
		this.applied.clear();
		this.colliderDirty = false;
	}

	/** Remove Pond entities and forget their createSurface op ids so they can re-apply later. */
	clearPonds() {
		for (const [id, entry] of [...this.entities.entries()]) {
			if (entry.kind !== "pond") continue;
			this.removeEntity(id);
			this.applied.delete(id);
		}
	}

	forgetWaterSurfaceOps(ops: WorldEditOp[]) {
		for (const op of ops) {
			if (op.type === "paint-water" && op.createSurface) {
				this.applied.delete(op.id);
			}
		}
	}

	getSelectableObjects(): THREE.Object3D[] {
		const list: THREE.Object3D[] = [];
		const tm = this.host.getTreeManager();
		if (tm) list.push(tm.group);
		for (const entry of this.entities.values()) {
			if (entry.kind === "stone") list.push(entry.stone.group);
			else if (entry.kind === "pond") list.push(entry.pond.mesh);
			else if (entry.kind === "cave") list.push(entry.cave.mesh);
		}
		return list;
	}

	getEntities(): Map<string, TrackedEntity> {
		return this.entities;
	}


	getEntityIdAtIntersection(intersect: THREE.Intersection): string | null {
		const tm = this.host.getTreeManager();
		if (tm && intersect.object.userData?.isTreeInstancedMesh) {
			if (intersect.instanceId !== undefined) {
				return tm.getIdFromInstanceId(intersect.instanceId, intersect.object);
			}
		}
		return this.getEntityIdAtObject(intersect.object);
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
		if (entry.kind === "tree") {
			const tm = this.host.getTreeManager();
			if (tm) {
				tm.getMatrixAt(entityId, entry.tree.group.matrix);
				entry.tree.group.matrix.decompose(
					entry.tree.group.position,
					entry.tree.group.quaternion,
					entry.tree.group.scale
				);
			}
			return entry.tree.group;
		}
		if (entry.kind === "stone") return entry.stone.group;
		if (entry.kind === "cave") return entry.cave.mesh;
		return entry.pond.mesh;
	}

	getEntityKind(entityId: string): "tree" | "stone" | "pond" | "cave" | null {
		return this.entities.get(entityId)?.kind ?? null;
	}

	/** True for meshes that support Blender-like transform gizmos. */
	canTransformEntity(entityId: string): boolean {
		const kind = this.getEntityKind(entityId);
		return kind === "tree" || kind === "stone";
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
				// Mouth footprints are derived from terrain height, so sculpting near
				// a cave moves where the hole belongs.
				if (hasCaves()) this.markCaveTerrainDirty();
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
				
				const tm = this.host.getTreeManager();
				if (tm) {
					tm.addTree(op.id, tree.group.position, op.rotationY ?? 0, op.scale ?? 1, "#3f6d21");
				}
				return true;
			}
			case "place-mesh": {
				const catalog = resolveEditMesh(op.meshId);
				if (catalog.kind === "stone") {
					const stone = await placeStone({
						position: new THREE.Vector3(op.x, 0, op.z),
						scale: op.scale,
						rotationY: op.rotationY,
						y: op.y,
						assetUrl: catalog.assetUrl,
					});
					this.tagEntity(stone.group, op.id);
					this.host.worldGroup.add(stone.group);
					this.host.addEditorStone(stone);
					this.entities.set(op.id, { kind: "stone", stone });
					return true;
				}
				const tree = await createTree({
					position:
						op.y != null
							? [op.x, op.y, op.z]
							: [op.x, 0, op.z],
					placeOnTerrain: op.y == null,
					scale: op.scale,
					rotationY: op.rotationY,
					leafColor: "#3f6d21",
				});
				this.tagEntity(tree.group, op.id);
				this.host.worldGroup.add(tree.group);
				this.host.addEditorTree(tree);
				this.entities.set(op.id, { kind: "tree", tree });
				
				const tm = this.host.getTreeManager();
				if (tm) {
					tm.addTree(op.id, tree.group.position, op.rotationY ?? 0, op.scale ?? 1, "#3f6d21");
				}
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
				// Preview dig + blue paint while stroking; Pond is spawned only when
				// createSurface is true (stroke end / saved fill op).
				if (!op.createSurface) {
					const target = this.host.getSculptTarget();
					if (target) {
						digWaterBrush(target, op.x, op.z, op.radius);
						setIslandTerrain(target.mesh);
						this.colliderDirty = true;
					}
					const mesh = this.host.getTerrainMesh();
					if (mesh) {
						this.host.enableTerrainVertexColors();
						paintTerrainWater(mesh, op.x, op.z, op.radius);
					}
					this.host.getGrassField()?.maskRoadCircle(op.x, op.z, op.radius);
				} else {
					if (!this.spawnWaterSurfaces) {
						// Edit mode: keep basin only; fill ops applied on Save / exit play.
						this.applied.delete(op.id);
						return false;
					}
					await this.spawnPond({
						entityId: op.id,
						x: op.x,
						z: op.z,
						radius: op.radius,
						basin: op.basin,
					});
				}
				return true;
			}
			case "paint-snow": {
				// No mesh, no collider, no grass mask — snow is a shading term that
				// terrain / grass / foliage / stones all read from one world-space
				// mask. Painting the mask is the whole operation.
				paintSnowCircle(op.x, op.z, op.radius, op.strength ?? 1);
				return true;
			}
			case "paint-cave": {
				const target = this.host.getSculptTarget();
				if (!target || op.nodes.length < 1) return false;
				
				sculptCaveMouths(target, op.nodes);
				setIslandTerrain(target.mesh);
				this.colliderDirty = true;

				// Meshed off-thread; a few million voxel samples would otherwise freeze
				// the frame the moment a cave is carved.
				const cave = await createCave({
					id: op.id,
					nodes: op.nodes,
					heights: target.heights,
					nrows: target.nrows,
					ncols: target.ncols,
					size: target.size,
				});
				if (!cave) {
					debugLine(`[cave] spine too small to carve (${op.nodes.length} nodes)`);
					// Let a later, larger spine with this id succeed.
					this.applied.delete(op.id);
					return false;
				}
				this.host.worldGroup.add(cave.mesh);
				this.entities.set(op.id, { kind: "cave", cave });

				// Grass positions are baked into instance matrices, so blades left over
				// a hole hang in mid-air — and being opaque from above, they read as
				// solid ground and hide the opening completely. Clear them wherever the
				// punch actually opens terrain, which is every stretch of spine that
				// runs near the surface, not just the two ends the author clicked.
				const grass = this.host.getGrassField();
				if (grass) {
					grass.maskCircles(
						caveMouthMaskCircles(
							op.nodes,
							createHeightSampler(
								target.heights,
								target.nrows,
								target.ncols,
								target.size
							),
							terrainCellSize(target.size, target.nrows, target.ncols)
						)
					);
				}

				this.markCaveTerrainDirty();
				debugLine(
					`[cave] ${op.nodes.length} nodes · ${cave.triangles} tris` +
						` · voxel ${cave.voxelSize.toFixed(2)}m`
				);
				return true;
			}
			case "paint-forest": {
				for (const treeSpec of op.trees) {
					const id = "forest_" + Math.random().toString(36).substring(2, 9);
					const tree = await createTree({
						position: [treeSpec.x, 0, treeSpec.z],
						placeOnTerrain: true,
						scale: treeSpec.scale,
						rotationY: treeSpec.rotationY,
						leafColor: "#3f6d21",
					});
					this.tagEntity(tree.group, id);
					this.host.worldGroup.add(tree.group);
					this.host.addEditorTree(tree);
					this.entities.set(id, { kind: "tree", tree });
					
					const tm = this.host.getTreeManager();
					if (tm) {
						tm.addTree(id, tree.group.position, treeSpec.rotationY ?? 0, treeSpec.scale ?? 1, "#3f6d21");
					}
				}
				return true;
			}
			case "delete-entity": {
				const handle = this.entities.get(op.entityId);
				if (handle) {
					if (handle.kind === "tree") {
						this.host.removeEditorTree(handle.tree);
						handle.tree.dispose();
						const tm = this.host.getTreeManager();
						if (tm) tm.removeTree(op.entityId);
					} else if (handle.kind === "stone") {
						this.host.removeEditorStone(handle.stone);
						handle.stone.dispose();
					} else if (handle.kind === "pond") {
						this.host.removeEditorPond(handle.pond);
						handle.pond.dispose();
					} else if (handle.kind === "cave") {
						handle.cave.dispose();
						// The mouth hole has to close again, and terrain can go back to a
						// heightfield collider once the last cave is gone.
						this.markCaveTerrainDirty();
					}
					this.entities.delete(op.entityId);
				}
				return true;
			}
			case "transform-entity": {
				const obj = this.getEntityObject(op.entityId);
				if (obj) {
					obj.position.set(op.x, op.y, op.z);
					if (op.rotationX != null && op.rotationZ != null) {
						obj.rotation.set(op.rotationX, op.rotationY, op.rotationZ);
					} else {
						obj.rotation.set(0, op.rotationY, 0);
					}
					obj.scale.setScalar(op.scale);
					const handle = this.entities.get(op.entityId);
					if (handle?.kind === "tree") {
						handle.tree.snapToTerrain();
						const tm = this.host.getTreeManager();
						if (tm) {
							tm.updateTreeTransform(op.entityId, obj.position, op.rotationY, op.scale);
						}
					}
				}
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

	private removeEntity(entityId: string) {
		const handle = this.entities.get(entityId);
		if (!handle) return;
		if (handle.kind === "tree") {
			this.host.removeEditorTree(handle.tree);
			handle.tree.dispose();
			const tm = this.host.getTreeManager();
			if (tm) tm.removeTree(entityId);
		} else if (handle.kind === "stone") {
			this.host.removeEditorStone(handle.stone);
			handle.stone.dispose();
		} else if (handle.kind === "pond") {
			this.host.removeEditorPond(handle.pond);
			handle.pond.mesh.removeFromParent();
			handle.pond.dispose();
		} else if (handle.kind === "cave") {
			handle.cave.dispose();
			this.markCaveTerrainDirty();
		}
		this.entities.delete(entityId);
	}

	/** Drop all tracked props (before full reapply). */
	clearEntities() {
		// Batch: each removed cave would otherwise re-punch the whole terrain index.
		this.deferColliderRebuild = true;
		try {
			for (const entityId of [...this.entities.keys()]) {
				this.removeEntity(entityId);
			}
		} finally {
			this.deferColliderRebuild = false;
		}
		this.flushCaveTerrain();
		const tm = this.host.getTreeManager();
		if (tm) tm.clear();
	}

	private tagEntity(obj: THREE.Object3D, entityId: string) {
		obj.userData.editEntityId = entityId;
	}

	/**
	 * Collect basin cells exactly under the water pencil path (no circular flood).
	 */
	collectBasinFromStamps(
		stamps: Array<{ x: number; z: number; radius: number }>
	): BasinSpec | null {
		const target = this.host.getSculptTarget();
		if (!target || !stamps.length) return null;
		const footprint = collectBasinFromBrushStamps(target, stamps);
		if (!footprint || footprint.cells.length < 3) return null;
		return basinSpecFromFootprint(footprint);
	}

	/** One basin per connected painted region (overlapping strokes merge). */
	collectBasinsFromStamps(
		stamps: Array<{ x: number; z: number; radius: number }>
	): BasinSpec[] {
		const target = this.host.getSculptTarget();
		if (!target || !stamps.length) return [];
		return collectBasinsFromBrushStamps(target, stamps)
			.filter((fp) => fp.cells.length >= 3)
			.map((fp) => basinSpecFromFootprint(fp));
	}

	/**
	 * Collect an already-dug depression (e.g. after paint-water dig strokes).
	 * Does not dig further — used before spawning Pond on stroke end.
	 */
	collectExistingBasinAt(
		x: number,
		z: number,
		maxRadius: number
	): BasinSpec | null {
		const target = this.host.getSculptTarget();
		if (!target) return null;
		const r = Math.max(4, maxRadius);
		const footprint =
			collectBasinNearClick(target, x, z, r) ??
			collectBasinNearClick(target, x, z, Math.min(r * 1.5, 80));
		if (!footprint || footprint.cells.length < 3) return null;
		return basinSpecFromFootprint(footprint);
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
		const digRadius = radius;

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
		/** Brush-authored basins must keep their exact cell shape (no circular expand). */
		const exactShape = Boolean(basin?.cells?.length && basin.digRadius == null);

		if (!basin?.cells?.length) {
			basin = this.prepareBasinAt(options.x, options.z, digRadius) ?? undefined;
		} else if (basin.digRadius != null) {
			digPondBasin(target, options.x, options.z, basin.digRadius);
			setIslandTerrain(target.mesh);
			this.colliderDirty = true;
		}

		if (!basin?.cells?.length) {
			debugLine(
				`[water] NO CELLS at ${options.x.toFixed(0)},${options.z.toFixed(0)} r=${options.radius ?? "-"}`
			);
			return;
		}
		// Hard safety: never build a world-scale water sheet.
		const maxCells = 4500;
		if (basin.cells.length > maxCells) {
			basin = { ...basin, cells: basin.cells.slice(0, maxCells) };
		}

		const pondRadius =
			basin.digRadius ??
			Math.max(2, Math.hypot(basin.width, basin.depth) * 0.42);

		if (exactShape) {
			// Keep water mesh = painted cells only.
			footprint = footprintFromBasinSpec(basin, cellSize);
		} else {
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
			// Raise / expand water to the rim (legacy / digRadius ponds only).
			footprint =
				refillBasinToRim(target, basin, pondRadius) ??
				footprintFromBasinSpec(basin, cellSize);
		}
		if (!footprint || footprint.cells.length < 3) {
			debugLine(
				`[water] NO FOOTPRINT cells=${basin?.cells?.length ?? 0} exact=${exactShape}`
			);
			return;
		}

		// TEMPORARY diagnostic: a sheet is invisible when its single flat waterY
		// sits under the ground, which happens on very large painted basins.
		const groundAtCenter = getWorldTerrainY(
			footprint.centerX,
			footprint.centerZ
		);
		const buried = groundAtCenter - footprint.waterY;
		debugLine(
			`[water] pond ${footprint.width.toFixed(0)}x${footprint.depth.toFixed(0)}m` +
				` cell=${cellSize.toFixed(2)} cells=${footprint.cells.length}` +
				`${(options.basin?.cells?.length ?? 0) > maxCells ? " TRUNCATED" : ""}\n` +
				`         waterY=${footprint.waterY.toFixed(2)} ground=${groundAtCenter.toFixed(2)}` +
				` buried=${buried > 0 ? "+" : ""}${buried.toFixed(2)}m` +
				`${buried > 0.3 ? "  <-- SHEET IS UNDER THE GROUND" : ""}`
		);

		// Clear grass over the basin footprint (circle around AABB is fine for mask).
		const grassR = Math.max(footprint.width, footprint.depth) * 0.55 + 1;
		this.host.getGrassField()?.maskRoadCircle(
			footprint.centerX,
			footprint.centerZ,
			grassR
		);

		// Shore paint: for exact brush shapes, tint only near the footprint center
		// at a radius matching the painted extent — not a huge circle beyond it.
		const mesh = this.host.getTerrainMesh();
		if (mesh) {
			this.host.enableTerrainVertexColors();
			if (exactShape) {
				const shoreR = Math.max(footprint.width, footprint.depth) * 0.5 + cellSize;
				paintTerrainMudShore(
					mesh,
					footprint.centerX,
					footprint.centerZ,
					Math.max(1, shoreR * 0.55),
					shoreR + 1.5
				);
			} else {
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
		}

		// Hold the reference pond's texel density instead of stretching a fixed
		// 256² over the whole basin. Capped at 512 — every pond also owns
		// screen-sized reflection / refraction targets.
		const waterExtent = Math.max(footprint.width, footprint.depth, 4);
		const simResolution = THREE.MathUtils.clamp(
			2 ** Math.round(Math.log2(waterExtent * REFERENCE_TEXELS_PER_METER)),
			256,
			512
		);

		const pond = new Pond({
			width: Math.max(footprint.width, 4),
			height: Math.max(footprint.depth, 4),
			segments: 96,
			resolution: simResolution,
			circular: false,
			geometry: footprint.geometry,
			...REFERENCE_WATER_LOOK,
			shoreSoftness: 0.55,
			renderer: this.host.renderer,
			scene: this.host.scene,
			camera: this.host.playCamera,
			sunDirection: { x: 12, y: 22, z: 8 },
		});
		// A touch lower than baked waterY so expanded width sits inside the banks.
		pond.mesh.position.set(
			footprint.centerX,
			footprint.waterY - 0.06,
			footprint.centerZ
		);
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

	/**
	 * Terrain mouth holes need re-cutting. Batched during applyMany — punching walks
	 * every terrain triangle, so doing it per cave on a full replay is wasteful.
	 */
	private markCaveTerrainDirty() {
		this.caveTerrainDirty = true;
		this.colliderDirty = true;
		if (!this.deferColliderRebuild) this.flushCaveTerrain();
	}

	private flushCaveTerrain() {
		if (!this.caveTerrainDirty) return;
		this.caveTerrainDirty = false;

		const mesh = this.host.getTerrainMesh();
		const target = this.host.getSculptTarget();
		if (!mesh) return;
		const geometry = mesh.geometry as THREE.BufferGeometry;

		if (!hasCaves() || !target) {
			restoreTerrainHoles(geometry);
		} else {
			punchTerrainHoles(
				geometry,
				getCaveSpecs(),
				createHeightSampler(
					target.heights,
					target.nrows,
					target.ncols,
					target.size
				),
				terrainCellSize(target.size, target.nrows, target.ncols)
			);
		}
		setIslandTerrain(mesh);
	}

	async applyMany(ops: WorldEditOp[]) {
		this.deferColliderRebuild = true;
		try {
			const pending = new Map<string, Promise<any>>();
			for (const op of ops) {
				if (op.type === "delete-entity" || op.type === "transform-entity") {
					const p = pending.get(op.entityId);
					if (p) await p;
				}
				const promise = this.apply(op);
				pending.set(op.id, promise);
			}
			await Promise.all(pending.values());
		} finally {
			this.deferColliderRebuild = false;
		}
		this.flushCaveTerrain();
		if (this.colliderDirty) {
			this.host.rebuildCollider();
			this.colliderDirty = false;
		}
	}

	flushColliderIfNeeded() {
		// Holes first: the collider is built from the punched terrain geometry.
		this.flushCaveTerrain();
		if (!this.colliderDirty) return;
		this.host.rebuildCollider();
		this.colliderDirty = false;
	}
}
