import * as THREE from "three";
import type { GraphicsQuality } from "../ui/GameSettings";
import type { WorldDefinition } from "../worlds/worldTypes";

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
 * Screen-space height + radial fog.
 * Uses a plain ShaderMaterial (no chunk includes / no Raw GLSL3) for max compatibility.
 */
export class VolumetricFogPass {
	enabled = false;

	private depthTexture: THREE.DepthTexture;
	private sceneRT: THREE.WebGLRenderTarget;
	private readonly fsScene = new THREE.Scene();
	private readonly fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	private readonly material: THREE.ShaderMaterial;
	private readonly fsMesh: THREE.Mesh;
	private readonly _invProjection = new THREE.Matrix4();
	private readonly _invView = new THREE.Matrix4();
	private readonly _sunDir = new THREE.Vector3(0.4, 0.8, 0.2);
	private steps = 24;

	constructor() {
		this.depthTexture = new THREE.DepthTexture(1, 1);
		this.depthTexture.format = THREE.DepthFormat;
		this.depthTexture.type = THREE.UnsignedIntType;

		this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
			depthTexture: this.depthTexture,
			depthBuffer: true,
			stencilBuffer: false,
			format: THREE.RGBAFormat,
			type: THREE.UnsignedByteType,
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
		});

		this.material = new THREE.ShaderMaterial({
			uniforms: {
				tDiffuse: { value: null as THREE.Texture | null },
				tDepth: { value: null as THREE.Texture | null },
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

				varying vec2 vUv;

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

				void main() {
					vec4 sceneSample = texture2D(tDiffuse, vUv);
					float depth = texture2D(tDepth, vUv).r;

					vec3 rayOrigin = uCameraPosition;
					vec3 worldPos = worldFromDepth(vUv, clamp(depth, 0.0, 0.999999));
					vec3 toPoint = worldPos - rayOrigin;
					float geoDist = length(toPoint);
					float dist = min(max(geoDist, 1.0), uMaxDistance);
					vec3 rayDir = toPoint / max(geoDist, 1e-4);

					int steps = uSteps;
					if (steps < 4) steps = 4;
					if (steps > 48) steps = 48;
					float stepSize = dist / float(steps);

					float transmittance = 1.0;
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

					vec3 color = sceneSample.rgb * transmittance + inScattered;
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

	setQuality(quality: GraphicsQuality) {
		this.steps = quality === "High" ? 24 : quality === "Medium" ? 12 : 8;
		this.material.uniforms.uSteps.value = this.steps;
	}

	setSize(width: number, height: number) {
		const w = Math.max(1, Math.floor(width));
		const h = Math.max(1, Math.floor(height));
		this.sceneRT.setSize(w, h);
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

	render(
		renderer: THREE.WebGLRenderer,
		scene: THREE.Scene,
		camera: THREE.Camera
	) {
		if (!this.enabled) {
			renderer.setRenderTarget(null);
			renderer.render(scene, camera);
			return;
		}

		const u = this.material.uniforms;
		u.tDiffuse.value = this.sceneRT.texture;
		u.tDepth.value = this.depthTexture;

		camera.updateMatrixWorld(true);
		this._invProjection.copy(camera.projectionMatrix).invert();
		this._invView.copy(camera.matrixWorld);
		u.uCameraPosition.value.setFromMatrixPosition(camera.matrixWorld);

		const prevTarget = renderer.getRenderTarget();
		const prevAutoClear = renderer.autoClear;
		const prevOutputColorSpace = renderer.outputColorSpace;

		// Tone-mapped scene into RT without canvas sRGB encode (we encode in the blit).
		renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
		renderer.setRenderTarget(this.sceneRT);
		renderer.autoClear = true;
		renderer.clear();
		renderer.render(scene, camera);

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
		(this.fsMesh.geometry as THREE.BufferGeometry).dispose();
	}
}
