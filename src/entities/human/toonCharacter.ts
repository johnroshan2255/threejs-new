import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import {
	Fn,
	abs,
	cameraProjectionMatrix,
	cameraViewMatrix,
	clamp,
	dot,
	float,
	length,
	materialColor,
	max,
	mix,
	modelViewMatrix,
	normalView,
	normalize,
	positionLocal,
	positionViewDirection,
	pow,
	saturate,
	select,
	smoothstep,
	uniform,
	vec2,
	vec3,
	vec4,
} from "three/tsl";

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
	uRimColor: uniform(new THREE.Color(0xffe6c0)),
	uRimStrength: uniform(0.7),
	uRimPower: uniform(3.0),
	uCharShadowTint: uniform(new THREE.Color(0x5c76c8)),
	/** How far the unlit side is pushed toward the tint hue. */
	uCharShadowTintStrength: uniform(0.4),
	uSpecColor: uniform(new THREE.Color(0xffffff)),
	uSpecPower: uniform(48.0),
	uSpecThreshold: uniform(0.45),
	uSpecSoftness: uniform(0.08),
	/**
	 * World-space direction *toward* the key light.
	 *
	 * The GLSL version read `directionalLights[0]` straight out of the light
	 * uniform block. Node materials give no equivalent handle on "the first
	 * directional light", and the NPR terms only ever wanted the key anyway — so
	 * it is fed in explicitly, alongside the rest of the day/night params.
	 */
	uKeyDirection: uniform(new THREE.Vector3(0, 1, 0)),
	uKeyColor: uniform(new THREE.Color(0xffffff)),
	/**
	 * Low by default: in the no-ramp path the material's own GGX lobe already
	 * provides a highlight, so this is a small stylised accent rather than the
	 * primary specular. Stacking a second full-strength highlight on a white
	 * albedo is what blew the character out. Raise it when ramp is on, where
	 * there is no GGX to begin with.
	 */
	uSpecStrength: uniform(0.1),
};

/** Shared outline params. Width is in *pixels*, so model scale doesn't matter. */
export const toonOutlineUniforms = {
	uOutlineWidth: uniform(1.6),
	/** Distance at which the outline is exactly uOutlineWidth pixels wide. */
	uRefDistance: uniform(6.0),
	/** Floor on the distance falloff so far silhouettes keep an outline. */
	uMinScale: uniform(0.3),
	uResolution: uniform(new THREE.Vector2(1, 1)),
};

export type ToonCharacterLight = {
	rimColor: THREE.Color;
	rimStrength: number;
	shadowTint: THREE.Color;
	/** World-space direction toward the key light (dayNight.getSunDirection()). */
	keyDirection?: THREE.Vector3;
	keyColor?: THREE.Color;
};

/** Feed the day/night table into every character material at once. */
export function updateToonCharacterLight(p: ToonCharacterLight) {
	toonCharacterUniforms.uRimColor.value.copy(p.rimColor);
	toonCharacterUniforms.uRimStrength.value = p.rimStrength;
	toonCharacterUniforms.uCharShadowTint.value.copy(p.shadowTint);
	if (p.keyDirection) {
		toonCharacterUniforms.uKeyDirection.value.copy(p.keyDirection).normalize();
	}
	if (p.keyColor) toonCharacterUniforms.uKeyColor.value.copy(p.keyColor);
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
function patchToonShader(material: THREE.MeshToonMaterial) {
	const u = toonCharacterUniforms;
	const mat = material as any;

	// View-space, to match normalView / positionViewDirection below. The GLSL
	// version got this for free because directionalLights[].direction is already
	// view space.
	const keyDir: any = cameraViewMatrix.transformDirection(u.uKeyDirection);
	const ndl: any = dot(normalView, keyDir);

	// Unlit side gets a cool *hue*, not just a lower value. Normalising by
	// luminance keeps this a rotation rather than a darkening.
	//
	// GLSL applied this to reflectedLight after accumulation, at full strength on
	// the direct term and half on the indirect. There is no node hook between
	// accumulation and output, so it moves into the albedo — where it reaches
	// both terms at one strength. The terminator hue is what the effect is for,
	// and that survives the move.
	const shadowMask = float(1.0).sub(smoothstep(-0.08, 0.18, ndl));
	const tintLuma: any = max(
		dot(u.uCharShadowTint as any, vec3(0.2126, 0.7152, 0.0722)),
		float(1e-4)
	);
	const tint: any = (u.uCharShadowTint as any).div(tintLuma);
	mat.colorNode = (materialColor as any).mul(
		mix(vec3(1.0), tint, shadowMask.mul(u.uCharShadowTintStrength))
	);

	// Silhouette rim. Added as emission rather than modulated by albedo so it
	// still reads on dark clothing — that separation from the background is most
	// of what makes a character look "anime". Emissive is exactly where
	// `totalEmissiveRadiance` landed, so it still blooms.
	const fres = pow(
		saturate(float(1.0).sub(abs(dot(normalView, positionViewDirection)))),
		u.uRimPower
	);
	const rim = fres.mul(smoothstep(-0.25, 0.35, ndl));

	// Hard-edged highlight instead of a GGX lobe.
	const halfDir = normalize(keyDir.add(positionViewDirection));
	const rawSpec = pow(saturate(dot(normalView, halfDir)), u.uSpecPower);
	const spec = smoothstep(
		u.uSpecThreshold,
		u.uSpecThreshold.add(u.uSpecSoftness),
		rawSpec
	);

	mat.emissiveNode = (u.uRimColor as any)
		.mul(rim.mul(u.uRimStrength))
		.add(
			(u.uKeyColor as any)
				.mul(u.uSpecColor)
				.mul(spec.mul(u.uSpecStrength).mul(saturate(ndl)))
		);

	mat.needsUpdate = true;
}

/**
 * Screen-space inverted-hull outline.
 *
 * Extrudes along the view normal in NDC (scaled by w) so width is measured in
 * pixels — necessary here because characters sit under a 0.03 root scale, which
 * would make any object-space width meaningless. Cheaper than a Sobel
 * depth/normal post pass at this character count, and gives per-vertex control.
 */
function createOutlineMaterial(color: THREE.ColorRepresentation) {
	const u = toonOutlineUniforms;
	const uOutlineColor = uniform(new THREE.Color(color));

	const mat = new MeshBasicNodeMaterial({
		// Inverted hull: draw only back faces of the inflated shell.
		side: THREE.BackSide,
		toneMapped: false,
		fog: false,
	});

	mat.vertexNode = Fn(() => {
		// positionLocal / normalView already carry skinning — NodeMaterial applies
		// it before it evaluates a vertexNode, which is what the GLSL version was
		// doing by hand with <skinning_vertex> / <skinnormal_vertex>.
		const mvPosition: any = modelViewMatrix.mul(vec4(positionLocal, 1.0)).toVar();
		const clip: any = cameraProjectionMatrix.mul(mvPosition).toVar();

		// Constant pixel width, tapering with distance so far characters don't end
		// up wearing a thick black suit.
		const dist = max(mvPosition.z.negate(), float(1e-3));
		const scale = clamp(u.uRefDistance.div(dist), u.uMinScale, float(1.0));
		const px = u.uOutlineWidth.mul(scale).mul(2.0).div(u.uResolution);

		const dir2: any = normalView.xy.toVar();
		const len = length(dir2);
		// A degenerate normal would otherwise push the vertex to NaN.
		dir2.assign(select(len.greaterThan(1e-5), dir2.div(len), vec2(0.0)));

		clip.xy = clip.xy.add(dir2.mul(px).mul(clip.w));
		return clip;
	})();

	mat.colorNode = uOutlineColor;
	(mat as any).uniforms = { ...u, uOutlineColor };
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
