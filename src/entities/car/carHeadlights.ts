import * as THREE from "three";

/** Layer for car meshes — headlights do NOT share this, so they won't light the car. */
export const CAR_LAYER = 1;
/** Default world layer (grass, terrain, fireflies) that headlights illuminate. */
export const WORLD_LAYER = 0;

/** Kenney colormap UV of the yellow circular headlamps (not the white bumper dots). */
const HEADLIGHT_UV = { u: 0.21875, vMin: 0.02, vMax: 0.28, uTol: 0.035 };

export type HeadlightConfig = {
	/** Fine-tune from auto-detected lamp positions. */
	x: number;
	y: number;
	z: number;
	aimDistance: number;
	aimY: number;
	/** Tiny nudge ahead of the lens so the cone clears the bumper mesh. */
	forwardBias: number;
	spotIntensity: number;
	showMarkers: boolean;
};

export const DEFAULT_HEADLIGHT_CONFIG: HeadlightConfig = {
	// Approx after Kenney scale 1.6 — replaced at runtime by yellow-lamp detection
	x: 0.66,
	y: 1.04,
	z: 2.0,
	aimDistance: 14,
	aimY: -0.5,
	forwardBias: 0.05,
	spotIntensity: 16,
	showMarkers: false,
};

export type CarHeadlights = {
	group: THREE.Group;
	config: HeadlightConfig;
	setIntensity: (amount: number) => void;
	applyConfig: (partial?: Partial<HeadlightConfig>) => void;
	getConfig: () => HeadlightConfig;
	dispose: () => void;
};

/**
 * Locate the two yellow circular headlamps on the Kenney grille
 * (colormap UV ~0.22 — not the white bumper lights).
 */
export function findKenneyHeadlightLocals(
	carRoot: THREE.Object3D
): { left: THREE.Vector3; right: THREE.Vector3 } | null {
	carRoot.updateMatrixWorld(true);
	const invRoot = new THREE.Matrix4().copy(carRoot.matrixWorld).invert();
	const left: THREE.Vector3[] = [];
	const right: THREE.Vector3[] = [];
	const local = new THREE.Vector3();

	carRoot.traverse((child) => {
		if (!(child instanceof THREE.Mesh)) return;
		if (child.name.toLowerCase().includes("wheel")) return;

		const posAttr = child.geometry.getAttribute("position");
		const uvAttr = child.geometry.getAttribute("uv");
		if (!posAttr || !uvAttr) return;

		for (let i = 0; i < posAttr.count; i++) {
			const u = uvAttr.getX(i);
			const v = uvAttr.getY(i);
			// Yellow headlamp disc on Kenney atlas
			if (Math.abs(u - HEADLIGHT_UV.u) > HEADLIGHT_UV.uTol) continue;
			if (v < HEADLIGHT_UV.vMin || v > HEADLIGHT_UV.vMax) continue;

			local
				.fromBufferAttribute(posAttr, i)
				.applyMatrix4(child.matrixWorld)
				.applyMatrix4(invRoot);

			(local.x < 0 ? left : right).push(local.clone());
		}
	});

	if (!left.length || !right.length) return null;

	const avg = (pts: THREE.Vector3[]) => {
		const out = new THREE.Vector3();
		for (const p of pts) out.add(p);
		return out.multiplyScalar(1 / pts.length);
	};

	// Keep only the forward-most cluster (grille lamps, not rear yellow markers)
	const keepFront = (pts: THREE.Vector3[]) => {
		let maxZ = -Infinity;
		for (const p of pts) maxZ = Math.max(maxZ, p.z);
		return pts.filter((p) => p.z > maxZ - 0.4);
	};

	const L = keepFront(left);
	const R = keepFront(right);
	if (!L.length || !R.length) return null;

	return { left: avg(L), right: avg(R) };
}

/**
 * Spot beams from the Kenney yellow headlamps onto grass only (WORLD_LAYER).
 * Glowing lenses sit on the yellow circles so light clearly starts there.
 */
export function createCarHeadlights(
	carMesh: THREE.Object3D,
	_scale = 1,
	initial?: Partial<HeadlightConfig>
): CarHeadlights {
	const group = new THREE.Group();
	group.name = "car-headlights";

	const detected = findKenneyHeadlightLocals(carMesh);
	const fromModel: Partial<HeadlightConfig> = detected
		? {
				x: Math.abs(detected.right.x),
				y: (detected.left.y + detected.right.y) * 0.5,
				z: (detected.left.z + detected.right.z) * 0.5,
			}
		: {};

	const config: HeadlightConfig = {
		...DEFAULT_HEADLIGHT_CONFIG,
		...fromModel,
		...initial,
		// Always prefer real yellow-lamp seats when detection succeeds
		...fromModel,
	};

	const spots: THREE.SpotLight[] = [];
	const lenses: THREE.Mesh[] = [];
	const markers: THREE.Mesh[] = [];

	const lensMat = new THREE.MeshBasicMaterial({
		color: "#ffc61c",
		transparent: true,
		opacity: 0,
		depthWrite: false,
	});
	const markerMat = new THREE.MeshBasicMaterial({
		color: "#ffdd44",
		depthTest: false,
	});

	for (let i = 0; i < 2; i++) {
		const spot = new THREE.SpotLight(
			0xffe0a0,
			0,
			24,
			Math.PI / 3.2,
			0.8,
			1.7
		);
		spot.castShadow = false;
		spot.layers.set(WORLD_LAYER);
		spot.target.layers.set(WORLD_LAYER);

		// Soft glowing disc over the yellow headlamp
		const lens = new THREE.Mesh(
			new THREE.CircleGeometry(0.17, 24),
			lensMat.clone()
		);
		lens.renderOrder = 8;
		lens.layers.set(CAR_LAYER);

		const marker = new THREE.Mesh(
			new THREE.SphereGeometry(0.08, 10, 10),
			markerMat.clone()
		);
		marker.renderOrder = 10;
		marker.layers.enable(CAR_LAYER);
		marker.layers.enable(WORLD_LAYER);

		group.add(spot);
		group.add(spot.target);
		group.add(lens);
		group.add(marker);

		spots.push(spot);
		lenses.push(lens);
		markers.push(marker);
	}

	let dimmer = 0;

	function layout() {
		spots.forEach((spot, i) => {
			const side = i === 0 ? -1 : 1;
			const x = side * config.x;
			const y = config.y;
			const z = config.z;

			// Lens sits on the yellow headlamp paint
			lenses[i].position.set(x, y, z + 0.02);
			lenses[i].lookAt(x, y, z + 1);

			const beamZ = z + config.forwardBias;
			spot.position.set(x, y, beamZ);
			spot.target.position.set(
				x * 0.1,
				y + config.aimY,
				beamZ + config.aimDistance
			);
			spot.target.updateMatrixWorld(true);

			markers[i].position.set(x, y, z);
			markers[i].visible = config.showMarkers;
		});
	}

	function refreshIntensity() {
		const a = THREE.MathUtils.clamp(dimmer, 0, 1);
		for (const spot of spots) {
			spot.intensity = a * config.spotIntensity;
		}
		for (const lens of lenses) {
			const mat = lens.material as THREE.MeshBasicMaterial;
			mat.opacity = a * 0.95;
			lens.visible = a > 0.02;
		}
		group.visible = a > 0.02 || config.showMarkers;
		for (const marker of markers) {
			marker.visible = config.showMarkers;
		}
	}

	layout();

	if (detected) {
		console.log("[Headlights] seated on yellow Kenney headlamps", {
			left: detected.left.toArray(),
			right: detected.right.toArray(),
			config: { ...config },
		});
	} else {
		console.warn("[Headlights] could not detect lamp UVs — using defaults");
	}

	return {
		group,
		config,
		setIntensity(amount: number) {
			dimmer = amount;
			refreshIntensity();
		},
		applyConfig(partial) {
			Object.assign(config, partial);
			layout();
			refreshIntensity();
		},
		getConfig() {
			return { ...config };
		},
		dispose() {
			group.removeFromParent();
			for (const spot of spots) spot.dispose();
			for (const lens of lenses) {
				lens.geometry.dispose();
				(lens.material as THREE.Material).dispose();
			}
			for (const marker of markers) {
				marker.geometry.dispose();
				(marker.material as THREE.Material).dispose();
			}
			lensMat.dispose();
			markerMat.dispose();
		},
	};
}

/** Put car body/wheels on CAR_LAYER so headlights don't light them. */
export function assignCarLightingLayer(root: THREE.Object3D) {
	root.traverse((child) => {
		child.layers.set(CAR_LAYER);
	});
}

/** Moon / sun / ambient must light both world and car. */
export function enableLightOnCarAndWorld(light: THREE.Light) {
	light.layers.enable(WORLD_LAYER);
	light.layers.enable(CAR_LAYER);
}
