import * as THREE from "three";
import type { QualityLevel } from "../ui/GameSettings";
import type { WorldDefinition } from "../worlds/worldTypes";
import { BloomChain } from "./BloomChain";

export type VolumetricFogFrameParams = {
	fogColor: THREE.Color;
	fogDensity: number;
	fogCenter: THREE.Vector3;
	fogRadius: number;
	fogRadiusSoft: number;
	fogHeight: number;
	heightFalloff: number;
	sunDirection: THREE.Vector3;
	sunColor: THREE.Color;
	sunIntensity: number;
	time: number;
};

/** Stylised grade applied in the composite, interpolated by the day/night table. */
export type CompositeGradeParams = {
	exposure: number;
	/** Radiance below this passes through untouched; above it rolls off to 1. */
	shoulder: number;
	contrast: number;
	saturation: number;
	shadowTint: THREE.Color;
	highlightTint: THREE.Color;
	/** Hue of the additive lift on darks. */
	liftColor: THREE.Color;
	/** Amount of additive lift. 0 for daylight, small positive at night. */
	lift: number;
	bloomStrength: number;
	bloomThreshold: number;
};

/** Player-centered fog ring inner radius (meters). */
export const PLAYER_FOG_RADIUS = 70;

/** Thickness of the fog band past the clear disk. */
export const PLAYER_FOG_BAND = 55;

/** Clear-disk radius — always a 70 m ring around the player. */
export function fogRadiusForWorld(_def: WorldDefinition): number {
	return PLAYER_FOG_RADIUS;
}

/** Fog bank always follows the player. */
export function fogFollowsPlayer(_def: WorldDefinition): boolean {
	return true;
}

export function fogDensityForWorld(def: WorldDefinition): number {
	if (def.kind === "valley") return 0.0055;
	if (def.kind === "custom") return 0.0045;
	return 0.005;
}

/**
 * Time-of-day fog amount vs a morning baseline (1.0):
 * morning haze → clearer noon → a little fog again at night.
 */
export function fogDensityScaleForHour(hour: number): number {
	const h = ((hour % 24) + 24) % 24;
	// Keyframes: [hour, scale]
	const keys: Array<[number, number]> = [
		[0, 0.72], // night
		[5, 0.78],
		[7, 1.0], // morning baseline
		[10, 0.7],
		[12.5, 0.48], // noon — clearest
		[16, 0.58],
		[18, 0.7],
		[20, 0.8],
		[22.5, 0.75],
		[24, 0.72],
	];
	for (let i = 0; i < keys.length - 1; i++) {
		const [h0, s0] = keys[i];
		const [h1, s1] = keys[i + 1];
		if (h >= h0 && h <= h1) {
			const t = (h - h0) / (h1 - h0);
			return s0 + (s1 - s0) * t;
		}
	}
	return 0.72;
}

/**
 * Bytes of MSAA storage per sample per pixel: RGBA16F colour (8) plus the
 * DEPTH_COMPONENT24 renderbuffer three allocates alongside it (4).
 */
const MSAA_BYTES_PER_SAMPLE_PER_PIXEL = 12;

/**
 * Ceiling on multisample storage for the scene target.
 *
 * The cap is on total bytes rather than on the sample count because this target
 * is full-res at the canvas pixel ratio: at pixelRatio 2 on a 1080p canvas it is
 * 3840x2160, which costs ~100 MB *per sample*. Asking for 4x there would want
 * ~400 MB of renderbuffer — more than everything else in the frame combined.
 * Budgeting the bytes lets big framebuffers step down to 2x instead of either
 * falling over or being denied MSAA entirely.
 */
const MSAA_BUDGET_BYTES = 192 * 1024 * 1024;

/**
 * The scene's single composite pass.
 *
 * Owns the whole back end of the frame: the scene is rendered into a linear
 * HDR target, bloom is built from it, and one fullscreen blit applies fog
 * in-scattering, bloom, the tone curve, the stylised grade and the sRGB encode.
 *
 * The scene target is multisampled, which is the *only* thing antialiasing the
 * scene — the renderer's own `antialias: true` applies to the default
 * framebuffer, and the only thing ever drawn there is the composite's
 * fullscreen quad, which has no interior edges to resolve.
 *
 * Tone mapping lives *here*, not in the materials — `renderer.toneMapping` must
 * stay `NoToneMapping` so values above 1.0 reach the bloom threshold instead of
 * being flattened per-material. Doing all of it in the blit we were already
 * drawing for fog means bloom and grading cost no extra fullscreen resolve.
 *
 * `enabled` gates only the fog raymarch; the composite itself always runs, so
 * the grade stays consistent on Low quality and in edit/map mode.
 */
export class VolumetricFogPass {
	/** Fog raymarch on/off. The composite runs regardless. */
	enabled = false;

	private depthTexture: THREE.DepthTexture;
	private sceneRT: THREE.RenderTarget;
	private readonly fsScene = new THREE.Scene();
	private readonly fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	private readonly material: THREE.ShaderMaterial;
	private readonly fsMesh: THREE.Mesh;
	private readonly _invProjection = new THREE.Matrix4();
	private readonly _invView = new THREE.Matrix4();
	private readonly _sunDir = new THREE.Vector3(0.4, 0.8, 0.2);
	private steps = 24;

	private width = 1;
	private height = 1;
	/** Samples the quality tier would like, before the memory budget is applied. */
	private msaaRequest = 4;
	/** Samples actually in force on `sceneRT`. */
	private samples = 0;

	private readonly bloom = new BloomChain();
	private bloomEnabled = true;
	private bloomThreshold = 0.75;
	/** Grade-authored strength, kept separate so a null bloom can't clobber it. */
	private bloomStrength = 0.4;

	constructor() {
		this.depthTexture = new THREE.DepthTexture(1, 1);
		this.depthTexture.format = THREE.DepthFormat;
		this.depthTexture.type = THREE.UnsignedIntType;

		this.sceneRT = new THREE.RenderTarget(1, 1, {
			depthTexture: this.depthTexture,
			depthBuffer: true,
			stencilBuffer: false,
			format: THREE.RGBAFormat,
			// HDR: bloom needs values above 1.0 to exist at all.
			type: THREE.HalfFloatType,
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			// Raised by `applySamples` once the real size and quality tier are
			// known — a 1x1 target has nothing worth multisampling.
			samples: 0,
		});

		this.material = new THREE.ShaderMaterial({
			uniforms: {
				tDiffuse: { value: null as THREE.Texture | null },
				tDepth: { value: null as THREE.Texture | null },
				tBloom: { value: null as THREE.Texture | null },
				uInverseProjection: { value: this._invProjection },
				uInverseView: { value: this._invView },
				uCameraPosition: { value: new THREE.Vector3() },
				uFogColor: { value: new THREE.Color(0xd8eef5) },
				uFogDensity: { value: 0.04 },
				uFogCenter: { value: new THREE.Vector3() },
				uFogRadius: { value: 65 },
				uFogRadiusSoft: { value: 120 },
				uFogHeight: { value: 0.0 },
				uHeightFalloff: { value: 0.04621 }, // ln(2)/15 → half density at +15m
				uSunDirection: { value: this._sunDir },
				uSunColor: { value: new THREE.Color(0xfff0d0) },
				uSunIntensity: { value: 0.45 },
				uSteps: { value: 24 },
				uTime: { value: 0 },
				uMaxDistance: { value: 500 },
				uFogEnabled: { value: 0 },

				// Grade
				uBloomStrength: { value: 0.4 },
				uExposure: { value: 1.0 },
				uShoulder: { value: 4.0 },
				uContrast: { value: 1.1 },
				uSaturation: { value: 1.25 },
				uShadowTint: { value: new THREE.Color(1, 1, 1) },
				uHighlightTint: { value: new THREE.Color(1, 1, 1) },
				/**
				 * How far toward the split-tone the image is pushed. Needed because
				 * luminance-normalising a *saturated* tint yields a huge multiplier
				 * (a saturated blue has very low luma, so normalising it gives ~3x
				 * blue). Authored tints must stay pale AND be blended in at partial
				 * strength, or darks — most of the frame — go monochrome blue.
				 */
				uSplitToneStrength: { value: 0.6 },
				/**
				 * Additive cool wash on darks. Multiplicative tinting cannot make a
				 * surface read blue if its albedo has no blue in it — grass at night
				 * stays green no matter how hard the shadow tint pushes. A lift adds
				 * light instead of scaling it, which is what gives night its cast.
				 */
				uLiftColor: { value: new THREE.Color(0x2f4f96) },
				uLift: { value: 0.0 },
				uVignette: { value: 0.16 },
			},
			vertexShader: /* glsl */ `
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = vec4(position.xy, 0.0, 1.0);
				}
			`,
			fragmentShader: /* glsl */ `
				precision highp float;
				precision highp sampler2D;

				uniform sampler2D tDiffuse;
				uniform sampler2D tDepth;
				uniform sampler2D tBloom;
				uniform mat4 uInverseProjection;
				uniform mat4 uInverseView;
				uniform vec3 uCameraPosition;
				uniform vec3 uFogColor;
				uniform float uFogDensity;
				uniform vec3 uFogCenter;
				uniform float uFogRadius;
				uniform float uFogRadiusSoft;
				uniform float uFogHeight;
				uniform float uHeightFalloff;
				uniform vec3 uSunDirection;
				uniform vec3 uSunColor;
				uniform float uSunIntensity;
				uniform int uSteps;
				uniform float uTime;
				uniform float uMaxDistance;
				uniform int uFogEnabled;

				uniform float uBloomStrength;
				uniform float uExposure;
				uniform float uShoulder;
				uniform float uContrast;
				uniform float uSaturation;
				uniform vec3 uShadowTint;
				uniform vec3 uHighlightTint;
				uniform float uSplitToneStrength;
				uniform vec3 uLiftColor;
				uniform float uLift;
				uniform float uVignette;

				varying vec2 vUv;

				const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

				vec3 worldFromDepth(vec2 uv, float depth) {
					vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
					vec4 viewPos = uInverseProjection * ndc;
					viewPos.xyz /= max(viewPos.w, 1e-6);
					vec4 worldPos = uInverseView * vec4(viewPos.xyz, 1.0);
					return worldPos.xyz;
				}

				float softNoise(vec3 p) {
					vec3 i = floor(p);
					vec3 f = fract(p);
					f = f * f * (3.0 - 2.0 * f);
					float n000 = fract(sin(dot(i, vec3(127.1, 311.7, 74.7))) * 43758.5453);
					float n100 = fract(sin(dot(i + vec3(1.0,0.0,0.0), vec3(127.1, 311.7, 74.7))) * 43758.5453);
					float n010 = fract(sin(dot(i + vec3(0.0,1.0,0.0), vec3(127.1, 311.7, 74.7))) * 43758.5453);
					float n110 = fract(sin(dot(i + vec3(1.0,1.0,0.0), vec3(127.1, 311.7, 74.7))) * 43758.5453);
					float n001 = fract(sin(dot(i + vec3(0.0,0.0,1.0), vec3(127.1, 311.7, 74.7))) * 43758.5453);
					float n101 = fract(sin(dot(i + vec3(1.0,0.0,1.0), vec3(127.1, 311.7, 74.7))) * 43758.5453);
					float n011 = fract(sin(dot(i + vec3(0.0,1.0,1.0), vec3(127.1, 311.7, 74.7))) * 43758.5453);
					float n111 = fract(sin(dot(i + vec3(1.0,1.0,1.0), vec3(127.1, 311.7, 74.7))) * 43758.5453);
					return mix(
						mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
						mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
						f.z
					);
				}

				float henyeyGreenstein(float cosTheta, float g) {
					float g2 = g * g;
					return (1.0 - g2) / max(1e-3, pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
				}

				vec3 linearTosRGB(vec3 value) {
					return vec3(
						value.r < 0.0031308 ? (value.r * 12.92) : (1.055 * pow(max(value.r, 0.0), 1.0 / 2.4) - 0.055),
						value.g < 0.0031308 ? (value.g * 12.92) : (1.055 * pow(max(value.g, 0.0), 1.0 / 2.4) - 0.055),
						value.b < 0.0031308 ? (value.b * 12.92) : (1.055 * pow(max(value.b, 0.0), 1.0 / 2.4) - 0.055)
					);
				}

				/**
				 * Linear up to uShoulder, then a soft asymptote to 1.0.
				 *
				 * Neither ACES nor Reinhard is right for this look. Both are
				 * photographic: they compress the *midtones*, mapping a fully-lit
				 * surface (radiance 1.0) to ~0.5 — mid grey. That is precisely what
				 * reads as "moody" and "no brightness", and no amount of saturation
				 * afterwards recovers it. Here midtones pass through untouched and
				 * only genuine highlights roll off, so lit surfaces stay lit.
				 */
				vec3 toneMap(vec3 c, float shoulder) {
					c = max(c, vec3(0.0));
					float k = clamp(shoulder, 0.05, 0.95);
					float range = 1.0 - k;
					vec3 lo = min(c, vec3(k));
					vec3 hi = max(c - k, vec3(0.0));
					return lo + range * (hi / (hi + range));
				}

				/**
				 * Contrast pivoted on linear mid-grey (0.18), applied in HDR before
				 * the curve. Pivoting on 0.5 — as if this were display-referred —
				 * darkens everything below 0.5, which is nearly the whole frame, and
				 * drives a dark night scene negative.
				 */
				vec3 applyContrast(vec3 c, float amount) {
					const float PIVOT = 0.18;
					return max((c - PIVOT) * amount + PIVOT, vec3(0.0));
				}

				/** Hue-only tint: normalised so split-toning never shifts exposure. */
				vec3 normTint(vec3 t) {
					return t / max(dot(t, LUMA), 1e-4);
				}

				vec3 raymarchFog(vec3 rayOrigin, vec3 rayDir, float dist, out float transmittance) {
					int steps = uSteps;
					if (steps < 4) steps = 4;
					if (steps > 48) steps = 48;
					float stepSize = dist / float(steps);

					transmittance = 1.0;
					vec3 inScattered = vec3(0.0);
					vec3 sunDir = normalize(uSunDirection);

					for (int i = 0; i < 48; i++) {
						if (i >= steps) break;
						float t = (float(i) + 0.5) * stepSize;
						vec3 p = rayOrigin + rayDir * t;

						// Fog only in a ring ~70 m from the player — clear nearby and far away.
						float heightAbove = max(0.0, p.y - uFogHeight);
						float heightFactor = exp(-uHeightFalloff * heightAbove);
						float xz = length(p.xz - uFogCenter.xz);
						float inner = uFogRadius;
						float outer = uFogRadius + uFogRadiusSoft;
						float rise = smoothstep(inner, inner + uFogRadiusSoft * 0.35, xz);
						float fall = 1.0 - smoothstep(outer - uFogRadiusSoft * 0.25, outer + uFogRadiusSoft * 0.45, xz);
						float radialDensity = rise * fall;
						float n = mix(0.85, 1.15, softNoise(p * 0.028 + vec3(uTime * 0.04, 0.0, uTime * 0.025)));

						float density = uFogDensity * heightFactor * radialDensity * n;
						float opticalDepth = density * stepSize;
						float stepTransmittance = exp(-opticalDepth);

						float phase = henyeyGreenstein(dot(rayDir, sunDir), 0.4);
						vec3 light = uFogColor * (0.85 + 0.15 * heightFactor)
							+ uSunColor * (uSunIntensity * phase * 0.45);

						inScattered += transmittance * (1.0 - stepTransmittance) * light;
						transmittance *= stepTransmittance;
						if (transmittance < 0.015) break;
					}

					return inScattered;
				}

				void main() {
					vec4 sceneSample = texture2D(tDiffuse, vUv);
					vec3 color = sceneSample.rgb;

					if (uFogEnabled == 1) {
						float depth = texture2D(tDepth, vUv).r;
						vec3 rayOrigin = uCameraPosition;
						vec3 worldPos = worldFromDepth(vUv, clamp(depth, 0.0, 0.999999));
						vec3 toPoint = worldPos - rayOrigin;
						float geoDist = length(toPoint);
						float dist = min(max(geoDist, 1.0), uMaxDistance);
						vec3 rayDir = toPoint / max(geoDist, 1e-4);

						float transmittance = 1.0;
						vec3 inScattered = raymarchFog(rayOrigin, rayDir, dist, transmittance);
						color = color * transmittance + inScattered;
					}

					// --- Bloom, added while still HDR so it can actually blow out ---
					color += texture2D(tBloom, vUv).rgb * uBloomStrength;

					// --- Exposure and contrast, both in HDR before the curve ---
					color = applyContrast(color * uExposure, uContrast);

					// --- Tone curve ---
					color = toneMap(color, uShoulder);

					// --- Split-tone: cool darks, warm brights. The complementary
					// split is what reads as "vivid" rather than merely bright. ---
					float luma = dot(color, LUMA);
					vec3 tint = mix(
						normTint(uShadowTint),
						normTint(uHighlightTint),
						smoothstep(0.0, 1.0, luma)
					);
					color *= mix(vec3(1.0), tint, uSplitToneStrength);

					// --- Additive lift on darks (night cast) ---
					// Normalised by max channel, not luma, so uLift alone controls
					// magnitude regardless of how saturated the lift colour is.
					vec3 liftHue = uLiftColor /
						max(max(uLiftColor.r, max(uLiftColor.g, uLiftColor.b)), 1e-4);
					color += liftHue * uLift * (1.0 - smoothstep(0.0, 0.55, luma));

					// --- Saturation ---
					float luma2 = dot(max(color, vec3(0.0)), LUMA);
					color = mix(vec3(luma2), color, uSaturation);

					// Subtle vignette to pull the eye centre-frame.
					vec2 vd = vUv - 0.5;
					float vig = 1.0 - uVignette * dot(vd, vd) * 2.0;
					color *= vig;

					color = clamp(color, 0.0, 1.0);
					gl_FragColor = vec4(linearTosRGB(color), 1.0);
				}
			`,
			depthTest: false,
			depthWrite: false,
			toneMapped: false,
		});

		this.fsMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
		this.fsMesh.frustumCulled = false;
		this.fsScene.add(this.fsMesh);
	}

	/**
	 * The other half of the user-facing effects toggle. Turning it off frees the
	 * mip chain rather than merely skipping the draws, and zeroes the composite's
	 * bloom inputs so a stale texture can't leak into the grade.
	 */
	setBloomEnabled(enabled: boolean) {
		if (this.bloomEnabled === enabled) return;
		this.bloomEnabled = enabled;
		if (!enabled) {
			this.bloom.release();
			this.material.uniforms.tBloom.value = null;
			this.material.uniforms.uBloomStrength.value = 0;
		}
	}

	/**
	 * Allocates targets and links every program the pass needs, off the render
	 * loop. `compileAsync` polls KHR_parallel_shader_compile rather than blocking
	 * on link, so a spinner can keep animating while this resolves.
	 */
	async warmup(renderer: any) {
		await renderer.compileAsync(this.fsScene, this.fsCamera);
		if (this.bloomEnabled) await this.bloom.warmup(renderer);
	}

	setQuality(quality: QualityLevel) {
		this.steps = quality === "High" ? 24 : quality === "Medium" ? 12 : 8;
		this.material.uniforms.uSteps.value = this.steps;
		// Fewer, wider mips on lower tiers — the glow stays broad, taps drop.
		this.bloom.setLevels(quality === "High" ? 5 : quality === "Medium" ? 4 : 3);
		// Low renders at pixelRatio 0.75, where MSAA storage would be the largest
		// single allocation in the frame for the tier least able to afford it.
		this.msaaRequest = quality === "High" ? 4 : quality === "Medium" ? 2 : 0;
		this.applySamples();
	}

	setSize(width: number, height: number) {
		const w = Math.max(1, Math.floor(width));
		const h = Math.max(1, Math.floor(height));
		this.width = w;
		this.height = h;
		this.sceneRT.setSize(w, h);
		this.bloom.setSize(w, h);
		// Resizing changes what the budget affords, so re-decide after the resize.
		this.applySamples();
	}

	/**
	 * MSAA samples in force on the scene target, after the memory budget. 0 means
	 * the scene is not being antialiased — callers that trade behaviour for
	 * coverage (alpha-to-coverage on foliage) have to gate on this rather than on
	 * the quality tier, since the budget can veto what the tier asked for.
	 */
	get sceneSamples(): number {
		return this.samples;
	}

	private resolveSamples(): number {
		if (this.msaaRequest < 2) return 0;
		const perSample =
			this.width * this.height * MSAA_BYTES_PER_SAMPLE_PER_PIXEL;
		if (perSample <= 0) return 0;
		const affordable = Math.floor(MSAA_BUDGET_BYTES / perSample);
		// Below 2x there is no such thing as partial coverage, so don't pay the
		// resolve blit for nothing.
		if (affordable < 2) return 0;
		return Math.min(this.msaaRequest, affordable >= 4 ? 4 : 2);
	}

	private applySamples() {
		const next = this.resolveSamples();
		if (next === this.samples) return;
		this.samples = next;
		this.sceneRT.samples = next;
		// Assigning `samples` alone does nothing: three only builds a target's GL
		// objects when it finds none cached, so the existing framebuffer would keep
		// its old sample count. `dispose()` drops the FBO and renderbuffers while
		// leaving the JS object (and the attached depth texture) intact, so the next
		// `setRenderTarget` reallocates at the new count. This is the same mechanism
		// `setSize` relies on.
		this.sceneRT.dispose();
	}

	setParams(p: VolumetricFogFrameParams) {
		const u = this.material.uniforms;
		u.uFogColor.value.copy(p.fogColor);
		u.uFogDensity.value = p.fogDensity;
		u.uFogCenter.value.copy(p.fogCenter);
		u.uFogRadius.value = p.fogRadius;
		u.uFogRadiusSoft.value = p.fogRadiusSoft;
		u.uFogHeight.value = p.fogHeight;
		u.uHeightFalloff.value = p.heightFalloff;
		u.uSunDirection.value.copy(p.sunDirection).normalize();
		u.uSunColor.value.copy(p.sunColor);
		u.uSunIntensity.value = p.sunIntensity;
		u.uTime.value = p.time;
	}

	setGrade(g: CompositeGradeParams) {
		const u = this.material.uniforms;
		u.uExposure.value = g.exposure;
		u.uShoulder.value = g.shoulder;
		u.uContrast.value = g.contrast;
		u.uSaturation.value = g.saturation;
		u.uShadowTint.value.copy(g.shadowTint);
		u.uHighlightTint.value.copy(g.highlightTint);
		u.uLiftColor.value.copy(g.liftColor);
		u.uLift.value = g.lift;
		this.bloomStrength = g.bloomStrength;
		this.bloomThreshold = g.bloomThreshold;
	}

	/** Vignette strength (0 disables). */
	setVignette(amount: number) {
		this.material.uniforms.uVignette.value = Math.max(0, amount);
	}

	/** 0 = no split-tone (neutral), 1 = full authored tint. */
	setSplitTone(strength: number) {
		this.material.uniforms.uSplitToneStrength.value = THREE.MathUtils.clamp(
			strength,
			0,
			1
		);
	}

	render(
		renderer: any,
		scene: THREE.Scene,
		camera: THREE.Camera
	) {
		const u = this.material.uniforms;
		u.tDiffuse.value = this.sceneRT.texture;
		u.tDepth.value = this.depthTexture;
		u.uFogEnabled.value = this.enabled ? 1 : 0;

		camera.updateMatrixWorld(true);
		this._invProjection.copy(camera.projectionMatrix).invert();
		this._invView.copy(camera.matrixWorld);
		u.uCameraPosition.value.setFromMatrixPosition(camera.matrixWorld);

		const prevTarget = renderer.getRenderTarget();
		const prevAutoClear = renderer.autoClear;
		const prevOutputColorSpace = renderer.outputColorSpace;

		// Scene into the HDR target with no encode — the blit tone maps and encodes.
		renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
		renderer.setRenderTarget(this.sceneRT);
		renderer.autoClear = true;
		renderer.clear();
		renderer.render(scene, camera);

		const bloomTex = this.bloomEnabled
			? this.bloom.render(renderer, this.sceneRT.texture, this.bloomThreshold)
			: null;
		u.tBloom.value = bloomTex;
		u.uBloomStrength.value = bloomTex ? this.bloomStrength : 0;

		renderer.setRenderTarget(null);
		renderer.autoClear = true;
		renderer.render(this.fsScene, this.fsCamera);

		renderer.outputColorSpace = prevOutputColorSpace;
		renderer.autoClear = prevAutoClear;
		renderer.setRenderTarget(prevTarget);
	}

	dispose() {
		this.sceneRT.dispose();
		this.depthTexture.dispose();
		this.material.dispose();
		this.bloom.dispose();
		(this.fsMesh.geometry as THREE.BufferGeometry).dispose();
	}
}
