import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import {
	Fn,
	If,
	Loop,
	abs,
	clamp,
	dot,
	exp,
	float,
	floor,
	fract,
	max,
	mix,
	normalize,
	positionGeometry,
	pow,
	smoothstep,
	step,
	uniform,
	vec2,
	vec3,
} from "three/tsl";

export type DayPeriod = "morning" | "noon" | "evening" | "sunset" | "night";

export type DayNightLights = {
	ambient: THREE.AmbientLight;
	hemisphere: THREE.HemisphereLight;
	/** Single key light — sun by day, moon by night (keeps grass shader stable). */
	keyLight: THREE.DirectionalLight;
};

type PeriodKey = {
	hour: number;
	/** Cool upper sky (away from sun). */
	zenith: string;
	/** Soft horizon base (not the whole sky). */
	horizon: string;
	fog: string;
	fogDensity: number;
	ambientColor: string;
	ambientIntensity: number;
	hemiSky: string;
	hemiGround: string;
	hemiIntensity: number;
	sunColor: string;
	sunIntensity: number;
	sunGlow: number;
	moonColor: string;
	moonIntensity: number;
	fireflies: number;
	grassLight: number;

	// --- Stylised grade (consumed by the composite pass) ---
	/** Pre-tonemap multiplier. */
	exposure: number;
	/** Radiance below this passes through untouched; above it rolls off to 1. */
	shoulder: number;
	/** S-curve amount around 0.5. */
	contrast: number;
	/** >1 pushes toward the vivid anime look; <1 for night, which reads as dark
	 *  and desaturated rather than blue-tinted. */
	saturation: number;
	/** Split-tone colour applied to darks (luminance-normalised). */
	shadowTint: string;
	/** Split-tone colour applied to brights (luminance-normalised). */
	highlightTint: string;
	bloomStrength: number;
	bloomThreshold: number;
	/** Hue of the additive lift applied to darks. */
	liftColor: string;
	/** Additive lift on darks. Kept small — just enough to stop black crush.
	 *  Pushing it high is what turns a night into a blue wash. */
	lift: number;

	// --- Character NPR ---
	/** Silhouette rim light colour. */
	rimColor: string;
	rimStrength: number;
	/** Hue pushed into the unlit side of characters. */
	charShadowTint: string;

	// --- Clouds (drawn in the sky dome shader) ---
	/** 0 = clear sky, 1 = overcast. */
	cloudCoverage: number;
	cloudOpacity: number;
	/** Lit tops. */
	cloudLight: string;
	/** Shadowed undersides / thin edges. */
	cloudDark: string;

	// --- Grass (its shader is decoupled from the light rig) ---
	/** Cool fill the grass gets regardless of sun direction. */
	grassAmbient: string;
	/** Multiplier tinting grass inside cast shadows. */
	grassShadowTint: string;
};

/**
 * Stylised (Genshin-leaning) rig. Two rules drive every value here:
 *
 *  1. Strong key, weak fill. Ambient + hemisphere stay well under the sun so
 *     surfaces keep a clear lit/unlit side. Raising fill to fix "too dark" is
 *     what flattens the image — brighten via exposure in the grade instead.
 *  2. Never grey by day. Light is warm, shadow/fill is cool. Two hues in every
 *     frame is what separates "vivid" from "dull"; a neutral rig cannot look
 *     vivid no matter how it is graded.
 *  3. Night is the exception: dark and *desaturated*, lit by near-neutral silver
 *     moonlight, keeping surface hues readable. The blue belongs in the sky, not
 *     painted over the ground.
 */
export const DAY_PERIODS: Record<DayPeriod, PeriodKey> = {
	morning: {
		hour: 7,
		zenith: "#5f9fd8",
		horizon: "#f2d5ab",
		fog: "#bcd2ea",
		fogDensity: 0.004,
		ambientColor: "#8194b8",
		ambientIntensity: 0.18,
		hemiSky: "#b2c8ea",
		hemiGround: "#4a5230",
		hemiIntensity: 0.28,
		sunColor: "#ffd2a1",
		sunIntensity: 3.0,
		sunGlow: 1.1,
		moonColor: "#9fc0ff",
		moonIntensity: 0,
		fireflies: 0,
		grassLight: 0.78,
		exposure: 1.05,
		shoulder: 0.7,
		contrast: 1.1,
		saturation: 1.14,
		shadowTint: "#a8b8d8",
		highlightTint: "#ffeccd",
		bloomStrength: 0.42,
		bloomThreshold: 0.72,
		liftColor: "#3a5a9c",
		lift: 0.0,
		rimColor: "#ffe6c0",
		rimStrength: 0.7,
		charShadowTint: "#aabcdf",
		grassAmbient: "#40608f",
		grassShadowTint: "#b2c2de",
		cloudCoverage: 0.52,
		cloudOpacity: 0.9,
		cloudLight: "#fff4e4",
		cloudDark: "#b9c6dd",
	},
	noon: {
		hour: 12.5,
		zenith: "#3f92dc",
		horizon: "#bfe0f7",
		fog: "#c4e0f2",
		fogDensity: 0.003,
		ambientColor: "#8b9dc0",
		ambientIntensity: 0.2,
		hemiSky: "#bcd4f0",
		hemiGround: "#5a6438",
		hemiIntensity: 0.32,
		sunColor: "#fff2d8",
		sunIntensity: 3.6,
		sunGlow: 0.55,
		moonColor: "#9fc0ff",
		moonIntensity: 0,
		fireflies: 0,
		grassLight: 0.9,
		exposure: 1.0,
		shoulder: 0.72,
		contrast: 1.08,
		saturation: 1.16,
		shadowTint: "#b0c0dc",
		highlightTint: "#fff2dd",
		bloomStrength: 0.34,
		bloomThreshold: 0.78,
		liftColor: "#3a5a9c",
		lift: 0.0,
		rimColor: "#fff4dc",
		rimStrength: 0.55,
		charShadowTint: "#b0c4e4",
		grassAmbient: "#476b9c",
		grassShadowTint: "#b8c6e0",
		cloudCoverage: 0.46,
		cloudOpacity: 0.85,
		cloudLight: "#ffffff",
		cloudDark: "#c6d6ea",
	},
	evening: {
		hour: 16.2,
		zenith: "#79b4e4",
		horizon: "#e4eef7",
		fog: "#cfe0ee",
		fogDensity: 0.003,
		ambientColor: "#8898bc",
		ambientIntensity: 0.18,
		hemiSky: "#b6cbec",
		hemiGround: "#55572f",
		hemiIntensity: 0.3,
		sunColor: "#ffcf9a",
		sunIntensity: 3.1,
		sunGlow: 0.25,
		moonColor: "#9fc0ff",
		moonIntensity: 0,
		fireflies: 0,
		grassLight: 0.86,
		exposure: 1.04,
		shoulder: 0.7,
		contrast: 1.1,
		saturation: 1.18,
		shadowTint: "#a8b8d8",
		highlightTint: "#ffe8c4",
		bloomStrength: 0.44,
		bloomThreshold: 0.7,
		liftColor: "#3a5a9c",
		lift: 0.0,
		rimColor: "#ffe2b4",
		rimStrength: 0.72,
		charShadowTint: "#a8bade",
		grassAmbient: "#446590",
		grassShadowTint: "#b2c2de",
		cloudCoverage: 0.5,
		cloudOpacity: 0.88,
		cloudLight: "#fff4e4",
		cloudDark: "#bfcde2",
	},
	sunset: {
		hour: 17.85,
		zenith: "#3f5fa4",
		horizon: "#ffb078",
		fog: "#e0a887",
		fogDensity: 0.004,
		ambientColor: "#8083b4",
		ambientIntensity: 0.2,
		hemiSky: "#bda6d0",
		hemiGround: "#4a3a34",
		hemiIntensity: 0.3,
		sunColor: "#ff9d5c",
		sunIntensity: 2.6,
		sunGlow: 0.85,
		moonColor: "#9fc0ff",
		moonIntensity: 0,
		fireflies: 0.12,
		grassLight: 0.72,
		exposure: 1.08,
		shoulder: 0.66,
		contrast: 1.12,
		saturation: 1.2,
		shadowTint: "#a8a8d6",
		highlightTint: "#ffdcb0",
		bloomStrength: 0.62,
		bloomThreshold: 0.6,
		liftColor: "#6a6490",
		lift: 0.014,
		rimColor: "#ffb884",
		rimStrength: 0.95,
		charShadowTint: "#a8a8dc",
		grassAmbient: "#4a4a86",
		grassShadowTint: "#b0acd8",
		cloudCoverage: 0.58,
		cloudOpacity: 0.95,
		cloudLight: "#ffd0a4",
		cloudDark: "#8f7ba8",
	},
	night: {
		hour: 22.5,
		zenith: "#0a1330",
		horizon: "#17284e",
		fog: "#1a2230",
		fogDensity: 0.007,
		ambientColor: "#525c6e",
		ambientIntensity: 0.3,
		hemiSky: "#5b6678",
		hemiGround: "#161a1e",
		hemiIntensity: 0.4,
		sunColor: "#ffd2a1",
		sunIntensity: 0,
		sunGlow: 0,
		moonColor: "#cdd8ea",
		moonIntensity: 1.7,
		fireflies: 1,
		grassLight: 0.42,
		exposure: 1.1,
		shoulder: 0.85,
		contrast: 1.05,
		saturation: 0.88,
		shadowTint: "#aeb6c6",
		highlightTint: "#e2e8f2",
		bloomStrength: 0.6,
		bloomThreshold: 0.62,
		liftColor: "#5a6478",
		lift: 0.022,
		rimColor: "#d2dced",
		rimStrength: 1.15,
		charShadowTint: "#a4acbc",
		grassAmbient: "#3a4658",
		grassShadowTint: "#aab2c2",
		cloudCoverage: 0.42,
		cloudOpacity: 0.7,
		cloudLight: "#9aa4b8",
		cloudDark: "#1a1f2c",
	},
};

const PERIOD_ORDER: DayPeriod[] = [
	"morning",
	"noon",
	"evening",
	"sunset",
	"night",
];

type PeriodNode = PeriodKey & { id: DayPeriod; hour: number };

const PERIOD_KEYS: PeriodNode[] = PERIOD_ORDER.map((id) => ({
	id,
	...DAY_PERIODS[id],
}));

const PERIOD_TIMELINE: PeriodNode[] = [
	{
		...DAY_PERIODS.night,
		id: "night",
		hour: DAY_PERIODS.night.hour - 24,
	},
	...PERIOD_KEYS,
	{
		...DAY_PERIODS.morning,
		id: "morning",
		hour: DAY_PERIODS.morning.hour + 24,
	},
];

const COLOR_CACHE = new Map<string, THREE.Color>();

function getColor(value: string): THREE.Color {
	let color = COLOR_CACHE.get(value);
	if (!color) {
		color = new THREE.Color(value);
		COLOR_CACHE.set(value, color);
	}
	return color;
}

type Sampled = {
	zenith: THREE.Color;
	horizon: THREE.Color;
	fog: THREE.Color;
	fogDensity: number;
	ambient: THREE.Color;
	ambientIntensity: number;
	hemiSky: THREE.Color;
	hemiGround: THREE.Color;
	hemiIntensity: number;
	sun: THREE.Color;
	sunIntensity: number;
	sunGlow: number;
	moon: THREE.Color;
	moonIntensity: number;
	fireflies: number;
	grassLight: number;
	exposure: number;
	shoulder: number;
	contrast: number;
	saturation: number;
	shadowTint: THREE.Color;
	highlightTint: THREE.Color;
	bloomStrength: number;
	bloomThreshold: number;
	liftColor: THREE.Color;
	lift: number;
	rimColor: THREE.Color;
	rimStrength: number;
	charShadowTint: THREE.Color;
	cloudCoverage: number;
	cloudOpacity: number;
	cloudLight: THREE.Color;
	cloudDark: THREE.Color;
	grassAmbient: THREE.Color;
	grassShadowTint: THREE.Color;
};

/** Interpolated grade for the composite pass. */
export type GradeParams = {
	exposure: number;
	shoulder: number;
	contrast: number;
	saturation: number;
	shadowTint: THREE.Color;
	highlightTint: THREE.Color;
	liftColor: THREE.Color;
	lift: number;
	bloomStrength: number;
	bloomThreshold: number;
};

/** Interpolated NPR params for character materials. */
export type CharacterLightParams = {
	rimColor: THREE.Color;
	rimStrength: number;
	shadowTint: THREE.Color;
};

/** Interpolated tints for the (light-rig-decoupled) grass shader. */
export type GrassLightParams = {
	/** Key light colour — grass multiplies this by its own light intensity. */
	keyColor: THREE.Color;
	intensity: number;
	ambient: THREE.Color;
	shadowTint: THREE.Color;
};

function hourToSunDirection(hour: number, out: THREE.Vector3): THREE.Vector3 {
	// 6 = sunrise horizon, 12 = zenith, 18 = sunset horizon
	const t = ((hour - 6) / 24) * Math.PI * 2;
	return out.set(Math.cos(t), Math.sin(t), Math.sin(t * 0.35) * 0.35).normalize();
}

function smoothstep01(t: number) {
	return t * t * (3 - 2 * t);
}

function sampleAtHour(hour: number, out: Sampled): Sampled {
	const h = ((hour % 24) + 24) % 24;

	const probe = h < PERIOD_KEYS[0].hour ? h + 24 : h;

	let from = PERIOD_TIMELINE[0];
	let to = PERIOD_TIMELINE[1];
	for (let i = 0; i < PERIOD_TIMELINE.length - 1; i++) {
		if (
			probe >= PERIOD_TIMELINE[i].hour &&
			probe <= PERIOD_TIMELINE[i + 1].hour
		) {
			from = PERIOD_TIMELINE[i];
			to = PERIOD_TIMELINE[i + 1];
			break;
		}
	}

	const t = smoothstep01(
		THREE.MathUtils.clamp(
			(probe - from.hour) / Math.max(0.001, to.hour - from.hour),
			0,
			1
		)
	);

	out.zenith.copy(getColor(from.zenith)).lerp(getColor(to.zenith), t);
	out.horizon.copy(getColor(from.horizon)).lerp(getColor(to.horizon), t);
	out.fog.copy(getColor(from.fog)).lerp(getColor(to.fog), t);
	out.fogDensity = THREE.MathUtils.lerp(from.fogDensity, to.fogDensity, t);
	out.ambient
		.copy(getColor(from.ambientColor))
		.lerp(getColor(to.ambientColor), t);
	out.ambientIntensity = THREE.MathUtils.lerp(
		from.ambientIntensity,
		to.ambientIntensity,
		t
	);
	out.hemiSky.copy(getColor(from.hemiSky)).lerp(getColor(to.hemiSky), t);
	out.hemiGround
		.copy(getColor(from.hemiGround))
		.lerp(getColor(to.hemiGround), t);
	out.hemiIntensity = THREE.MathUtils.lerp(from.hemiIntensity, to.hemiIntensity, t);
	out.sun.copy(getColor(from.sunColor)).lerp(getColor(to.sunColor), t);
	out.sunIntensity = THREE.MathUtils.lerp(from.sunIntensity, to.sunIntensity, t);
	out.sunGlow = THREE.MathUtils.lerp(from.sunGlow, to.sunGlow, t);
	out.moon.copy(getColor(from.moonColor)).lerp(getColor(to.moonColor), t);
	out.moonIntensity = THREE.MathUtils.lerp(from.moonIntensity, to.moonIntensity, t);
	out.fireflies = THREE.MathUtils.lerp(from.fireflies, to.fireflies, t);
	out.grassLight = THREE.MathUtils.lerp(from.grassLight, to.grassLight, t);

	out.exposure = THREE.MathUtils.lerp(from.exposure, to.exposure, t);
	out.shoulder = THREE.MathUtils.lerp(from.shoulder, to.shoulder, t);
	out.contrast = THREE.MathUtils.lerp(from.contrast, to.contrast, t);
	out.saturation = THREE.MathUtils.lerp(from.saturation, to.saturation, t);
	out.shadowTint
		.copy(getColor(from.shadowTint))
		.lerp(getColor(to.shadowTint), t);
	out.highlightTint
		.copy(getColor(from.highlightTint))
		.lerp(getColor(to.highlightTint), t);
	out.bloomStrength = THREE.MathUtils.lerp(
		from.bloomStrength,
		to.bloomStrength,
		t
	);
	out.bloomThreshold = THREE.MathUtils.lerp(
		from.bloomThreshold,
		to.bloomThreshold,
		t
	);
	out.liftColor.copy(getColor(from.liftColor)).lerp(getColor(to.liftColor), t);
	out.lift = THREE.MathUtils.lerp(from.lift, to.lift, t);

	out.rimColor.copy(getColor(from.rimColor)).lerp(getColor(to.rimColor), t);
	out.rimStrength = THREE.MathUtils.lerp(from.rimStrength, to.rimStrength, t);
	out.charShadowTint
		.copy(getColor(from.charShadowTint))
		.lerp(getColor(to.charShadowTint), t);

	out.cloudCoverage = THREE.MathUtils.lerp(
		from.cloudCoverage,
		to.cloudCoverage,
		t
	);
	out.cloudOpacity = THREE.MathUtils.lerp(from.cloudOpacity, to.cloudOpacity, t);
	out.cloudLight
		.copy(getColor(from.cloudLight))
		.lerp(getColor(to.cloudLight), t);
	out.cloudDark.copy(getColor(from.cloudDark)).lerp(getColor(to.cloudDark), t);
	out.grassAmbient
		.copy(getColor(from.grassAmbient))
		.lerp(getColor(to.grassAmbient), t);
	out.grassShadowTint
		.copy(getColor(from.grassShadowTint))
		.lerp(getColor(to.grassShadowTint), t);
	return out;
}

const hash21 = /*#__PURE__*/ Fn(([input]: [any]) => {
	const p: any = fract(input.mul(vec2(123.34, 456.21))).toVar();
	p.addAssign(dot(p, p.add(45.32)));
	return fract(p.x.mul(p.y));
});

const vnoise = /*#__PURE__*/ Fn(([p]: [any]) => {
	const i: any = floor(p).toVar();
	const f: any = fract(p).toVar();
	f.assign(f.mul(f).mul(float(3.0).sub(f.mul(2.0))));
	const a = hash21(i);
	const b = hash21(i.add(vec2(1.0, 0.0)));
	const c = hash21(i.add(vec2(0.0, 1.0)));
	const d = hash21(i.add(vec2(1.0, 1.0)));
	return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
});

/** 4 octaves — enough for billowy shapes without a heavy sky pass. */
const fbm = /*#__PURE__*/ Fn(([input]: [any]) => {
	const p = input.toVar();
	const v = float(0.0).toVar();
	const a = float(0.5).toVar();
	Loop(4, () => {
		v.addAssign(a.mul(vnoise(p)));
		p.assign(p.mul(2.02).add(vec2(17.3, 9.1)));
		a.mulAssign(0.5);
	});
	return v;
});

/**
 * Procedural sky dome: gradient, sun/moon discs and glow, and domain-warped
 * clouds — all in one fragment, no cubemap and no extra passes.
 *
 * The uniform bag keeps the `{ uName: { value } }` shape the day/night sampler
 * writes to every frame; each entry is a TSL uniform node, which exposes the
 * same `.value` while also being usable directly in the node graph.
 */
function createSkyMaterial() {
	const uniforms = {
		uSunDir: uniform(new THREE.Vector3(0, 1, 0)),
		uMoonDir: uniform(new THREE.Vector3(0, -1, 0)),
		uZenith: uniform(new THREE.Color("#4aa0e0")),
		uHorizon: uniform(new THREE.Color("#c8e4f5")),
		uSunColor: uniform(new THREE.Color("#fff5e0")),
		uMoonColor: uniform(new THREE.Color("#c4d4ff")),
		uSunGlow: uniform(1),
		uSunIntensity: uniform(1),
		uMoonIntensity: uniform(0),
		uTime: uniform(0),
		uCloudCoverage: uniform(0.45),
		uCloudOpacity: uniform(0.85),
		uCloudLight: uniform(new THREE.Color("#ffffff")),
		uCloudDark: uniform(new THREE.Color("#c6d6ea")),
		/** Larger = smaller, more numerous clouds. */
		uCloudScale: uniform(0.65),
		uCloudSpeed: uniform(1),
	};

	const mat = new MeshBasicNodeMaterial({
		side: THREE.BackSide,
		depthWrite: false,
		fog: false,
	});

	mat.colorNode = Fn(() => {
		// Direction from the dome's own centre, not from the world origin, so the
		// dome can be re-centred on the camera each frame without the sky sliding
		// as the player walks.
		const dir: any = normalize(positionGeometry).toVar();
		const sun: any = normalize(uniforms.uSunDir as any).toVar();
		const moon: any = normalize(uniforms.uMoonDir as any).toVar();

		const elev = dir.y;
		const hMix = smoothstep(-0.1, 0.7, elev);
		const sky = mix(uniforms.uHorizon, uniforms.uZenith, hMix).toVar();

		const sunElev = sun.y;
		// Only kick in strong warm glow when the sun is near the horizon.
		const lowSun = smoothstep(0.28, 0.02, sunElev);
		const sunDot = max(dot(dir, sun), 0.0).toVar();

		const dirFlat = normalize(vec3(dir.x, 0.001, dir.z));
		const sunFlat = normalize(vec3(sun.x, 0.001, sun.z));
		// Tight azimuth around the sun — stops a fire band across the sky.
		const towardSun = pow(max(dot(dirFlat, sunFlat), 0.0), 8.0);
		const horizonArc = exp(abs(elev.sub(max(sunElev, 0.0))).mul(-16.0));
		const sunHalo = pow(sunDot, 32.0).mul(uniforms.uSunGlow);
		const mie = pow(sunDot, 14.0).mul(uniforms.uSunGlow).mul(0.18);
		const warm = horizonArc
			.mul(towardSun)
			.mul(0.35)
			.add(sunHalo)
			.add(mie)
			.mul(lowSun)
			.mul(clamp(uniforms.uSunGlow, 0.0, 2.0));
		sky.addAssign(uniforms.uSunColor.mul(warm).mul(0.55));

		// Soft pale rim for evening (high sun) — tiny, not an orange wash.
		const dayGlow = pow(sunDot, 48.0)
			.mul(uniforms.uSunGlow)
			.mul(float(1.0).sub(lowSun));
		sky.addAssign(
			mix(uniforms.uSunColor, vec3(1.0), 0.5).mul(dayGlow).mul(0.35)
		);

		// Bright sun disc (single — no extra mesh orb).
		const disc = smoothstep(0.9994, 0.9999, sunDot).mul(step(-0.05, sunElev));
		sky.addAssign(
			mix(uniforms.uSunColor, vec3(1.0, 0.97, 0.9), 0.75)
				.mul(disc)
				.mul(uniforms.uSunGlow.mul(0.25).add(1.8))
		);

		// Soft moon at night.
		const moonDot = max(dot(dir, moon), 0.0).toVar();
		const moonDisc = smoothstep(0.9988, 0.9996, moonDot).mul(
			uniforms.uMoonIntensity
		);
		sky.addAssign(uniforms.uMoonColor.mul(moonDisc).mul(1.4));
		sky.addAssign(
			uniforms.uMoonColor
				.mul(pow(moonDot, 40.0))
				.mul(uniforms.uMoonIntensity)
				.mul(0.25)
		);

		// ---- Clouds -------------------------------------------------------
		// Projected onto a virtual flat plane overhead: dividing by dir.y is what
		// makes them converge and flatten toward the horizon instead of wrapping
		// the dome like wallpaper.
		const cloudFade = smoothstep(0.015, 0.2, elev);
		If(
			cloudFade
				.greaterThan(0.001)
				.and(uniforms.uCloudOpacity.greaterThan(0.001)),
			() => {
				const cuv = dir.xz.div(max(elev, 0.06)).mul(uniforms.uCloudScale);
				const drift = vec2(
					uniforms.uTime.mul(0.0075),
					uniforms.uTime.mul(0.003)
				).mul(uniforms.uCloudSpeed);

				// Domain warp — straight FBM gives soft blobs; warping it gives the
				// curled, billowed silhouette that reads as cumulus.
				const w = vec2(
					fbm(cuv.mul(0.5).add(drift)),
					fbm(cuv.mul(0.5).add(drift).add(3.7))
				).sub(0.5);
				const n = fbm(cuv.add(drift).add(w.mul(1.35))).toVar();

				const thresh = float(1.0).sub(uniforms.uCloudCoverage).toVar();
				const cov = smoothstep(thresh, thresh.add(0.22), n).toVar();
				const density = cov.mul(cloudFade).mul(uniforms.uCloudOpacity);

				// Thickness proxy: deeper into the cloud reads as lit top, thin edges
				// stay dark, which fakes self-shadowing cheaply.
				const cloudCol = mix(
					uniforms.uCloudDark,
					uniforms.uCloudLight,
					smoothstep(0.3, 0.85, n)
				).toVar();

				// Sun-side scattering plus a bright rim on thin edges — the silver
				// lining that sells a stylised sky.
				const sunAmt = pow(max(dot(dir, sun), 0.0), 3.0);
				const rim = smoothstep(0.6, 0.15, cov).mul(sunAmt);
				const sunScale = clamp(uniforms.uSunIntensity.div(3.0), 0.0, 1.2);
				cloudCol.addAssign(
					uniforms.uSunColor
						.mul(sunAmt.mul(0.3).add(rim.mul(0.85)))
						.mul(sunScale)
				);

				// Moonlit edges at night.
				const moonAmt = pow(max(dot(dir, moon), 0.0), 4.0);
				cloudCol.addAssign(
					uniforms.uMoonColor.mul(moonAmt).mul(uniforms.uMoonIntensity).mul(0.18)
				);

				// Drawn last so clouds occlude the sun and moon discs.
				sky.assign(mix(sky, cloudCol, clamp(density, 0.0, 1.0)));
			}
		);

		return sky;
	})();

	// The day/night sampler writes `skyMat.uniforms.uX.value` every frame.
	(mat as any).uniforms = uniforms;
	return mat as MeshBasicNodeMaterial & { uniforms: typeof uniforms };
}

export type DayNightCycle = {
	group: THREE.Group;
	lights: DayNightLights;
	hour: number;
	auto: boolean;
	speed: number;
	period: DayPeriod;
	setPeriod: (period: DayPeriod) => void;
	setHour: (hour: number) => void;
	update: (dt: number) => number;
	getFireflyIntensity: () => number;
	getGrassLight: () => number;
	/** Current lerped fog color from the day/night table. */
	getFogColor: () => THREE.Color;
	/** Current lerped FogExp2-style density from the day/night table. */
	getFogDensity: () => number;
	/** Unit sun direction (points toward the sun). */
	getSunDirection: () => THREE.Vector3;
	/** Current interpolated colour grade for the composite pass. */
	getGrade: () => GradeParams;
	/** Current interpolated rim / shadow-tint for character materials. */
	getCharacterLight: () => CharacterLightParams;
	/** Current interpolated tints for the grass shader. */
	getGrassLightParams: () => GrassLightParams;
	/**
	 * Re-anchor the shadow frustum. The ortho box is only ±shadowExtent wide, so
	 * without this shadows silently vanish once the player leaves the origin.
	 */
	setFocus: (x: number, z: number) => void;
	/**
	 * Shadow map resolution and ortho half-extent. The extent must cover the
	 * visible range or its edge becomes a moving hard cutoff; resolution then
	 * decides how crisp that coverage is.
	 */
	setShadowQuality: (mapSize: number, extent: number) => void;
	dispose: () => void;
	overrideColors: boolean;
	/** Multiplier on ambient + hemisphere intensity. 1 = as authored. */
	fillScale: number;
};

/**
 * Sun + moon day/night cycle with a directional sky (warm glow near the sun).
 * Uses ONE directional key light (sun↔moon) so the grass custom shader stays stable.
 */
export function createDayNightCycle(
	scene: THREE.Scene,
	options: { shadowExtent?: number } = {}
): DayNightCycle {
	/**
	 * Must cover everything that can be seen, or the box edge becomes a hard
	 * shadow cutoff that sweeps through the world as the player moves — distant
	 * shadows snapping on and off. Trees stay visible to 200 m, so 90 m left a
	 * cutoff right through the visible range.
	 */
	let shadowExtent = options.shadowExtent ?? 200;
	const group = new THREE.Group();
	group.name = "day-night";

	const ambient = new THREE.AmbientLight(0xffffff, 0.5);
	const hemisphere = new THREE.HemisphereLight(0x87ceeb, 0x3a4a20, 0.35);

	const keyLight = new THREE.DirectionalLight(0xfff5e0, 2);
	keyLight.castShadow = true;
	// Light orbits at 260 with a ±extent box, so casters can sit ~460 out.
	keyLight.shadow.camera.far = 700;
	keyLight.shadow.camera.left = -shadowExtent;
	keyLight.shadow.camera.right = shadowExtent;
	keyLight.shadow.camera.top = shadowExtent;
	keyLight.shadow.camera.bottom = -shadowExtent;
	keyLight.shadow.mapSize.set(2048, 2048);

	/**
	 * Shadow bias, scaled to the map's world texel size.
	 *
	 * normalBias offsets the lookup along the surface normal, which is what
	 * actually fixes self-shadowing on curved geometry; a constant bias large
	 * enough to do the same job detaches shadows from their casters instead.
	 * Leaving it at 0 gave blotchy dark patches on characters — they are only
	 * ~18 texels tall, so almost every curved surface self-shadowed.
	 */
	function applyShadowBias() {
		const texel = (shadowExtent * 2) / keyLight.shadow.mapSize.x;
		keyLight.shadow.normalBias = texel * 1.8;
		keyLight.shadow.bias = -0.00008;
		keyLight.shadow.radius = 8; // Soften shadow edges to prevent bloom popping
	}
	applyShadowBias();

	const skyMat = createSkyMaterial();
	const sky = new THREE.Mesh(new THREE.SphereGeometry(480, 48, 24), skyMat);
	sky.name = "sky-dome";
	sky.frustumCulled = false;
	sky.renderOrder = -10;
	// The dome is only 480 units across, so leaving it at the world origin makes
	// the sky slide as the player walks — obvious once clouds give it detail.
	// Re-centring per draw also keeps water reflections correct, since the
	// mirrored camera gets its own dome position.
	sky.onBeforeRender = (_renderer, _scene, camera) => {
		sky.position.copy(camera.position);
		sky.updateMatrixWorld(true);
	};

	// No separate sun/moon meshes — the sky shader draws a single disc (avoids double sun)
	group.add(ambient, hemisphere, keyLight, keyLight.target, sky);
	scene.add(group);

	for (const light of [ambient, hemisphere, keyLight]) {
		light.layers.enable(0);
		light.layers.enable(1);
	}

	const sample: Sampled = {
		zenith: new THREE.Color(),
		horizon: new THREE.Color(),
		fog: new THREE.Color(),
		fogDensity: 0.004,
		ambient: new THREE.Color(),
		ambientIntensity: 0.5,
		hemiSky: new THREE.Color(),
		hemiGround: new THREE.Color(),
		hemiIntensity: 0.35,
		sun: new THREE.Color(),
		sunIntensity: 2,
		sunGlow: 1,
		moon: new THREE.Color(),
		moonIntensity: 0,
		fireflies: 0,
		grassLight: 1,
		exposure: 1,
		shoulder: 0.72,
		contrast: 1.1,
		saturation: 1.25,
		shadowTint: new THREE.Color(),
		highlightTint: new THREE.Color(),
		bloomStrength: 0.4,
		bloomThreshold: 0.75,
		liftColor: new THREE.Color(),
		lift: 0,
		rimColor: new THREE.Color(),
		rimStrength: 0.7,
		charShadowTint: new THREE.Color(),
		grassAmbient: new THREE.Color(),
		grassShadowTint: new THREE.Color(),
		cloudCoverage: 0.45,
		cloudOpacity: 0.85,
		cloudLight: new THREE.Color(),
		cloudDark: new THREE.Color(),
	};

	const grade: GradeParams = {
		exposure: 1,
		shoulder: 4,
		contrast: 1.1,
		saturation: 1.25,
		shadowTint: new THREE.Color(1, 1, 1),
		highlightTint: new THREE.Color(1, 1, 1),
		liftColor: new THREE.Color(0x2f4f96),
		lift: 0,
		bloomStrength: 0.4,
		bloomThreshold: 0.75,
	};

	const charLight: CharacterLightParams = {
		rimColor: new THREE.Color(1, 1, 1),
		rimStrength: 0.7,
		shadowTint: new THREE.Color(1, 1, 1),
	};

	const grassLightParams: GrassLightParams = {
		keyColor: new THREE.Color(1, 1, 1),
		intensity: 1,
		ambient: new THREE.Color(),
		shadowTint: new THREE.Color(1, 1, 1),
	};

	const sunDir = new THREE.Vector3();
	const moonDir = new THREE.Vector3();
	/** Point the shadow frustum is centred on — tracks the player. */
	const focus = new THREE.Vector3();
	const ORBIT = 260;

	let hour = DAY_PERIODS.morning.hour;
	let auto = true;
	let speed = 0.00833; // 48 real-life minutes for 1 in-game day (like GTA 5)
	let period: DayPeriod = "morning";
	let fireflyIntensity = 0;
	let grassLight = 1;
	/** Wall-clock seconds driving cloud drift. */
	let skyTime = 0;

	function nearestPeriod(h: number): DayPeriod {
		let best: DayPeriod = "morning";
		let bestDist = Infinity;
		for (const id of PERIOD_ORDER) {
			const ph = DAY_PERIODS[id].hour;
			let d = Math.abs(h - ph);
			d = Math.min(d, 24 - d);
			if (d < bestDist) {
				bestDist = d;
				best = id;
			}
		}
		return best;
	}

	let overrideColors = false;
	/**
	 * Global multiplier on ambient + hemisphere. The single most useful knob for
	 * this rig: raising it flattens the image, lowering it deepens shadows.
	 */
	let fillScale = 1;
	/** Whether the key light is currently the sun (vs the moon). */
	let keyIsSun = true;

	const _up = new THREE.Vector3(0, 1, 0);
	const _right = new THREE.Vector3();
	const _camUp = new THREE.Vector3();
	const _snapped = new THREE.Vector3();

	/**
	 * Place the key light and its shadow frustum, quantised to the shadow map's
	 * texel grid.
	 *
	 * The grid is aligned to the *light's* view basis, not to world axes, so
	 * rounding the focus in world XZ (as this used to) does not land on texel
	 * boundaries at all — it just moves the whole map in jumps, leaving every
	 * shadow edge crawling as the player drives. Projecting the focus onto the
	 * light's own basis and rounding there is what actually stabilises it.
	 */
	function positionKeyLight() {
		const dir = keyIsSun ? sunDir : moonDir;
		const texel = (shadowExtent * 2) / keyLight.shadow.mapSize.x;

		_right.crossVectors(_up, dir);
		// Degenerate when the light is straight overhead.
		if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
		_right.normalize();
		_camUp.crossVectors(dir, _right).normalize();

		const a = Math.round(focus.dot(_right) / texel) * texel;
		const b = Math.round(focus.dot(_camUp) / texel) * texel;
		// The component along the light axis does not affect an ortho projection.
		const c = focus.dot(dir);

		_snapped
			.set(0, 0, 0)
			.addScaledVector(_right, a)
			.addScaledVector(_camUp, b)
			.addScaledVector(dir, c);

		keyLight.target.position.copy(_snapped);
		keyLight.position.copy(_snapped).addScaledVector(dir, ORBIT);
		keyLight.target.updateMatrixWorld();
	}

	function apply() {
		sampleAtHour(hour, sample);

		if (!overrideColors) {
			if (scene.background instanceof THREE.Color) {
				scene.background.copy(sample.zenith);
			} else {
				scene.background = sample.zenith.clone();
			}
			if (scene.fog instanceof THREE.FogExp2) {
				scene.fog.color.copy(sample.fog);
				scene.fog.density = sample.fogDensity;
			}
		}

		ambient.color.copy(sample.ambient);
		ambient.intensity = sample.ambientIntensity * fillScale;
		hemisphere.color.copy(sample.hemiSky);
		hemisphere.groundColor.copy(sample.hemiGround);
		hemisphere.intensity = sample.hemiIntensity * fillScale;

		hourToSunDirection(hour, sunDir);
		moonDir.copy(sunDir).multiplyScalar(-1);
		if (moonDir.y < 0.2) moonDir.y = 0.25;
		moonDir.normalize();

		const sunUp = sample.sunIntensity > 0.12 && sunDir.y > -0.02;
		keyIsSun = sunUp;
		if (sunUp) {
			keyLight.color.copy(sample.sun);
			const lowBoost = THREE.MathUtils.smoothstep(0.4, 0.05, sunDir.y);
			keyLight.intensity = sample.sunIntensity * (1 + lowBoost * 0.2);
			keyLight.castShadow = true;
		} else {
			keyLight.color.copy(sample.moon);
			keyLight.intensity = sample.moonIntensity;
			// Moonlight now casts too — a shadowless night reads flat and grey.
			keyLight.castShadow = sample.moonIntensity > 0.25;
		}
		// Anchor the frustum on the player, not the world origin, so the ±extent
		// ortho box travels with them instead of being stranded at (0,0,0).
		positionKeyLight();

		skyMat.uniforms.uSunDir.value.copy(sunDir);
		skyMat.uniforms.uMoonDir.value.copy(moonDir);
		skyMat.uniforms.uZenith.value.copy(sample.zenith);
		skyMat.uniforms.uHorizon.value.copy(sample.horizon);
		skyMat.uniforms.uSunColor.value.copy(sample.sun);
		skyMat.uniforms.uMoonColor.value.copy(sample.moon);
		skyMat.uniforms.uSunGlow.value = sample.sunGlow;
		skyMat.uniforms.uSunIntensity.value = sample.sunIntensity;
		skyMat.uniforms.uMoonIntensity.value = sample.moonIntensity;
		skyMat.uniforms.uCloudCoverage.value = sample.cloudCoverage;
		skyMat.uniforms.uCloudOpacity.value = sample.cloudOpacity;
		skyMat.uniforms.uCloudLight.value.copy(sample.cloudLight);
		skyMat.uniforms.uCloudDark.value.copy(sample.cloudDark);

		fireflyIntensity = sample.fireflies;
		grassLight = sample.grassLight;

		grade.exposure = sample.exposure;
		grade.shoulder = sample.shoulder;
		grade.contrast = sample.contrast;
		grade.saturation = sample.saturation;
		grade.shadowTint.copy(sample.shadowTint);
		grade.highlightTint.copy(sample.highlightTint);
		grade.liftColor.copy(sample.liftColor);
		grade.lift = sample.lift;
		grade.bloomStrength = sample.bloomStrength;
		grade.bloomThreshold = sample.bloomThreshold;

		charLight.rimColor.copy(sample.rimColor);
		charLight.rimStrength = sample.rimStrength;
		charLight.shadowTint.copy(sample.charShadowTint);

		// Grass shades itself, so hand it the key colour explicitly.
		grassLightParams.keyColor.copy(sunUp ? sample.sun : sample.moon);
		grassLightParams.intensity = sample.grassLight;
		grassLightParams.ambient.copy(sample.grassAmbient);
		grassLightParams.shadowTint.copy(sample.grassShadowTint);

		period = nearestPeriod(hour);
	}

	apply();

	return {
		group,
		lights: { ambient, hemisphere, keyLight },
		get hour() {
			return hour;
		},
		set hour(v: number) {
			hour = ((v % 24) + 24) % 24;
			apply();
		},
		get overrideColors() {
			return overrideColors;
		},
		set overrideColors(v: boolean) {
			overrideColors = v;
		},
		get fillScale() {
			return fillScale;
		},
		set fillScale(v: number) {
			fillScale = Math.max(0, v);
			apply();
		},
		get auto() {
			return auto;
		},
		set auto(v: boolean) {
			auto = v;
		},
		get speed() {
			return speed;
		},
		set speed(v: number) {
			speed = v;
		},
		get period() {
			return period;
		},
		setPeriod(next) {
			hour = DAY_PERIODS[next].hour;
			period = next;
			auto = false;
			apply();
		},
		setHour(next) {
			hour = ((next % 24) + 24) % 24;
			apply();
		},
		update(dt) {
			// Cloud drift runs off wall-clock time, not the day/night hour, so
			// clouds keep moving even when the cycle is paused.
			skyTime += dt;
			skyMat.uniforms.uTime.value = skyTime;
			if (auto) {
				hour = (hour + speed * dt) % 24;
				apply();
			}
			return fireflyIntensity;
		},
		getFireflyIntensity: () => fireflyIntensity,
		getGrassLight: () => grassLight,
		getFogColor: () => sample.fog,
		getFogDensity: () => sample.fogDensity,
		getSunDirection: () => sunDir,
		getGrade: () => grade,
		getCharacterLight: () => charLight,
		getGrassLightParams: () => grassLightParams,
		setFocus(x, z) {
			// Store the raw position — quantisation happens in light space inside
			// positionKeyLight, which is the only place it can be done correctly.
			if (x === focus.x && z === focus.z) return;
			focus.set(x, 0, z);
			// Only the light needs moving; the colour sample is unchanged.
			positionKeyLight();
		},
		setShadowQuality(mapSize, extent) {
			const size = Math.max(512, Math.min(8192, Math.floor(mapSize)));
			const next = Math.max(20, extent);
			if (size === keyLight.shadow.mapSize.x && next === shadowExtent) return;
			shadowExtent = next;
			keyLight.shadow.mapSize.set(size, size);
			keyLight.shadow.camera.left = -shadowExtent;
			keyLight.shadow.camera.right = shadowExtent;
			keyLight.shadow.camera.top = shadowExtent;
			keyLight.shadow.camera.bottom = -shadowExtent;
			keyLight.shadow.camera.updateProjectionMatrix();
			// Texel size changed, so the bias has to be rescaled with it.
			applyShadowBias();
			// mapSize only takes effect on a fresh target.
			if (keyLight.shadow.map) {
				keyLight.shadow.map.dispose();
				keyLight.shadow.map = null as unknown as THREE.WebGLRenderTarget;
			}
			positionKeyLight();
		},
		dispose() {
			group.removeFromParent();
			sky.geometry.dispose();
			skyMat.dispose();
		},
	};
}
