import { GUI } from "dat.gui";
import * as THREE from "three";
import { LightingModel, MeshLambertNodeMaterial } from "three/webgpu";
import {
	Fn,
	abs,
	diffuseColor,
	dot,
	exp,
	float,
	max,
	min,
	mix,
	normalView,
	normalize,
	positionLocal,
	positionWorld,
	sin,
	step,
	texture,
	uniform,
	uv,
	varyingProperty,
	vec2,
	normalLocal,
	distance,
	smoothstep,
	vec3,
	vec4,
	modelWorldMatrix,
	positionGeometry,
	attribute
} from "three/tsl";
import { snowMaskAt } from "./terrain/snowShading";
import { snowUniforms } from "./terrain/snowMask";

interface GrassUniformsInterface {
	uTime?: { value: number };
	uEnableShadows?: { value: boolean };
	uShadowDarkness?: { value: number };
	uGrassLightIntensity?: { value: number };
	uGrassLightColor?: { value: THREE.Color };
	uGrassAmbientColor?: { value: THREE.Color };
	uGrassShadowTint?: { value: THREE.Color };
	uNoiseScale?: { value: number };
	uBladeHeightScale?: { value: number };
	uTerrainSize?: { value: number };
	uPlayerPosition?: { value: THREE.Vector3 };
	baseColor?: { value: THREE.Color };
	tipColor1?: { value: THREE.Color };
	tipColor2?: { value: THREE.Color };
	noiseTexture?: { value: THREE.Texture };
	grassAlphaTexture?: { value: THREE.Texture };
	fogColor2?: { value: THREE.Color };
	fogColor3?: { value: THREE.Color };
}

/**
 * Blade shading, as a lighting model rather than a patched fragment shader.
 *
 * Grass does not want a Lambert response. Blades are near-vertical, so their
 * normals sit almost perpendicular to the key light and NdotL reads as noise
 * across the field — the WebGL version bypassed three's lighting entirely and
 * hand-rolled this. A `LightingModel` is the node-graph equivalent of that
 * bypass, and unlike a standalone `shadow()` node it reuses the shadow map the
 * light rig already renders instead of asking for a second one.
 *
 * What arrives in `direct` already carries the shadow term and, for the car's
 * headlights, the spot cone attenuation.
 */
const LUMA = /*#__PURE__*/ vec3(0.2126, 0.7152, 0.0722);

class GrassLightingModel extends LightingModel {
	private readonly tipLift: any;
	private readonly ambient: any;
	private readonly key: any;
	private readonly keyRadiance: any;
	private readonly shadowDarkness: any;
	private readonly shadowTint: any;

	constructor(params: {
		tipLift: any;
		ambient: any;
		key: any;
		keyRadiance: any;
		shadowDarkness: any;
		shadowTint: any;
	}) {
		super();
		this.tipLift = params.tipLift;
		this.ambient = params.ambient;
		this.key = params.key;
		this.keyRadiance = params.keyRadiance;
		this.shadowDarkness = params.shadowDarkness;
		this.shadowTint = params.shadowTint;
	}

	direct({ lightColor, lightDirection, lightNode, reflectedLight }: any) {
		const light = lightNode?.light;

		if (light?.isDirectionalLight) {
			// Grass is deliberately decoupled from the rig's key: `uGrassLightColor`
			// and `uGrassLightIntensity` describe how bright the field is, not the
			// sun's 3.6 lumens. But the *shadow* still has to come from the shared
			// map, and a lighting model is only handed `colour x intensity x shadow`
			// — so divide the rig's own radiance back out to recover the mask alone.
			const shadowMask = lightColor
				.dot(LUMA)
				.div(max(this.keyRadiance, float(1e-4)))
				.clamp();

			// The base->tip gradient stands in for NdotL, which reads as noise on a
			// near-vertical blade, and doubles as cheap AO.
			// Clamp tipLift so it doesn't act as a >1.0 multiplier (which blows out into HDR/bloom)
			const lit = this.key.mul(min(this.tipLift, float(1.0)));
			reflectedLight.directDiffuse.addAssign(
				mix(lit.mul(this.shadowDarkness).mul(this.shadowTint), lit, shadowMask).mul(
					diffuseColor.rgb
				)
			);
			return;
		}

		// Car headlights. Soft, and on the absolute value of NdotL, so a blade
		// lights up from either face rather than flickering as it sways through
		// the terminator.
		const ndl = abs(dot(normalView, lightDirection)).clamp();
		// Clamp lightColor to prevent infinite brightness when a point light 
		// passes exactly through a grass vertex (distance = 0)
		const safeLightColor = min(lightColor, vec3(10.0));
		reflectedLight.directDiffuse.addAssign(
			safeLightColor.mul(ndl).mul(0.28).mul(diffuseColor.rgb)
		);
	}

	indirect({ context }: any) {
		// Cool sky fill so the unlit side isn't just a darker green.
		context.reflectedLight.indirectDiffuse.addAssign(
			this.ambient.mul(diffuseColor.rgb)
		);
	}
}

export class GrassMaterial {
	material: MeshLambertNodeMaterial;

	private grassColorProps = {
		baseColor: "#1d360c",
		tipColor1: "#3f6d21",
		tipColor2: "#4c8129",
	};

	/**
	 * Every entry is a TSL node, but each keeps a `.value` so the existing
	 * callers (`setLightParams`, dat.gui, main's per-frame updates) read exactly
	 * as they did against the old GLSL uniform bag.
	 */
	uniforms: { [key: string]: any } = {
		uTime: uniform(0),
		uEnableShadows: uniform(1),
		uShadowDarkness: uniform(0.42),
		uGrassLightIntensity: uniform(1),
		/** Key light colour — grass shades itself, so this is fed in per frame. */
		uGrassLightColor: uniform(new THREE.Color(0xffd2a1)),
		/** Cool sky fill so the unlit side isn't just a darker green. */
		uGrassAmbientColor: uniform(new THREE.Color(0x40608f)),
		/** Hue multiplier inside cast shadows (blue shadows, not grey ones). */
		uGrassShadowTint: uniform(new THREE.Color(0x7d9ad6)),
		/**
		 * Luminance of the key light's own `color x intensity`.
		 *
		 * Only used to divide the rig's radiance back out of what the lighting
		 * model is handed, leaving the shadow mask — see GrassLightingModel.
		 * Fed per frame by `setKeyLightRadiance`.
		 */
		uKeyRadiance: uniform(1),
		uNoiseScale: uniform(1.5),
		/** Scales tip stretch / wind — must match blade instance height or grass stays tall. */
		uBladeHeightScale: uniform(0.6),
		uTerrainSize: uniform(140),
		uPlayerPosition: uniform(new THREE.Vector3()),
		baseColor: uniform(new THREE.Color(this.grassColorProps.baseColor)),
		tipColor1: uniform(new THREE.Color(this.grassColorProps.tipColor1)),
		tipColor2: uniform(new THREE.Color(this.grassColorProps.tipColor2)),
		noiseTexture: texture(new THREE.Texture()),
		grassAlphaTexture: texture(new THREE.Texture()),
	};

	private mergeUniforms(newUniforms?: GrassUniformsInterface) {
		if (!newUniforms) return;
		for (const [key, value] of Object.entries(newUniforms)) {
			if (value && Object.prototype.hasOwnProperty.call(this.uniforms, key)) {
				this.uniforms[key].value = (value as { value: unknown }).value ?? value;
			}
		}
	}

	constructor(grassProps?: GrassUniformsInterface) {
		this.mergeUniforms(grassProps);
		this.material = new MeshLambertNodeMaterial({
			side: THREE.DoubleSide,
			transparent: true,
			alphaTest: 0.1,
			shadowSide: THREE.BackSide,
		});
		// A double-sided *transparent* material is drawn twice — back faces, then
		// front — which for a field this size doubles both the draw calls and the
		// triangles for no visible gain on an alpha-cut blade.
		this.material.forceSinglePass = true;

		this.setupGrassMaterial(this.material);
	}

	/**
	 * Swap blade edges from blending to alpha-to-coverage.
	 *
	 * Alpha-tested grass in the transparent queue is a compromise: blending gives
	 * soft edges, but a field of this many blades cannot be depth-sorted
	 * meaningfully, so the draw order within the queue is effectively arbitrary.
	 * When the scene target is multisampled we can do better — move grass to the
	 * opaque queue, where it sorts front-to-back and depth-writes normally, and
	 * let per-sample coverage resolve the edges instead of blending.
	 *
	 * Gated on the pass's *actual* sample count, not the quality tier: with a
	 * single sample there is no partial coverage to be had and every blade edge
	 * would harden to the alpha-test cutoff.
	 */
	setAlphaToCoverage(enabled: boolean) {
		const material = this.material;
		if (material.alphaToCoverage === enabled) return;
		material.alphaToCoverage = enabled;
		material.transparent = !enabled;
		material.needsUpdate = true;
	}

	public updateGrassGraphicsChange(high: boolean = true) {
		this.uniforms.uEnableShadows.value = high ? 1 : 0;
	}

	update(delta: number) {
		this.uniforms.uTime.value = delta;
	}

	/**
	 * The grass shader does its own lighting and never reads the scene's key
	 * light, so the day/night colours have to be handed to it explicitly —
	 * otherwise grass stays neutral while everything else picks up the
	 * warm-key / cool-fill split.
	 */
	setLightParams(p: {
		keyColor: THREE.Color;
		intensity: number;
		ambient: THREE.Color;
		shadowTint: THREE.Color;
	}) {
		this.uniforms.uGrassLightColor.value.copy(p.keyColor);
		this.uniforms.uGrassLightIntensity.value = p.intensity;
		this.uniforms.uGrassAmbientColor.value.copy(p.ambient);
		this.uniforms.uGrassShadowTint.value.copy(p.shadowTint);
	}

	/**
	 * The key light's actual radiance, so the shader can separate the shadow term
	 * from the light's colour and intensity. Must track the same light the scene
	 * renders its shadow map for.
	 */
	setKeyLightRadiance(color: THREE.Color, intensity: number) {
		this.uniforms.uKeyRadiance.value =
			(color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722) * intensity;
	}

	/** Blade visual height (1 = original). Affects shader tip lift + wind amp. */
	setBladeHeightScale(scale: number) {
		this.uniforms.uBladeHeightScale.value = Math.max(0.05, scale);
	}

	private setupGrassMaterial(material: MeshLambertNodeMaterial) {
		const u = this.uniforms;

		// Mask UV sampled *before* the wind displacement below. Sampling the
		// swayed position would make both the colour variation and the snow
		// coverage shimmer as the blade moves. It is carried to the fragment
		// stage explicitly because `positionWorld` there reflects the final,
		// displaced vertex.
		const vGlobalUV = varyingProperty("vec2", "vGrassGlobalUV");
		const vBladeWorld = varyingProperty("vec3", "vGrassBladeWorld");

		material.normalNode = normalLocal;

		material.positionNode = Fn(() => {
			// positionLocal already carries the instance transform: NodeMaterial
			// applies instancing before it evaluates positionNode.
			const bladeWorld = modelWorldMatrix.mul(vec4(positionLocal, 1.0)).xyz.toVar();

			const terrainSize = u.uTerrainSize;
			const globalUV = terrainSize
				.sub(vec2(bladeWorld.x, bladeWorld.z))
				.div(terrainSize)
				.toVar();

			vGlobalUV.assign(globalUV);
			vBladeWorld.assign(bladeWorld);

			// Distance fade: sink grass into the ground at the edges
			const distToCamera = distance(bladeWorld, u.uPlayerPosition);
			// fadeStart = 48, fadeEnd = 68
			const fadeStart = float(48.0);
			const fadeEnd = float(68.0);
			const scale = float(1.0).sub(smoothstep(fadeStart, fadeEnd, distToCamera));
			
			const sinkOffset = float(1.0).sub(scale).mul(float(-2.0));
			const scaledPos = positionLocal.add(vec3(0.0, sinkOffset, 0.0));

			// Wind. Amplitude scales with blade height so short grass sways less.
			const windDirection = normalize(vec2(1.0, 1.0));
			const windAmp = float(0.1).mul(u.uBladeHeightScale).mul(scale);
			const windFreq = float(50.0);
			const speed = float(0.0);
			const noiseFactor = float(5.5);
			const noiseSpeed = float(0.0);

			const noise = u.noiseTexture.sample(
				globalUV.add(u.uTime.mul(noiseSpeed))
			);

			// uv().y runs 0 at the tip, 1 at the base for this blade geometry.
			const tip = float(1.0).sub(uv().y);

			const sinWave: any = sin(
				windFreq
					.mul(dot(windDirection, globalUV))
					.add(noise.g.mul(noiseFactor))
					.add(u.uTime.mul(speed))
			)
				.mul(windAmp)
				.mul(tip);

			// Tip lift is in world units *after* the instance scale, so it has to
			// track blade height or grass stays tall when the instance Y shrinks.
			const lift: any = exp(u.noiseTexture.sample(globalUV.mul(u.uNoiseScale)).r)
				.mul(0.5)
				.mul(u.uBladeHeightScale)
				.mul(tip)
				.mul(scale);

			return scaledPos.add(vec3(sinWave, lift, sinWave));
		})();

		// The blade texture is authored with v increasing downward relative to the
		// geometry, hence the flip — base at 0, tip at 1 from here on.
		const bladeUV = vec2(uv().x, float(1.0).sub(uv().y));
		const grassAlpha = u.grassAlphaTexture.sample(bladeUV).r;

		const grassVariation = u.noiseTexture.sample(vGlobalUV.mul(u.uNoiseScale));
		const tipColor = mix(u.tipColor1, u.tipColor2, grassVariation.r);
		const albedo = mix(u.baseColor, tipColor, bladeUV.y).toVar();

		// Grass deliberately skips the upness term in snowAt(): blades are
		// near-vertical, so their normal.y is ~0 and it would cancel snow out
		// completely. Weight by height along the blade instead — tips catch the
		// most, bases stay greener, which is what a dusted field looks like.
		const snow = snowMaskAt(vBladeWorld).mul(mix(0.4, 1.0, bladeUV.y));

		material.colorNode = mix(albedo, snowUniforms.uSnowColor, snow);
		// Hand the alpha map through *continuous*, not pre-thresholded.
		//
		// The GLSL version wrote `step(0.1, alpha)` and let fixed-function
		// alpha-to-coverage turn that binary value into full or zero coverage —
		// clean, because the hardware derives coverage itself. Node materials
		// instead resolve coverage analytically:
		//
		//   a = smoothstep(alphaTest, alphaTest + fwidth(a), a)
		//
		// and `fwidth` of a binary signal is zero across every flat region and
		// spikes to ~1 on the one texel where it flips. Which pixels sit on that
		// flip changes as a blade sways sub-pixel, so coverage jumped between
		// discrete values every frame — the whole field sparkling green. Feeding
		// the raw alpha gives `fwidth` a real gradient to measure, which is what
		// that formula expects, and the edge resolves smoothly and stably.
		//
		// With alpha-to-coverage off the same `alphaTest: 0.1` still applies as a
		// hard cutout, so the no-MSAA path is unchanged.
		material.opacityNode = grassAlpha;

		// Warm key + cool fill, with the base->tip gradient standing in for NdotL.
		const tipLift = mix(0.55, 1.0, bladeUV.y);

		// Luminance-normalise the tint so it rotates hue instead of also
		// darkening — uShadowDarkness alone owns how dark shadows get.
		const tintLuma = max(dot(u.uGrassShadowTint, LUMA), float(1e-4));
		const shadowTint = mix(vec3(1.0), u.uGrassShadowTint.div(tintLuma), 0.6);

		const lightingModel = new GrassLightingModel({
			tipLift,
			ambient: u.uGrassAmbientColor,
			key: u.uGrassLightColor.mul(u.uGrassLightIntensity),
			keyRadiance: u.uKeyRadiance,
			// With shadows off this rises to 1, which is the old
			// `uEnableShadows == 0` branch: lit everywhere, no mask.
			shadowDarkness: mix(float(1.0), u.uShadowDarkness, u.uEnableShadows),
			shadowTint,
		});
		material.setupLightingModel = () => lightingModel as any;
	}

	setupTextures(grassAlphaTexture: THREE.Texture, noiseTexture: THREE.Texture) {
		this.uniforms.grassAlphaTexture.value = grassAlphaTexture;
		this.uniforms.noiseTexture.value = noiseTexture;
	}

	setTerrainSize(size: number) {
		this.uniforms.uTerrainSize.value = size;
	}

	setupGUI(gui: GUI) {
		const folder = gui.addFolder("Grass");
		folder
			.addColor(this.grassColorProps, "baseColor")
			.name("Base")
			.onChange((value) => this.uniforms.baseColor.value.set(value));
		folder
			.addColor(this.grassColorProps, "tipColor1")
			.name("Tip A")
			.onChange((value) => this.uniforms.tipColor1.value.set(value));
		folder
			.addColor(this.grassColorProps, "tipColor2")
			.name("Tip B")
			.onChange((value) => this.uniforms.tipColor2.value.set(value));
		folder.add(this.uniforms.uNoiseScale, "value", 0, 5).name("Noise");
		folder.add(this.uniforms.uGrassLightIntensity, "value", 0, 2).name("Light");
		folder.add(this.uniforms.uShadowDarkness, "value", 0, 1).name("Shadow");
		folder.add(this.uniforms.uEnableShadows, "value", 0, 1, 1).name("Shadows");

		folder.open();
	}
}

// ************** USAGE **************
/*
import { GrassMaterial } from "./GrassMaterial";

// in your main class
const grassMaterial: GrassMaterial;
// in your setup function
grassMaterial = new GrassMaterial();
// after loading the textures
grassMaterial.setupTextures(this.textures.grassAlpha, this.textures.perlinNoise);
// in your render function
uTime += this.clock.getDelta();
grassMaterial.update(uTime);

*/
