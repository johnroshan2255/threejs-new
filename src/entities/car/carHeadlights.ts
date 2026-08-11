import * as THREE from "three";

/** Layer for car meshes — headlights do NOT share this, so they won't light the car. */
export const CAR_LAYER = 1;
/** Default world layer (grass, terrain, fireflies) that headlights illuminate. */
export const WORLD_LAYER = 0;


export type CarLightConfig = {
	color: number | string;
	lensColor: string;
	markerColor: string;
	lensSize: number;
	spotIntensity: number;
	distance: number;
	angle: number;
	forwardBias: number;
	isTaillight?: boolean;
	mounts?: {
		left: { x: number; y: number; z: number };
		right: { x: number; y: number; z: number };
	};
	showMarkers?: boolean;
	hideLens?: boolean;
};

export const DEFAULT_HEADLIGHT_CONFIG: Partial<CarLightConfig> = {
	showMarkers: false,
};

export type CarLightPair = {
	group: THREE.Group;
	config: CarLightConfig;
	setIntensity: (amount: number) => void;
	applyConfig: (partial?: Partial<CarLightConfig>) => void;
	getConfig: () => CarLightConfig;
	dispose: () => void;
};


/**
 * Spot beams from the Kenney yellow headlamps onto grass only (WORLD_LAYER).
 * Glowing lenses sit on the yellow circles so light clearly starts there.
 */
export function createCarLightPair(
	carMesh: THREE.Object3D,
	initial?: Partial<CarLightConfig>
): CarLightPair {
	const group = new THREE.Group();
	group.name = initial?.isTaillight ? "car-taillights" : "car-headlights";

	const mounts = initial?.mounts || {
		left: { x: -0.66, y: 1.04, z: 2.0 },
		right: { x: 0.66, y: 1.04, z: 2.0 }
	};

	const config: CarLightConfig = {
		color: 0xffe0a0,
		lensColor: "#ffc61c",
		markerColor: "#ffdd44",
		lensSize: 0.17,
		spotIntensity: 16,
		distance: 24,
		angle: Math.PI / 3.2,
		forwardBias: 0.05,
		mounts,
		...DEFAULT_HEADLIGHT_CONFIG,
		...initial,
	};

	const spots: THREE.SpotLight[] = [];
	const lenses: THREE.Mesh[] = [];
	const markers: THREE.Mesh[] = [];

	const lensMat = new THREE.MeshBasicMaterial({
		color: config.lensColor,
		transparent: true,
		opacity: 0,
		depthWrite: false,
	});
	const markerMat = new THREE.MeshBasicMaterial({
		color: config.markerColor,
		depthTest: false,
	});

	for (let i = 0; i < 2; i++) {
		const spot = new THREE.SpotLight(
			config.color,
			0,
			config.distance,
			config.angle,
			0.8,
			1.7
		);
		spot.castShadow = false;
		spot.layers.set(WORLD_LAYER);
		spot.target.layers.set(WORLD_LAYER);

		// Soft glowing disc over the lamp
		const lens = new THREE.Mesh(
			new THREE.CircleGeometry(config.lensSize, 24),
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
			const mount = i === 0 ? config.mounts!.left : config.mounts!.right;
			const x = mount.x;
			const y = mount.y;
			const z = mount.z;

			const forwardDir = config.isTaillight ? -1 : 1;

			// Lens sits slightly proud
			lenses[i].position.set(x, y, z + (0.02 * forwardDir));
			lenses[i].lookAt(x, y, z + (1 * forwardDir));

			const beamZ = z + config.forwardBias;
			spot.position.set(x, y, beamZ);
			spot.target.position.set(
				x * 0.1,
				y - 0.5, // aimY roughly -0.5
				beamZ + (14 * forwardDir)
			);
			spot.target.updateMatrixWorld(true);

			markers[i].position.set(x, y, z);
			markers[i].visible = !!config.showMarkers;
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
			lens.visible = config.hideLens ? false : (a > 0.02);
		}
		// The group deliberately stays visible even at zero intensity.
		//
		// Hiding it takes the two SpotLights out of the scene's light list, and a
		// changed light list forces every lit material in the world to rebuild its
		// node graph. On WebGPU that rebuild re-registers the instanced attribute
		// buffers for the grass and trees — ~49 MB that is not handed back — so
		// each dusk and dawn cost both a compile hitch and a step up in GPU memory.
		// Two spot lights at intensity 0 contribute nothing to the image and only a
		// few ALU ops per fragment, which is much the cheaper trade.
		//
		// Every child manages its own visibility above, so nothing is drawn that
		// should not be.
		group.visible = true;
		for (const marker of markers) {
			marker.visible = !!config.showMarkers;
		}
	}

	layout();



	return {
		group,
		config,
		setIntensity(amount: number) {
			dimmer = amount;
			refreshIntensity();
		},
		applyConfig(partial) {
			Object.assign(config, partial);
			if (partial?.color) {
				spots.forEach((s) => s.color.set(partial.color!));
			}
			if (partial?.lensColor) {
				lenses.forEach((l) => (l.material as THREE.MeshBasicMaterial).color.set(partial.lensColor!));
			}
			if (partial?.markerColor) {
				markers.forEach((m) => (m.material as THREE.MeshBasicMaterial).color.set(partial.markerColor!));
			}
			layout();
			refreshIntensity();
		},
		getConfig: () => config,
		dispose() {
			lensMat.dispose();
			markerMat.dispose();
			spots.forEach((s) => s.dispose());
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
