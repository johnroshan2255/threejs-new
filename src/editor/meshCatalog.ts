/**
 * Placeable meshes available in Edit Mode.
 * Add new entries here as assets are wired (bushes, etc.).
 */
export type EditMeshId = "tree" | "stone";

export type EditMeshCatalogEntry = {
	id: EditMeshId;
	name: string;
	/** Short label for the tool shelf. */
	label: string;
};

export const EDIT_MESH_CATALOG: EditMeshCatalogEntry[] = [
	{ id: "tree", name: "Tree", label: "Tree" },
	{ id: "stone", name: "Stone", label: "Stone" },
];
