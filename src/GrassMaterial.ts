import { GUI } from "dat.gui";
import * as THREE from "three";
import { SNOW_GLSL, snowShaderUniforms } from "./terrain/snowShading";
import { MeshLambertNodeMaterial } from "three/webgpu";
import {
	positionLocal,
	vec3,
	vec2,
	vec4,
	float,
	color,
	uniform,
	texture,
	uv,
	mix,
	step,
	sin,
	cos,
	add,
	mul,
	pow,
	max,
	dot,
	normalLocal,
	positionWorld,
	exp
} from "three/tsl";

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
export class GrassMaterial {
	material: MeshLambertNodeMaterial;

	private grassColorProps = {
		baseColor: "#1d360c",
		tipColor1: "#3f6d21",
		tipColor2: "#4c8129",
	};

	uniforms: { [key: string]: { value: any } } = {
		uTime: { value: 0 },
		uEnableShadows: { value: true },
		uShadowDarkness: { value: 0.42 },
		uGrassLightIntensity: { value: 1 },
		/** Key light colour — grass shades itself, so this is fed in per frame. */
		uGrassLightColor: { value: new THREE.Color(0xffd2a1) },
		/** Cool sky fill so the unlit side isn't just a darker green. */
		uGrassAmbientColor: { value: new THREE.Color(0x40608f) },
		/** Hue multiplier inside cast shadows (blue shadows, not grey ones). */
		uGrassShadowTint: { value: new THREE.Color(0x7d9ad6) },
		uNoiseScale: { value: 1.5 },
		/** Scales tip stretch / wind — must match blade instance height or grass stays tall. */
		uBladeHeightScale: { value: 0.6 },
		uTerrainSize: { value: 140 },
		uPlayerPosition: { value: new THREE.Vector3() },
		baseColor: { value: new THREE.Color(this.grassColorProps.baseColor) },
		tipColor1: { value: new THREE.Color(this.grassColorProps.tipColor1) },
		tipColor2: { value: new THREE.Color(this.grassColorProps.tipColor2) },
		noiseTexture: { value: new THREE.Texture() },
		grassAlphaTexture: { value: new THREE.Texture() },
	};

	private mergeUniforms(newUniforms?: GrassUniformsInterface) {
		if (!newUniforms) return;
		for (const [key, value] of Object.entries(newUniforms)) {
			if (value && this.uniforms.hasOwnProperty(key)) {
				this.uniforms[key].value = value;
			}
		}
	}
	constructor(grassProps?: GrassUniformsInterface) {
		this.mergeUniforms(grassProps);
		this.material = new MeshLambertNodeMaterial({
			side: THREE.DoubleSide,
			color: 0x229944,
			transparent: true,
			alphaTest: 0.1,
			shadowSide: 1,
		});

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
		if (!high) {
			this.uniforms.uEnableShadows.value = false;
		} else {
			this.uniforms.uEnableShadows.value = true;
		}
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

	/** Blade visual height (1 = original). Affects shader tip lift + wind amp. */
	setBladeHeightScale(scale: number) {
		this.uniforms.uBladeHeightScale.value = Math.max(0.05, scale);
	}

	private setupGrassMaterial(material: MeshLambertNodeMaterial) {
		const uTime = uniform(0);
		const uTerrainSize = uniform(140);
		const uNoiseScale = uniform(1.5);
		const uBladeHeightScale = uniform(0.6);
		
		const uNoiseTexture = texture(this.uniforms.noiseTexture.value);
		const uGrassAlphaTexture = texture(this.uniforms.grassAlphaTexture.value);
		const uBaseColor = uniform(color(this.grassColorProps.baseColor));
		const uTipColor1 = uniform(color(this.grassColorProps.tipColor1));
		const uTipColor2 = uniform(color(this.grassColorProps.tipColor2));
		
		// Map our class-level uniforms to these TSL nodes so dat.gui and update() work
		this.uniforms.uTime = uTime;
		this.uniforms.uNoiseScale = uNoiseScale;
		this.uniforms.uBladeHeightScale = uBladeHeightScale;
		this.uniforms.uTerrainSize = uTerrainSize;
		
		// The original code expected baseColor to be an object with a .value.set() method.
		// TSL uniform nodes have a `.value` property. For colors, `.value` is a THREE.Color.
		this.uniforms.baseColor = uBaseColor;
		this.uniforms.tipColor1 = uTipColor1;
		this.uniforms.tipColor2 = uTipColor2;
		this.uniforms.noiseTexture = uNoiseTexture;
		this.uniforms.grassAlphaTexture = uGrassAlphaTexture;
		
		// 1. Position Node (Wind)
		const worldPos = positionWorld;
		
		const globalUV = worldPos.xz.div(uTerrainSize).add(0.5);
		const noise = uNoiseTexture.sample(globalUV.mul(uNoiseScale)).r;
		
		const speed = float(1.2);
		const windAmp = float(0.5);
		
		const windX = sin( uTime.mul(speed).add(worldPos.x.mul(0.1)).add(noise.mul(2.0)) ).mul(windAmp);
		const windZ = cos( uTime.mul(speed).add(worldPos.z.mul(0.1)).add(noise.mul(2.0)) ).mul(windAmp);
		
		const tip = uv().y.mul(uv().y);
		
		const xDisp = windX.mul(tip);
		const zDisp = windZ.mul(tip);
		const yDisp = exp(noise).mul(0.5).mul(uBladeHeightScale).mul(tip);
		
		material.positionNode = positionLocal.add(vec3(xDisp, yDisp, zDisp));
		
		// 2. Color Node
		const grassAlpha = uGrassAlphaTexture.sample(uv()).r;
		const tipColor = mix(uTipColor1, uTipColor2, noise);
		const diffuseColor = mix(uBaseColor, tipColor, uv().y);
		
		material.colorNode = diffuseColor;
		material.opacityNode = step(0.1, grassAlpha);
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
		folder.addColor(this.grassColorProps, "baseColor").name("Base").onChange((value) => {
			this.uniforms.baseColor.value = new THREE.Color(value);
		});
		folder.addColor(this.grassColorProps, "tipColor1").name("Tip A").onChange((value) => {
			this.uniforms.tipColor1.value = new THREE.Color(value);
		});
		folder.addColor(this.grassColorProps, "tipColor2").name("Tip B").onChange((value) => {
			this.uniforms.tipColor2.value = new THREE.Color(value);
		});
		folder.add(this.uniforms.uNoiseScale, "value", 0, 5).name("Noise");
		folder
			.add(this.uniforms.uGrassLightIntensity, "value", 0, 2)
			.name("Light");
		folder
			.add(this.uniforms.uShadowDarkness, "value", 0, 1)
			.name("Shadow");
		folder.add(this.uniforms.uEnableShadows, "value").name("Shadows");

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
