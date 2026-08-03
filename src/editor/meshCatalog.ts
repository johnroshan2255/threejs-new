/**
 * Placeable meshes for Edit Mode.
 * Grouped by category with preview thumbnails — add entries as assets are wired.
 */

export type EditMeshCategoryId = "trees" | "stones" | "bushes" | "other";

export type EditMeshKind = "tree" | "stone";

/** Stable catalog ids (also used in saved world-edit ops). */
export type EditMeshId = string;

export type EditMeshCategory = {
	id: EditMeshCategoryId;
	label: string;
};

export type EditMeshCatalogEntry = {
	id: EditMeshId;
	category: EditMeshCategoryId;
	kind: EditMeshKind;
	name: string;
	/** Short label under the thumbnail. */
	label: string;
	/** Public URL for the shelf preview image. */
	preview: string;
	/** GLB path for stone variants (trees use the shared tree loader). */
	assetUrl?: string;
	/** Default uniform scale when placing. */
	defaultScale?: number;
	/** Random scale jitter added on place (±). */
	scaleJitter?: number;
};

export const EDIT_MESH_CATEGORIES: EditMeshCategory[] = [
	{ id: "trees", label: "Trees" },
	{ id: "stones", label: "Stones" },
	{ id: "bushes", label: "Bushes" },
	{ id: "other", label: "Other" },
];

/**
 * Authoring catalog. Ids must stay stable — saved ops reference them.
 * Legacy `"tree"` / `"stone"` remain valid.
 */
export const EDIT_MESH_CATALOG: EditMeshCatalogEntry[] = [
	{
		id: "tree",
		category: "trees",
		kind: "tree",
		label: "Tree",
		name: "Tree",
		preview: "/edit-previews/tree.svg",
		defaultScale: 1.05,
		scaleJitter: 0.2,
	},
	{
		id: "stone",
		category: "stones",
		kind: "stone",
		label: "Stone",
		name: "Stone",
		preview: "/edit-previews/stone.svg",
		assetUrl: "/stone/stone_smallC.glb",
		defaultScale: 2.4,
		scaleJitter: 0.4,
	},
	{
		id: "bush_pine",
		category: "bushes",
		kind: "stone",
		label: "Pine Bush",
		name: "3 Pine Bushes",
		preview: "",
		assetUrl: "/models/bushes/3_pine_bushes.glb",
		defaultScale: 1.0,
		scaleJitter: 0.2,
	},
	{
		id: "bush_small",
		category: "bushes",
		kind: "stone",
		label: "Small Bush",
		name: "Small Bush",
		preview: "",
		assetUrl: "/models/bushes/small_bush.glb",
		defaultScale: 1.0,
		scaleJitter: 0.2,
	},
	{
		id: "bush_stylized",
		category: "bushes",
		kind: "stone",
		label: "Stylized Bush",
		name: "Stylized Bush",
		preview: "",
		assetUrl: "/models/bushes/stylized_bush.glb",
		defaultScale: 1.0,
		scaleJitter: 0.2,
	},
	{
		id: "bench",
		category: "other",
		kind: "stone",
		label: "Bench",
		name: "Bench",
		preview: "",
		assetUrl: "/models/bench.glb",
		defaultScale: 1.0,
		scaleJitter: 0.0,
	},
	{
		id: "lamp_post",
		category: "other",
		kind: "stone",
		label: "Lamp Post",
		name: "Medieval Lamp Post",
		preview: "",
		assetUrl: "/models/medieval_lamp_post.glb",
		defaultScale: 1.0,
		scaleJitter: 0.0,
	},
	{
		id: "wooden_sign",
		category: "other",
		kind: "stone",
		label: "Wooden Sign",
		name: "Wooden Sign",
		preview: "",
		assetUrl: "/models/wooden_sign.glb",
		defaultScale: 1.0,
		scaleJitter: 0.0,
	},
];

const byId = new Map(EDIT_MESH_CATALOG.map((e) => [e.id, e]));

export function getEditMesh(id: EditMeshId): EditMeshCatalogEntry | undefined {
	return byId.get(id);
}

/** Resolve catalog entry; falls back to tree when unknown. */
export function resolveEditMesh(id: EditMeshId): EditMeshCatalogEntry {
	const hit = byId.get(id);
	if (hit) return hit;
	// Older saves may reference kenney stone variant ids — map to default stone.
	if (id.toLowerCase().includes("stone")) {
		return byId.get("stone") ?? EDIT_MESH_CATALOG[0]!;
	}
	return EDIT_MESH_CATALOG[0]!;
}

export function getEditMeshesByCategory(
	category: EditMeshCategoryId
): EditMeshCatalogEntry[] {
	return EDIT_MESH_CATALOG.filter((e) => e.category === category);
}

export function pickPlaceScale(entry: EditMeshCatalogEntry): number {
	const base = entry.defaultScale ?? 1;
	const jitter = entry.scaleJitter ?? 0;
	if (jitter <= 0) return base;
	return base + (Math.random() * 2 - 1) * jitter;
}
