import * as THREE from "three";

/**
 * World-space snow coverage mask.
 *
 * One R8 texture spanning the whole world on XZ. Every material that can wear
 * snow — terrain, grass, foliage, stones — samples this same texture at its own
 * world position, so a patch of snow is described exactly once and every shader
 * agrees about where it is.
 *
 * Why a texture rather than per-object colour:
 *  - Materials in this project are shared by reference (`template.clone(true)`
 *    in placeStone does NOT clone materials, one GrassMaterial serves every
 *    chunk), so assigning a colour would turn every instance in the world white,
 *    not just the ones standing in snow. A position-sampled mask lets one shared
 *    material behave differently per fragment, which is what we actually want.
 *  - Mask resolution is independent of mesh resolution. Terrain vertices cap at
 *    254 segments (segmentsForWorldSize), which is ~3.9 m/vertex on a 1 km world
 *    and ~39 m on a 10 km one — far too coarse for a snow edge. This texture is
 *    ~0.5 m/texel at 1 km.
 *
 * The mask is NOT serialized. It is re-rendered from paint-snow ops on load, the
 * same way cave shells rebuild from their spine, which keeps the op log the
 * single source of truth and keeps saves small.
 */

/** Texels per side. 2048² as R8 is 4 MB — cheap enough to keep resident. */
const RESOLUTION = 2048;

/** Cool off-white. Pure white clips flat and reads as paper, not snow. */
export const SNOW_COLOR = new THREE.Color("#e9eff7");

const data = new Uint8Array(RESOLUTION * RESOLUTION);

const texture = new THREE.DataTexture(
	data,
	RESOLUTION,
	RESOLUTION,
	THREE.RedFormat,
	THREE.UnsignedByteType
);
texture.magFilter = THREE.LinearFilter;
texture.minFilter = THREE.LinearFilter;
// Snow must not tile across the world edge, and a sampled edge texel should
// simply persist rather than wrap to the far side of the map.
texture.wrapS = THREE.ClampToEdgeWrapping;
texture.wrapT = THREE.ClampToEdgeWrapping;
texture.generateMipmaps = false;
texture.needsUpdate = true;

/** World extent (metres) covered by the mask, set per world. */
let extent = 200;

/**
 * Uniform objects shared by every snow-aware material.
 *
 * Handed out by reference so a world switch or a colour tweak reaches all of
 * them at once — the same pattern foliageWind uses for the wind clock.
 */
export const snowUniforms = {
	uSnowMask: { value: texture },
	uSnowExtent: { value: extent },
	uSnowColor: { value: SNOW_COLOR.clone() },
	/** Global multiplier — 0 disables snow shading entirely. */
	uSnowStrength: { value: 1 },
};

export function getSnowMaskTexture() {
	return texture;
}

/** Point the mask at a world. Clears it: coverage is per-world. */
export function configureSnowMask(worldSize: number) {
	extent = Math.max(1, worldSize);
	snowUniforms.uSnowExtent.value = extent;
	clearSnowMask();
}

export function clearSnowMask() {
	data.fill(0);
	texture.needsUpdate = true;
}

/** True once anything has been painted — lets callers skip snow work entirely. */
let painted = false;

export function hasSnow() {
	return painted;
}

/**
 * Deterministic per-texel jitter so patch edges break up instead of reading as
 * a stamped circle.
 *
 * Must be a hash of the coordinate, never Math.random(): these ops replay on
 * every peer and on every undo, so a random edge would differ per client and
 * change shape each time history is rebuilt. Same constraint the cave mesher
 * documents in editor/types.ts.
 */
function edgeNoise(px: number, py: number) {
	let h = (px * 374761393 + py * 668265263) | 0;
	h = (h ^ (h >>> 13)) * 1274126177;
	return ((h ^ (h >>> 16)) >>> 8) / 0xffffff;
}

/**
 * Union a soft circle of snow into the mask.
 *
 * Combined with max() rather than accumulated: replay must be idempotent, and
 * an additive brush would make coverage depend on how many times an op list was
 * applied and in what order.
 */
export function paintSnowCircle(
	worldX: number,
	worldZ: number,
	radius: number,
	strength = 1
) {
	if (radius <= 0) return;

	const texelsPerMeter = RESOLUTION / extent;
	const metersPerTexel = extent / RESOLUTION;

	// World origin sits at the texture centre — terrain is built centred on 0.
	const centerPx = (worldX / extent + 0.5) * RESOLUTION;
	const centerPy = (worldZ / extent + 0.5) * RESOLUTION;
	const radiusPx = radius * texelsPerMeter;

	const minPx = Math.max(0, Math.floor(centerPx - radiusPx - 1));
	const maxPx = Math.min(RESOLUTION - 1, Math.ceil(centerPx + radiusPx + 1));
	const minPy = Math.max(0, Math.floor(centerPy - radiusPx - 1));
	const maxPy = Math.min(RESOLUTION - 1, Math.ceil(centerPy + radiusPx + 1));
	if (minPx > maxPx || minPy > maxPy) return;

	const invRadius = 1 / radius;
	const clamped = Math.max(0, Math.min(1, strength));

	for (let py = minPy; py <= maxPy; py++) {
		const rowOffset = py * RESOLUTION;
		// Falloff measured in world units so a brush covers the same ground
		// regardless of world size / texel density.
		const dz = (py + 0.5 - centerPy) * metersPerTexel;
		for (let px = minPx; px <= maxPx; px++) {
			const dx = (px + 0.5 - centerPx) * metersPerTexel;
			const distance = Math.hypot(dx, dz);
			if (distance >= radius) continue;

			const t = 1 - distance * invRadius;
			const falloff = t * t * (3 - 2 * t);
			// Noise only bites near the rim, so patch interiors stay solid.
			const rim = 1 - falloff;
			const jitter = 1 - rim * rim * 0.55 * edgeNoise(px, py);

			const value = Math.round(falloff * jitter * clamped * 255);
			const index = rowOffset + px;
			if (value > data[index]!) data[index] = value;
		}
	}

	painted = true;
	texture.needsUpdate = true;
}

/**
 * Snow coverage at a world point, 0..1, read from the CPU copy.
 *
 * Gameplay side of the same mask — wheel friction, footstep sounds, particle
 * spawning. Nearest-texel is plenty for those.
 */
export function sampleSnow(worldX: number, worldZ: number) {
	if (!painted) return 0;
	const px = Math.floor((worldX / extent + 0.5) * RESOLUTION);
	const py = Math.floor((worldZ / extent + 0.5) * RESOLUTION);
	if (px < 0 || px >= RESOLUTION || py < 0 || py >= RESOLUTION) return 0;
	return data[py * RESOLUTION + px]! / 255;
}
