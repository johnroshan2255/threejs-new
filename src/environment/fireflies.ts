import * as THREE from "three";
import { getWorldTerrainY } from "../terrain/islandHeight";
import { TERRAIN_CONFIG } from "../terrain/createLargeTerrain";

export type Fireflies = {
	points: THREE.Points;
	update: (
		dt: number,
		intensity: number,
		lightThreat?: FireflyLightThreat | null
	) => void;
	dispose: () => void;
};

/** Car headlights — fireflies slowly drift out of the lit cone. */
export type FireflyLightThreat = {
	position: THREE.Vector3;
	/** Unit vector, visual front of the car. */
	forward: THREE.Vector3;
	/** 0–1 headlight strength. */
	intensity: number;
	range?: number;
	halfAngle?: number;
};

/** Flat grass-level swarm. */
export type GrassFireflyAnchor = {
	kind: "grass";
	x: number;
	z: number;
	spread?: number;
	heightMin?: number;
	heightMax?: number;
	weight?: number;
};

/** 3D volume — typically the tree foliage AABB. */
export type VolumeFireflyAnchor = {
	kind: "volume";
	box: THREE.Box3;
	pad?: number;
	weight?: number;
};

export type FireflyAnchor = GrassFireflyAnchor | VolumeFireflyAnchor;

export type FirefliesOptions = {
	count?: number;
	anchors?: FireflyAnchor[];
};

type Firefly = {
	/** Resting home — slowly returns here when dark again. */
	homeX: number;
	homeY: number;
	homeZ: number;
	/** Current drift center (moves slowly away from headlights). */
	cx: number;
	cy: number;
	cz: number;
	phase: number;
	speed: number;
	rx: number;
	ry: number;
	rz: number;
	fx: number;
	fy: number;
	fz: number;
	sizeBoost: number;
	shy: number;
};

function makeSoftGlowTexture(): THREE.Texture {
	const size = 64;
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	const g = ctx.createRadialGradient(
		size / 2,
		size / 2,
		0,
		size / 2,
		size / 2,
		size / 2
	);
	g.addColorStop(0, "rgba(255,255,200,1)");
	g.addColorStop(0.25, "rgba(220,255,120,0.85)");
	g.addColorStop(0.55, "rgba(180,255,80,0.25)");
	g.addColorStop(1, "rgba(0,0,0,0)");
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, size, size);

	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.needsUpdate = true;
	return tex;
}

function pickAnchor(anchors: FireflyAnchor[]): FireflyAnchor {
	const weights = anchors.map((a) => Math.max(0.01, a.weight ?? 1));
	const total = weights.reduce((s, w) => s + w, 0);
	let r = Math.random() * total;
	for (let i = 0; i < anchors.length; i++) {
		r -= weights[i];
		if (r <= 0) return anchors[i];
	}
	return anchors[anchors.length - 1];
}

function makeFirefly(
	cx: number,
	cy: number,
	cz: number,
	opts: Partial<Firefly>
): Firefly {
	return {
		homeX: cx,
		homeY: cy,
		homeZ: cz,
		cx,
		cy,
		cz,
		phase: Math.random() * Math.PI * 2,
		speed: 0.55 + Math.random() * 1.15,
		rx: 0.4 + Math.random() * 1.1,
		ry: 0.35 + Math.random() * 0.9,
		rz: 0.4 + Math.random() * 1.1,
		fx: 0.7 + Math.random() * 0.6,
		fy: 1.1 + Math.random() * 0.8,
		fz: 0.6 + Math.random() * 0.7,
		sizeBoost: 0,
		shy: 0.55 + Math.random() * 0.45,
		...opts,
	};
}

function spawnInGrass(anchor: GrassFireflyAnchor): Firefly {
	const spread = anchor.spread ?? 8;
	const ang = Math.random() * Math.PI * 2;
	const dist = Math.random() * spread;
	const x = anchor.x + Math.cos(ang) * dist;
	const z = anchor.z + Math.sin(ang) * dist;
	const ground = getWorldTerrainY(x, z);
	const hMin = anchor.heightMin ?? 0.35;
	const hMax = anchor.heightMax ?? 2.6;
	const cy = ground + hMin + Math.random() * (hMax - hMin);
	return makeFirefly(x, cy, z, {});
}

function spawnInVolume(anchor: VolumeFireflyAnchor): Firefly {
	const pad = anchor.pad ?? 0.6;
	const min = anchor.box.min.clone().addScalar(-pad * 0.15);
	const max = anchor.box.max.clone().addScalar(pad);
	const t = Math.pow(Math.random(), 0.65);
	const cx = THREE.MathUtils.lerp(min.x, max.x, Math.random());
	const cy = THREE.MathUtils.lerp(
		THREE.MathUtils.lerp(min.y, max.y, 0.35),
		max.y,
		t
	);
	const cz = THREE.MathUtils.lerp(min.z, max.z, Math.random());

	const spanX = Math.max(0.8, (max.x - min.x) * 0.35);
	const spanY = Math.max(0.8, (max.y - min.y) * 0.4);
	const spanZ = Math.max(0.8, (max.z - min.z) * 0.35);

	return makeFirefly(cx, cy, cz, {
		speed: 0.35 + Math.random() * 0.85,
		rx: spanX * (0.35 + Math.random() * 0.55),
		ry: spanY * (0.3 + Math.random() * 0.5),
		rz: spanZ * (0.35 + Math.random() * 0.55),
		fx: 0.45 + Math.random() * 0.55,
		fy: 0.55 + Math.random() * 0.7,
		fz: 0.4 + Math.random() * 0.6,
		sizeBoost: 0.08 + Math.random() * 0.1,
	});
}

const _toFly = new THREE.Vector3();
const _flee = new THREE.Vector3();
const _side = new THREE.Vector3();
const _fwdFlat = new THREE.Vector3();

/**
 * Soft fireflies: grass + canopy, slowly drift out of headlight beams.
 */
export function createFireflies(options: FirefliesOptions = {}): Fireflies {
	const count = options.count ?? 220;
	const hill = TERRAIN_CONFIG.mainHill;
	const anchors: FireflyAnchor[] =
		options.anchors ??
		([
			{
				kind: "grass",
				x: hill.x,
				z: hill.z,
				spread: 12,
				weight: 1,
			},
			{ kind: "grass", x: 0, z: 0, spread: 14, weight: 1 },
		] satisfies FireflyAnchor[]);

	const fireflies: Firefly[] = [];
	const positions = new Float32Array(count * 3);
	const glowTex = makeSoftGlowTexture();

	for (let i = 0; i < count; i++) {
		const anchor = pickAnchor(anchors);
		const f =
			anchor.kind === "volume" ? spawnInVolume(anchor) : spawnInGrass(anchor);
		fireflies.push(f);
		positions[i * 3] = f.cx;
		positions[i * 3 + 1] = f.cy;
		positions[i * 3 + 2] = f.cz;
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

	const material = new THREE.PointsMaterial({
		map: glowTex,
		size: 0.35,
		color: new THREE.Color("#d8ff66"),
		transparent: true,
		opacity: 0,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		sizeAttenuation: true,
		alphaTest: 0.01,
	});

	const points = new THREE.Points(geometry, material);
	points.name = "fireflies";
	points.frustumCulled = false;
	points.renderOrder = 2;

	let time = 0;
	const avgBoost =
		fireflies.reduce((s, f) => s + f.sizeBoost, 0) / Math.max(1, fireflies.length);

	return {
		points,
		update(dt, intensity, lightThreat = null) {
			time += dt;
			const visible = intensity > 0.05;
			points.visible = visible;
			if (!visible) {
				material.opacity = 0;
				return;
			}

			material.size = 0.2 + intensity * 0.14 + avgBoost * 0.5;
			material.opacity = THREE.MathUtils.clamp(intensity * 0.85, 0, 0.95);

			const threatOn =
				!!lightThreat &&
				lightThreat.intensity > 0.08 &&
				lightThreat.forward.lengthSq() > 0.01;

			const range = lightThreat?.range ?? 20;
			const halfAngle = lightThreat?.halfAngle ?? 0.7;
			const cosCone = Math.cos(halfAngle);
			const headI = lightThreat?.intensity ?? 0;

			const pos = geometry.attributes.position as THREE.BufferAttribute;
			for (let i = 0; i < fireflies.length; i++) {
				const f = fireflies[i];

				// Gentle weave around the (possibly drifting) center
				const t = time * f.speed + f.phase;
				let x =
					f.cx +
					Math.sin(t * f.fx) * f.rx +
					Math.sin(t * 0.31 + f.phase) * f.rx * 0.35;
				let y =
					f.cy +
					Math.sin(t * f.fy) * f.ry +
					Math.cos(t * 0.47 + f.phase) * f.ry * 0.4;
				let z =
					f.cz +
					Math.cos(t * f.fz) * f.rz +
					Math.sin(t * 0.39 + f.phase * 1.7) * f.rz * 0.35;

				if (threatOn && lightThreat) {
					_toFly.set(x, y, z).sub(lightThreat.position);
					const dist = _toFly.length();

					if (dist > 0.2 && dist < range + 4) {
						_toFly.multiplyScalar(1 / dist);
						_fwdFlat
							.copy(lightThreat.forward)
							.setY(0)
							.normalize();

						const ahead = _toFly.dot(lightThreat.forward);
						const aheadFlat = _toFly.x * _fwdFlat.x + _toFly.z * _fwdFlat.z;

						// How strongly this bug is inside the headlight cone / near the car
						const inCone = THREE.MathUtils.smoothstep(
							ahead,
							cosCone - 0.15,
							cosCone + 0.25
						);
						const nearCar = THREE.MathUtils.smoothstep(6.5, 1.2, dist);
						const rangeFalloff = 1 - THREE.MathUtils.smoothstep(range * 0.55, range, dist);
						const lit = Math.max(inCone * rangeFalloff, nearCar * 0.55) * headI;

						if (lit > 0.04) {
							// Flee sideways out of the beam, plus a little back/away from the car
							_side.set(-_fwdFlat.z, 0, _fwdFlat.x);
							const sideSign =
								_toFly.x * _side.x + _toFly.z * _side.z >= 0 ? 1 : -1;

							_flee
								.set(0, 0, 0)
								.addScaledVector(_side, sideSign * 1.1)
								.addScaledVector(_fwdFlat, aheadFlat > 0.15 ? -0.35 : 0.55)
								.addScaledVector(_toFly, 0.45);
							_flee.y = f.sizeBoost > 0 ? 0.15 : 0.05;
							if (_flee.lengthSq() > 1e-6) _flee.normalize();

							// Slow real-life drift (~0.4–1.1 m/s when fully lit)
							const fleeSpeed = (0.35 + 0.75 * lit) * f.shy;
							f.cx += _flee.x * fleeSpeed * dt;
							f.cy += _flee.y * fleeSpeed * dt * 0.35;
							f.cz += _flee.z * fleeSpeed * dt;

							// Soft cap how far they abandon their home patch
							const dx = f.cx - f.homeX;
							const dz = f.cz - f.homeZ;
							const fled = Math.hypot(dx, dz);
							const maxFlee = 7.5;
							if (fled > maxFlee) {
								const pull = (fled - maxFlee) / fled;
								f.cx -= dx * pull * 0.4;
								f.cz -= dz * pull * 0.4;
							}
						}
					}
				} else {
					// Creep back home when the light leaves
					const returnRate = 1 - Math.exp(-dt * 0.22);
					f.cx += (f.homeX - f.cx) * returnRate;
					f.cy += (f.homeY - f.cy) * returnRate;
					f.cz += (f.homeZ - f.cz) * returnRate;
				}

				// Recompute weave after center drift
				x =
					f.cx +
					Math.sin(t * f.fx) * f.rx +
					Math.sin(t * 0.31 + f.phase) * f.rx * 0.35;
				y =
					f.cy +
					Math.sin(t * f.fy) * f.ry +
					Math.cos(t * 0.47 + f.phase) * f.ry * 0.4;
				z =
					f.cz +
					Math.cos(t * f.fz) * f.rz +
					Math.sin(t * 0.39 + f.phase * 1.7) * f.rz * 0.35;

				pos.setXYZ(i, x, y, z);
			}
			pos.needsUpdate = true;

			material.opacity *= 0.72 + 0.28 * Math.sin(time * 2.1);
		},
		dispose() {
			points.removeFromParent();
			geometry.dispose();
			material.dispose();
			glowTex.dispose();
		},
	};
}
