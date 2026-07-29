export type {
	WorldDefinition,
	WorldKind,
} from "./worldTypes";
export {
	ISLAND_WORLD,
	VALLEY_WORLD,
	createLargeBlankWorld,
	grassCountForSize,
	customWorldSizeMeters,
	segmentsForWorldSize,
	ISLAND_GRASS_DENSITY,
	ISLAND_TERRAIN_CELL,
	CUSTOM_WORLD_SIZE_KM_MIN,
	CUSTOM_WORLD_SIZE_KM_MAX,
} from "./worldTypes";
export {
	createProceduralTerrain,
	paintTerrainMud,
	paintTerrainMudShore,
	paintTerrainWater,
	type ProceduralTerrainResult,
} from "./createProceduralTerrain";
