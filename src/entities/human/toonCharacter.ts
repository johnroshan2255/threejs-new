import * as THREE from "three";

/**
 * Genshin-style character shading: rim light, cool shadow hue, outlines, and
 * optionally a quantised light ramp.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ NOT CURRENTLY USED. main.ts calls only setCharacterAlbedo() — the        │
 * │ characters render with their original GLB materials by request.          │
 * │                                                                          │
 * │ Two things made this treatment wrong for poutine.glb specifically:       │
 * │                                                                          │
 * │ 1. Outlines. Inverted-hull extrudes the silhouette outward, which only   │
 * │    works where the mesh is thicker than the outline. On thin geometry —  │
 * │    this model's fingers and forearms — the shell covers the surface      │
 * │    entirely and they render as solid dark blobs, not edged shapes. A     │
 * │    screen-space depth/normal edge pass would not have this failure mode  │
 * │    and is the better choice if outlines are wanted here.                │
 * │                                                                          │
 * │ 2. The ramp. See the note below: it needs a colour texture to work, and  │
 * │    this model has none.                                                  │
 * │                                                                          │
 * │ Kept because it is correct for a *textured* character, which is what     │
 * │ Genshin's own pipeline assumes. Do not re-enable on an untextured model. │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Deliberately characters-only. Genshin's *environments* are stylised semi-PBR
 * with baked GI — it is the characters that get this treatment. Keeping
 * terrain/grass/foliage on their existing materials avoids touching the
 * hand-rolled light loop in GrassMaterial and costs nothing visually.
 *
 * IMPORTANT — `ramp` defaults to OFF, and that is not a performance choice.
 *
 * A ramp replaces smooth diffuse falloff with a few flat bands. That only reads
 * well when the model has a texture carrying its colour and detail, which is how
 * Genshin's characters are built: the ramp quantises *lighting*, while the
 * texture supplies form. On an untextured model the lighting gradient IS the
 * form — so ramping it collapses the character into flat regions of its base
 * colour and it looks like a blank mannequin.
 *
 * poutine.glb is exactly that case: one material, no textures, no vertex
 * colours, white base colour, roughness 0.43. Its entire appearance comes from
 * the GGX specular falloff. So it keeps MeshStandardMaterial and gets only the
 * additive NPR passes on top. Turn `ramp` on for characters that do have
 * painted textures.
 */

/** Shared per-frame NPR params — one object referenced by every character material. */
export const toonCharacterUniforms = {
	uRimColor: { value: new THREE.Color(0xffe6c0) },
	uRimStrength: { value: 0.7 },
	uRimPower: { value: 3.0 },
	uCharShadowTint: { value: new THREE.Color(0x5c76c8) },
	/** How far the unlit side is pushed toward the tint hue. */
	uCharShadowTintStrength: { value: 0.4 },
	uSpecColor: { value: new THREE.Color(0xffffff) },
	uSpecPower: { value: 48.0 },
	uSpecThreshold: { value: 0.45 },
	uSpecSoftness: { value: 0.08 },
	/**
	 * Low by default: in the no-ramp path the material's own GGX lobe already
	 * provides a highlight, so this is a small stylised accent rather than the
	 * primary specular. Stacking a second full-strength highlight on a white
	 * albedo is what blew the character out. Raise it when ramp is on, where
	 * there is no GGX to begin with.
	 */
	uSpecStrength: { value: 0.1 },
};

/** Shared outline params. Width is in *pixels*, so model scale doesn't matter. */
export const toonOutlineUniforms = {
	uOutlineWidth: { value: 1.6 },
	/** Distance at which the outline is exactly uOutlineWidth pixels wide. */
	uRefDistance: { value: 6.0 },
	/** Floor on the distance falloff so far silhouettes keep an outline. */
	uMinScale: { value: 0.3 },
	uResolution: { value: new THREE.Vector2(1, 1) },
};

export type ToonCharacterLight = {
	rimColor: THREE.Color;
	rimStrength: number;
	shadowTint: THREE.Color;
};

/** Feed the day/night table into every character material at once. */
export function updateToonCharacterLight(p: ToonCharacterLight) {
	toonCharacterUniforms.uRimColor.value.copy(p.rimColor);
	toonCharacterUniforms.uRimStrength.value = p.rimStrength;
	toonCharacterUniforms.uCharShadowTint.value.copy(p.shadowTint);
}

/** Outline width is screen-space, so it needs the drawing-buffer size. */
export function setToonOutlineResolution(width: number, height: number) {
	toonOutlineUniforms.uResolution.value.set(
		Math.max(1, width),
		Math.max(1, height)
	);
}

let sharedRamp: THREE.DataTexture | null = null;

/**
 * Quantised light ramp. `coord = NdotL * 0.5 + 0.5`, so 0.5 is the terminator.
 * Three bands: shadow, a thin midtone sliver at the terminator, then full light
 * — NearestFilter keeps the edges hard, which is the whole point.
 */
export function createToonRamp(
	stops: Array<[number, number]> = [
		[0.5, 0.3],
		[0.58, 0.62],
		[1.0, 1.0],
	],
	width = 64
): THREE.DataTexture {
	const data = new Uint8Array(width * 4);
	for (let i = 0; i < width; i++) {
		const x = (i + 0.5) / width;
		let value = stops[stops.length - 1][1];
		for (const [threshold, v] of stops) {
			if (x < threshold) {
				value = v;
				break;
			}
		}
		const byte = Math.round(THREE.MathUtils.clamp(value, 0, 1) * 255);
		data[i * 4 + 0] = byte;
		data[i * 4 + 1] = byte;
		data[i * 4 + 2] = byte;
		data[i * 4 + 3] = 255;
	}
	const tex = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
	tex.minFilter = THREE.NearestFilter;
	tex.magFilter = THREE.NearestFilter;
	tex.generateMipmaps = false;
	tex.wrapS = THREE.ClampToEdgeWrapping;
	tex.wrapT = THREE.ClampToEdgeWrapping;
	// Raw ramp values, not colour — must not be sRGB-decoded.
	tex.colorSpace = THREE.NoColorSpace;
	tex.needsUpdate = true;
	return tex;
}

function getSharedRamp(): THREE.DataTexture {
	if (!sharedRamp) sharedRamp = createToonRamp();
	return sharedRamp;
}

/**
 * Injects rim light, a cool shadow-side hue shift, and a hard-edged stylised
 * highlight. Hooked at `lights_fragment_end` so it lands after light
 * accumulation but before tone mapping, and can therefore bloom.
 */
function patchToonShader(material: THREE.MeshToonMaterial) { return; }

/**
 * Screen-space inverted-hull outline.
 *
 * Extrudes along the view normal in NDC (scaled by w) so width is measured in
 * pixels — necessary here because characters sit under a 0.03 root scale, which
 * would make any object-space width meaningless. Cheaper than a Sobel
 * depth/normal post pass at this character count, and gives per-vertex control.
 */
function createOutlineMaterial(color: THREE.ColorRepresentation) {
	const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, depthWrite: true }) as any;
	mat.uniforms = {
		uOutlineWidth: { value: 0 },
		uRefDistance: { value: 0 },
		uMinScale: { value: 0 },
		uResolution: { value: new THREE.Vector2() },
		uOutlineColor: { value: new THREE.Color(color) }
	};
	return mat;
}

export type ToonCharacterOptions = {
	/** Add inverted-hull outlines. */
	outline?: boolean;
	/** Outline colour — a dark tint of the character reads better than black. */
	outlineColor?: THREE.ColorRepresentation;
	/**
	 * Quantise diffuse into bands via MeshToonMaterial. Only enable for models
	 * with a colour texture — see the note at the top of this file.
	 */
	ramp?: boolean;
	/** Override the shared 3-band ramp texture (implies ramp: true). */
	rampTexture?: THREE.DataTexture;
	/**
	 * Ceiling on base colour for materials with no colour texture.
	 *
	 * glTF defaults `baseColorFactor` to pure white, so an untextured model gets
	 * albedo 1.0 — which no real surface has (snow is ~0.9, most things 0.2-0.6).
	 * Under a strong key that saturates the top of the tone curve: the whole lit
	 * half lands in a few percent of each other, form disappears, and it crosses
	 * the bloom threshold so it glows as well. Set 0 to leave colours untouched.
	 */
	maxAlbedo?: number;
};

/**
 * Scale an untextured material's base colour down to a physically sane albedo.
 * Idempotent — the authored colour is cached, so repeated calls with different
 * ceilings do not compound.
 */
function clampAlbedo(material: THREE.Material, maxAlbedo: number) {
	if (maxAlbedo <= 0) return;
	const m = material as THREE.MeshStandardMaterial;
	if (!m.color) return;
	// A colour texture already supplies the albedo; only flat colours need this.
	if (m.map) return;

	let base = m.userData.baseAlbedoColor as THREE.Color | undefined;
	if (!base) {
		base = m.color.clone();
		m.userData.baseAlbedoColor = base;
	}
	const peak = Math.max(base.r, base.g, base.b);
	m.color.copy(base);
	if (peak > maxAlbedo && peak > 1e-4) {
		m.color.multiplyScalar(maxAlbedo / peak);
	}
}

/** Re-apply an albedo ceiling to an already-converted character, live. */
export function setCharacterAlbedo(root: THREE.Object3D, maxAlbedo: number) {
	const seen = new Set<THREE.Material>();
	root.traverse((child) => {
		const mesh = child as THREE.Mesh;
		if (!mesh.isMesh || mesh.userData.isToonOutline) return;
		const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
		for (const m of mats) {
			if (!m || seen.has(m)) continue;
			seen.add(m);
			clampAlbedo(m, maxAlbedo);
		}
	});
}

/** Convert a source material to its toon equivalent, carrying maps across. */
function toToonMaterial(
	src: THREE.Material,
	ramp: THREE.DataTexture
): THREE.MeshToonMaterial {
	const std = src as THREE.MeshStandardMaterial;

	// Built incrementally: three's setValues() warns on any explicitly-undefined
	// key, so only pass what the source actually had.
	const params: THREE.MeshToonMaterialParameters = {
		color: std.color ? std.color.clone() : new THREE.Color(0xffffff),
		gradientMap: ramp,
		transparent: src.transparent,
		opacity: src.opacity,
		alphaTest: src.alphaTest,
		side: src.side,
		depthWrite: src.depthWrite,
		vertexColors: src.vertexColors,
	};
	if (std.map) params.map = std.map;
	if (std.normalMap) {
		params.normalMap = std.normalMap;
		if (std.normalScale) params.normalScale = std.normalScale.clone();
	}
	if (std.alphaMap) params.alphaMap = std.alphaMap;
	if (std.emissive) params.emissive = std.emissive.clone();
	if (std.emissiveMap) params.emissiveMap = std.emissiveMap;
	if (std.emissiveIntensity != null) {
		params.emissiveIntensity = std.emissiveIntensity;
	}
	if (std.aoMap) params.aoMap = std.aoMap;
	if (src.shadowSide != null) params.shadowSide = src.shadowSide;

	const toon = new THREE.MeshToonMaterial(params);

	toon.name = `${src.name || "material"}__toon`;
	patchToonShader(toon);
	return toon;
}

function buildOutline(
	source: THREE.Mesh,
	color: THREE.ColorRepresentation
): THREE.Mesh | null {
	const material = createOutlineMaterial(color);
	let outline: THREE.Mesh;

	const skinned = source as THREE.SkinnedMesh;
	if (skinned.isSkinnedMesh) {
		const sk = new THREE.SkinnedMesh(skinned.geometry, material);
		sk.bindMode = skinned.bindMode;
		// Same skeleton and bind matrix, so it deforms in lockstep with the source.
		sk.bind(skinned.skeleton, skinned.bindMatrix);
		outline = sk;
	} else {
		outline = new THREE.Mesh(source.geometry, material);
	}

	outline.name = `${source.name}__outline`;
	// Sibling of the source, so copy the local transform to match world space.
	outline.position.copy(source.position);
	outline.quaternion.copy(source.quaternion);
	outline.scale.copy(source.scale);
	outline.castShadow = false;
	outline.receiveShadow = false;
	outline.renderOrder = source.renderOrder - 1;
	outline.userData.isToonOutline = true;
	return outline;
}

/**
 * Convert a character hierarchy to toon shading in place.
 * Safe to call twice on the same root — already-converted meshes are skipped.
 */
export function applyToonCharacter(
	root: THREE.Object3D,
	options: ToonCharacterOptions = {}
) {
	const {
		outline = true,
		outlineColor = 0x2a1c26,
		rampTexture,
		ramp = rampTexture !== undefined,
		maxAlbedo = 0.58,
	} = options;

	// GLTFs share materials across meshes — handle each source once.
	const converted = new Map<THREE.Material, THREE.MeshToonMaterial>();
	const patched = new Set<THREE.Material>();
	const pending: Array<{ mesh: THREE.Mesh; parent: THREE.Object3D }> = [];

	root.traverse((child) => {
		const mesh = child as THREE.Mesh;
		if (!mesh.isMesh) return;
		if (mesh.userData.isToonOutline || mesh.userData.isToonCharacter) return;

		const materials = Array.isArray(mesh.material)
			? mesh.material
			: [mesh.material];

		const next = materials.map((m) => {
			if (!m) return m;
			if (ramp) {
				let toon = converted.get(m);
				if (!toon) {
					toon = toToonMaterial(m, rampTexture ?? getSharedRamp());
					clampAlbedo(toon, maxAlbedo);
					converted.set(m, toon);
				}
				return toon;
			}
			// Keep the original lit material — its diffuse/specular falloff is
			// what gives an untextured model its form — and add the NPR passes
			// on top. The injection hooks <lights_fragment_end>, which standard,
			// physical, lambert and toon materials all share.
			if (!patched.has(m)) {
				clampAlbedo(m, maxAlbedo);
				patchToonShader(m as THREE.MeshToonMaterial);
				m.needsUpdate = true;
				patched.add(m);
			}
			return m;
		});

		mesh.material = Array.isArray(mesh.material) ? next : next[0];
		mesh.userData.isToonCharacter = true;

		if (outline && mesh.parent) {
			pending.push({ mesh, parent: mesh.parent });
		}
	});

	// Deferred so we never mutate the graph mid-traverse.
	if (outline) {
		for (const { mesh, parent } of pending) {
			const shell = buildOutline(mesh, outlineColor);
			if (shell) parent.add(shell);
		}
	}

	// Only safe when the originals were replaced; in the patch path they are
	// still the live materials.
	for (const src of converted.keys()) src.dispose();
}

/** Toggle outlines (e.g. off in edit/map mode where they read as noise). */
export function setToonOutlinesVisible(root: THREE.Object3D, visible: boolean) {
	root.traverse((child) => {
		if (child.userData.isToonOutline) child.visible = visible;
	});
}
