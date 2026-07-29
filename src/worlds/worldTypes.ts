export type WorldKind = "island" | "valley" | "custom";

export type WorldDefinition = {
	id: string;
	name: string;
	kind: WorldKind;
	/** Terrain extent on X/Z (meters). */
	size: number;
	segments: number;
	/** Target fluffy-grass instance count (chunked + distance culled at runtime). */
	grassCount: number;
	/** Optional procedural seed for custom worlds. */
	seed?: number;
};

export const ISLAND_WORLD: WorldDefinition = {
	id: "island",
	name: "Island",
	kind: "island",
	size: 200,
	segments: 254,
	grassCount: 50000,
};

export const VALLEY_WORLD: WorldDefinition = {
	id: "valley",
	name: "Valley",
	kind: "valley",
	size: 200,
	segments: 254,
	grassCount: 35000,
};

/** Island fluffy-grass areal density (instances / m²). */
export const ISLAND_GRASS_DENSITY = 50000 / (200 * 200); // 1.25

/** Island terrain cell size (meters). */
export const ISLAND_TERRAIN_CELL = 200 / 254; // ≈ 0.787

/** Min / max custom world size in kilometers. */
export const CUSTOM_WORLD_SIZE_KM_MIN = 0.1;
export const CUSTOM_WORLD_SIZE_KM_MAX = 10;

/** Convert km → meters, clamped to supported custom range. */
export function customWorldSizeMeters(sizeKm: number): number {
	const km = Math.min(
		CUSTOM_WORLD_SIZE_KM_MAX,
		Math.max(CUSTOM_WORLD_SIZE_KM_MIN, sizeKm)
	);
	return Math.round(km * 1000);
}

/**
 * Heightfield resolution matching island cell size (~1.8 m).
 * Caps vertex count on huge maps so 10 km stays loadable.
 */
export function segmentsForWorldSize(sizeMeters: number): number {
	const raw = Math.round(sizeMeters / ISLAND_TERRAIN_CELL);
	return Math.min(254, Math.max(64, raw));
}

/**
 * New blank editable world. `sizeKm` is 0.1–10 (default 1 km).
 */
export function createLargeBlankWorld(
	name = "New World",
	sizeKm = 1
): WorldDefinition {
	const id = `custom-${Date.now().toString(36)}`;
	const size = customWorldSizeMeters(sizeKm);
	const segments = segmentsForWorldSize(size);
	return {
		id,
		name,
		kind: "custom",
		size,
		segments,
		grassCount: grassCountForSize(size),
		seed: Math.floor(Math.random() * 1_000_000),
	};
}

/**
 * Grass budget at island density. Full density up to ~1 km; softer caps beyond.
 */
export function grassCountForSize(size: number): number {
	const raw = Math.floor(size * size * ISLAND_GRASS_DENSITY);
	const cap =
		size <= 1100 ? 1_300_000 : size <= 4000 ? 900_000 : 600_000;
	return Math.min(cap, Math.max(50000, raw));
}
