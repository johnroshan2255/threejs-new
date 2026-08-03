import * as THREE from "three";

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
};

export const DAY_PERIODS: Record<DayPeriod, PeriodKey> = {
	morning: {
		hour: 7,
		zenith: "#7eb0d8",
		horizon: "#e8d4b8",
		fog: "#d0dde8",
		fogDensity: 0.009,
		ambientColor: "#e0e0e0",
		ambientIntensity: 0.6, // boosted
		hemiSky: "#ffffff",
		hemiGround: "#888888",
		hemiIntensity: 0.6, // boosted
		sunColor: "#ffffff",
		sunIntensity: 1.0, // lowered
		sunGlow: 1.1,
		moonColor: "#ffffff",
		moonIntensity: 0,
		fireflies: 0,
		grassLight: 1.0,
	},
	noon: {
		hour: 12.5,
		zenith: "#4aa0e0",
		horizon: "#c8e4f5",
		fog: "#d8eef5",
		fogDensity: 0.007,
		ambientColor: "#ffffff",
		ambientIntensity: 0.7, // boosted
		hemiSky: "#ffffff",
		hemiGround: "#aaaaaa",
		hemiIntensity: 0.7, // boosted
		sunColor: "#ffffff",
		sunIntensity: 1.5, // lowered
		sunGlow: 0.55,
		moonColor: "#ffffff",
		moonIntensity: 0,
		fireflies: 0,
		grassLight: 1.15,
	},
	evening: {
		hour: 16.2,
		zenith: "#a8d0ea",
		horizon: "#e8f2f6",
		fog: "#e0eaf0",
		fogDensity: 0.007,
		ambientColor: "#e0e0e0",
		ambientIntensity: 0.65, // boosted
		hemiSky: "#ffffff",
		hemiGround: "#888888",
		hemiIntensity: 0.65, // boosted
		sunColor: "#ffffff",
		sunIntensity: 1.2, // lowered
		sunGlow: 0.25,
		moonColor: "#ffffff",
		moonIntensity: 0,
		fireflies: 0,
		grassLight: 1.12,
	},
	sunset: {
		hour: 17.85,
		zenith: "#7aa8c8",
		horizon: "#e8dcc8",
		fog: "#d8d0c0",
		fogDensity: 0.008,
		ambientColor: "#cccccc",
		ambientIntensity: 0.55, // boosted
		hemiSky: "#dddddd",
		hemiGround: "#666666",
		hemiIntensity: 0.55, // boosted
		sunColor: "#ffffff",
		sunIntensity: 0.8, // lowered
		sunGlow: 0.85,
		moonColor: "#ffffff",
		moonIntensity: 0,
		fireflies: 0.12,
		grassLight: 0.98,
	},
	night: {
		hour: 22.5,
		zenith: "#050814",
		horizon: "#0a1020",
		fog: "#070b16",
		fogDensity: 0.015,
		ambientColor: "#444444",
		ambientIntensity: 0.45, // boosted
		hemiSky: "#555555",
		hemiGround: "#222222",
		hemiIntensity: 0.45, // boosted
		sunColor: "#ffffff",
		sunIntensity: 0,
		sunGlow: 0,
		moonColor: "#ffffff",
		moonIntensity: 1.2, // adjusted
		fireflies: 1,
		grassLight: 0.7,
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
};

function hourToSunDirection(hour: number, out: THREE.Vector3): THREE.Vector3 {
	// 6 = sunrise horizon, 12 = zenith, 18 = sunset horizon
	const t = ((hour - 6) / 24) * Math.PI * 2;
	return out.set(Math.cos(t), Math.sin(t), Math.sin(t * 0.35) * 0.35).normalize();
}

function smoothstep(t: number) {
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

	const t = smoothstep(
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
	return out;
}

function createSkyMaterial() {
	return new THREE.ShaderMaterial({
		side: THREE.BackSide,
		depthWrite: false,
		fog: false,
		uniforms: {
			uSunDir: { value: new THREE.Vector3(0, 1, 0) },
			uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
			uZenith: { value: new THREE.Color("#4aa0e0") },
			uHorizon: { value: new THREE.Color("#c8e4f5") },
			uSunColor: { value: new THREE.Color("#fff5e0") },
			uMoonColor: { value: new THREE.Color("#c4d4ff") },
			uSunGlow: { value: 1 },
			uSunIntensity: { value: 1 },
			uMoonIntensity: { value: 0 },
		},
		vertexShader: /* glsl */ `
			varying vec3 vDir;
			void main() {
				vec4 world = modelMatrix * vec4(position, 1.0);
				vDir = normalize(world.xyz);
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: /* glsl */ `
			uniform vec3 uSunDir;
			uniform vec3 uMoonDir;
			uniform vec3 uZenith;
			uniform vec3 uHorizon;
			uniform vec3 uSunColor;
			uniform vec3 uMoonColor;
			uniform float uSunGlow;
			uniform float uSunIntensity;
			uniform float uMoonIntensity;
			varying vec3 vDir;

			void main() {
				vec3 dir = normalize(vDir);
				vec3 sun = normalize(uSunDir);
				vec3 moon = normalize(uMoonDir);

				float elev = dir.y;
				float hMix = smoothstep(-0.1, 0.7, elev);
				vec3 sky = mix(uHorizon, uZenith, hMix);

				float sunElev = sun.y;
				// Only kick in strong warm glow when the sun is near the horizon
				float lowSun = smoothstep(0.28, 0.02, sunElev);
				float sunDot = max(dot(dir, sun), 0.0);

				vec3 dirFlat = normalize(vec3(dir.x, 0.001, dir.z));
				vec3 sunFlat = normalize(vec3(sun.x, 0.001, sun.z));
				// Tight azimuth around the sun — stops a fire band across the sky
				float towardSun = pow(max(dot(dirFlat, sunFlat), 0.0), 8.0);
				float horizonArc = exp(-abs(elev - max(sunElev, 0.0)) * 16.0);
				float sunHalo = pow(sunDot, 32.0) * uSunGlow;
				float mie = pow(sunDot, 14.0) * uSunGlow * 0.18;
				float warm =
					(horizonArc * towardSun * 0.35 + sunHalo + mie) *
					lowSun *
					clamp(uSunGlow, 0.0, 2.0);
				sky += uSunColor * warm * 0.55;

				// Soft pale rim for evening (high sun) — tiny, not orange wash
				float dayGlow = pow(sunDot, 48.0) * uSunGlow * (1.0 - lowSun);
				sky += mix(uSunColor, vec3(1.0), 0.5) * dayGlow * 0.35;

				// Bright sun disc (single — no extra mesh orb)
				float disc = smoothstep(0.9994, 0.9999, sunDot) * step(-0.05, sunElev);
				sky += mix(uSunColor, vec3(1.0, 0.97, 0.9), 0.75) * disc * (1.8 + uSunGlow * 0.25);

				// Soft moon at night
				float moonDot = max(dot(dir, moon), 0.0);
				float moonDisc = smoothstep(0.9988, 0.9996, moonDot) * uMoonIntensity;
				sky += uMoonColor * moonDisc * 1.4;
				sky += uMoonColor * pow(moonDot, 40.0) * uMoonIntensity * 0.25;

				gl_FragColor = vec4(sky, 1.0);
			}
		`,
	});
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
	dispose: () => void;
	overrideColors: boolean;
};

/**
 * Sun + moon day/night cycle with a directional sky (warm glow near the sun).
 * Uses ONE directional key light (sun↔moon) so the grass custom shader stays stable.
 */
export function createDayNightCycle(
	scene: THREE.Scene,
	options: { shadowExtent?: number } = {}
): DayNightCycle {
	const shadowExtent = options.shadowExtent ?? 90;
	const group = new THREE.Group();
	group.name = "day-night";

	const ambient = new THREE.AmbientLight(0xffffff, 0.5);
	const hemisphere = new THREE.HemisphereLight(0x87ceeb, 0x3a4a20, 0.35);

	const keyLight = new THREE.DirectionalLight(0xfff5e0, 2);
	keyLight.castShadow = true;
	keyLight.shadow.camera.far = 500;
	keyLight.shadow.camera.left = -shadowExtent;
	keyLight.shadow.camera.right = shadowExtent;
	keyLight.shadow.camera.top = shadowExtent;
	keyLight.shadow.camera.bottom = -shadowExtent;
	keyLight.shadow.mapSize.set(2048, 2048);
	keyLight.shadow.bias = -0.0002;

	const skyMat = createSkyMaterial();
	const sky = new THREE.Mesh(new THREE.SphereGeometry(480, 48, 24), skyMat);
	sky.name = "sky-dome";
	sky.frustumCulled = false;
	sky.renderOrder = -10;

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
		fogDensity: 0.01,
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
	};

	const sunDir = new THREE.Vector3();
	const moonDir = new THREE.Vector3();
	const ORBIT = 260;

	let hour = DAY_PERIODS.morning.hour;
	let auto = true;
	let speed = 0.00833; // 48 real-life minutes for 1 in-game day (like GTA 5)
	let period: DayPeriod = "morning";
	let fireflyIntensity = 0;
	let grassLight = 1;

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
		ambient.intensity = sample.ambientIntensity;
		hemisphere.color.copy(sample.hemiSky);
		hemisphere.groundColor.copy(sample.hemiGround);
		hemisphere.intensity = sample.hemiIntensity;

		hourToSunDirection(hour, sunDir);
		moonDir.copy(sunDir).multiplyScalar(-1);
		if (moonDir.y < 0.2) moonDir.y = 0.25;
		moonDir.normalize();

		const sunUp = sample.sunIntensity > 0.12 && sunDir.y > -0.02;
		if (sunUp) {
			keyLight.position.copy(sunDir).multiplyScalar(ORBIT);
			keyLight.target.position.set(0, 0, 0);
			keyLight.color.copy(sample.sun);
			const lowBoost = THREE.MathUtils.smoothstep(0.4, 0.05, sunDir.y);
			keyLight.intensity = sample.sunIntensity * (1 + lowBoost * 0.2);
			keyLight.castShadow = true;
		} else {
			keyLight.position.copy(moonDir).multiplyScalar(ORBIT);
			keyLight.target.position.set(0, 0, 0);
			keyLight.color.copy(sample.moon);
			keyLight.intensity = sample.moonIntensity;
			keyLight.castShadow = false;
		}
		keyLight.target.updateMatrixWorld();

		skyMat.uniforms.uSunDir.value.copy(sunDir);
		skyMat.uniforms.uMoonDir.value.copy(moonDir);
		skyMat.uniforms.uZenith.value.copy(sample.zenith);
		skyMat.uniforms.uHorizon.value.copy(sample.horizon);
		skyMat.uniforms.uSunColor.value.copy(sample.sun);
		skyMat.uniforms.uMoonColor.value.copy(sample.moon);
		skyMat.uniforms.uSunGlow.value = sample.sunGlow;
		skyMat.uniforms.uSunIntensity.value = sample.sunIntensity;
		skyMat.uniforms.uMoonIntensity.value = sample.moonIntensity;

		fireflyIntensity = sample.fireflies;
		grassLight = sample.grassLight;
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
		dispose() {
			group.removeFromParent();
			sky.geometry.dispose();
			skyMat.dispose();
		},
	};
}
