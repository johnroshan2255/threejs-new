import * as THREE from "three";
import Stats from "stats-gl";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as dat from "dat.gui";

import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import { GrassMaterial } from "./GrassMaterial";
import { initPhysics, getWorld } from "./physics/world";
import { createTerrainHeightfieldCollider } from "./physics/terrainCollider";
import { setIslandTerrain } from "./terrain/islandHeight";
import { createLargeTerrain, TERRAIN_CONFIG } from "./terrain/createLargeTerrain";
import { createCar, type CarEntity } from "./entities/car/createCar";
import { CarController } from "./entities/car/carController";
import { CarInput } from "./entities/car/carInput";
import { resetCarUpright, respawnCarAtStart, isCarOutsideWorld } from "./entities/car/resetCar";
import { syncCar } from "./entities/car/syncCar";
import {
	createCarHeadlights,
	assignCarLightingLayer,
	type CarHeadlights,
} from "./entities/car/carHeadlights";
import { CAR_CONFIG } from "./entities/car/carConfig";
import { updateChaseCamera } from "./three/chaseCamera";
import { ChaseCameraInput } from "./three/chaseCameraInput";
import {
	createTree,
	updateFoliageWind,
	type TreeHandle,
} from "./entities/tree";
import {
	createDayNightCycle,
	type DayNightCycle,
	type DayPeriod,
} from "./environment/dayNightCycle";
import { createFireflies, type Fireflies } from "./environment/fireflies";

export class FluffyGrass {
	private loadingManager: THREE.LoadingManager;
	private textureLoader: THREE.TextureLoader;
	private gltfLoader: GLTFLoader;

	private camera: THREE.PerspectiveCamera;
	private renderer: THREE.WebGLRenderer;
	private scene: THREE.Scene;
	private canvas: HTMLCanvasElement;
	private stats: Stats;
	private gui: dat.GUI;
	private sceneGUI: dat.GUI;
	private sceneProps = {
		fogColor: "#eeeeee",
		terrainColor: "#5e875e",
		fogDensity: 0.012,
	};
	private textures: { [key: string]: THREE.Texture } = {};

	Uniforms = {
		uTime: { value: 0 },
		color: { value: new THREE.Color("#0000ff") },
	};
	private clock = new THREE.Clock();

	private terrainMat: THREE.MeshPhongMaterial;
	private grassGeometry = new THREE.BufferGeometry();
	private grassMaterial: GrassMaterial;
	private grassCount = 30000;

	private car: CarEntity | null = null;
	private carInput: CarInput | null = null;
	private carController: CarController | null = null;
	private chaseCameraInput: ChaseCameraInput | null = null;
	private trees: TreeHandle[] = [];
	private dayNight: DayNightCycle | null = null;
	private fireflies: Fireflies | null = null;
	private carHeadlights: CarHeadlights | null = null;
	private dayNightGui = {
		period: "morning" as DayPeriod,
		auto: true,
		speed: 0.08, // ~5 min full cycle
		hour: 7,
	};
	private lastFrameTime = performance.now();
	private frameFireflyIntensity = 0;
	private frameHeadAmount = 0;
	/** Accumulated time spent outside the world before respawn (seconds). */
	private outOfWorldTimer = 0;
	private readonly _fireflyCarPos = new THREE.Vector3();
	private readonly _fireflyCarFwd = new THREE.Vector3();
	private readonly _fireflyCarQuat = new THREE.Quaternion();

	constructor(_canvas: HTMLCanvasElement) {
		this.loadingManager = new THREE.LoadingManager();
		this.textureLoader = new THREE.TextureLoader(this.loadingManager);

		this.gui = new dat.GUI();

		this.gltfLoader = new GLTFLoader(this.loadingManager);

		this.canvas = _canvas;
		this.stats = new Stats({
			minimal: true,
		});

		this.camera = new THREE.PerspectiveCamera(
			75,
			window.innerWidth / window.innerHeight,
			0.1,
			1000
		);
		this.camera.position.set(-17, 12, -10);
		// See both world (grass) and car layers
		this.camera.layers.enable(0);
		this.camera.layers.enable(1);
		this.scene = new THREE.Scene();

		this.scene.background = new THREE.Color(this.sceneProps.fogColor);
		this.scene.fog = new THREE.FogExp2(
			this.sceneProps.fogColor,
			this.sceneProps.fogDensity
		);

		this.renderer = new THREE.WebGLRenderer({
			canvas: this.canvas,
			antialias: true,
			alpha: true,
			precision: "highp",
		});
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.autoUpdate = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.setSize(window.innerWidth, window.innerHeight);
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.scene.frustumCulled = true;

		this.grassMaterial = new GrassMaterial();
		this.terrainMat = new THREE.MeshPhongMaterial({
			color: this.sceneProps.terrainColor,
		});

		this.setupGUI();
		this.setupStats();
		this.setupTextures();
		this.setupEventListeners();
		this.dayNight = createDayNightCycle(this.scene, { shadowExtent: 90 });
		this.dayNight.auto = this.dayNightGui.auto;
		this.dayNight.speed = this.dayNightGui.speed;
	}

	async start() {
		const mark = (stage: string) => {
			console.log(`[FluffyGrass] ${stage}`);
			(window as unknown as { __bootStage?: string }).__bootStage = stage;
		};

		try {
			mark("physics-init");
			await initPhysics();
			mark("load-models");
			await this.loadModels();
			mark("setup-trees");
			await this.setupTrees();
			mark("setup-car");
			await this.setupCar();
			mark("ready");
			this.render();
		} catch (err) {
			mark(`error: ${err instanceof Error ? err.message : String(err)}`);
			throw err;
		}
	}

	private addGrass(
		surfaceMesh: THREE.Mesh,
		grassGeometry: THREE.BufferGeometry
	) {
		const sampler = new MeshSurfaceSampler(surfaceMesh).build();

		const grassInstancedMesh = new THREE.InstancedMesh(
			grassGeometry,
			this.grassMaterial.material,
			this.grassCount
		);
		grassInstancedMesh.receiveShadow = true;

		const position = new THREE.Vector3();
		const quaternion = new THREE.Quaternion();
		const scale = new THREE.Vector3(1, 1, 1);

		const normal = new THREE.Vector3();
		const yAxis = new THREE.Vector3(0, 1, 0);
		const matrix = new THREE.Matrix4();

		for (let i = 0; i < this.grassCount; i++) {
			sampler.sample(position, normal);

			quaternion.setFromUnitVectors(yAxis, normal);
			const randomRotation = new THREE.Euler(0, Math.random() * Math.PI * 2, 0);
			const randomQuaternion = new THREE.Quaternion().setFromEuler(
				randomRotation
			);

			quaternion.multiply(randomQuaternion);
			matrix.compose(position, quaternion, scale);

			grassInstancedMesh.setMatrixAt(i, matrix);
		}

		grassInstancedMesh.instanceMatrix.needsUpdate = true;
		grassInstancedMesh.frustumCulled = false;
		this.scene.add(grassInstancedMesh);
	}

	private loadGltf(url: string): Promise<THREE.Group> {
		return new Promise((resolve, reject) => {
			this.gltfLoader.load(
				url,
				(gltf) => resolve(gltf.scene),
				undefined,
				reject
			);
		});
	}

	private async loadModels() {
		this.sceneGUI
			.addColor(this.sceneProps, "terrainColor")
			.onChange((value) => {
				this.terrainMat.color.set(value);
			});

		const { mesh, heights, nrows, ncols } = createLargeTerrain(this.terrainMat);
		this.scene.add(mesh);

		mesh.updateMatrixWorld(true);
		setIslandTerrain(mesh);
		createTerrainHeightfieldCollider(heights, nrows, ncols);

		const grassScene = await this.loadGltf("/grassLODs.glb");
		let foundGrass = false;
		grassScene.traverse((child) => {
			if (child instanceof THREE.Mesh && child.name.includes("LOD00")) {
				child.geometry.scale(5, 5, 5);
				this.grassGeometry = child.geometry;
				foundGrass = true;
			}
		});
		if (!foundGrass) {
			throw new Error("grassLODs.glb: GrassLOD00 mesh not found");
		}

		this.addGrass(mesh, this.grassGeometry);

		console.log(
			`[FluffyGrass] terrain ${TERRAIN_CONFIG.size}×${TERRAIN_CONFIG.size}, grass=${this.grassCount}`
		);
	}

	private async setupTrees() {
		const { x: hx, z: hz } = TERRAIN_CONFIG.mainHill;
		const tree = await createTree({
			position: [hx, 0, hz],
			leafColor: "#3f6d21",
			scale: 3.4,
			rotationY: 0.4,
			foliageScale: 1.55,
			inflate: 0.12,
			leafLayers: 5,
			manager: this.loadingManager,
		});
		this.trees = [tree];
		this.scene.add(tree.group);

		// Canopy volume so fireflies weave through the leaves
		tree.group.updateMatrixWorld(true);
		const canopyBox = new THREE.Box3().setFromObject(tree.group);
		// Skip lower trunk — keep swarm in the foliage crown
		const trunkCut = canopyBox.min.y + (canopyBox.max.y - canopyBox.min.y) * 0.32;
		canopyBox.min.y = trunkCut;

		this.fireflies = createFireflies({
			count: 280,
			anchors: [
				{ kind: "volume", box: canopyBox, pad: 1.2, weight: 3.2 },
				{
					kind: "grass",
					x: hx,
					z: hz,
					spread: 10,
					heightMin: 0.4,
					heightMax: 3.2,
					weight: 1.2,
				},
				{
					kind: "grass",
					x: hx + 5,
					z: hz - 4,
					spread: 7,
					heightMin: 0.35,
					heightMax: 2.4,
					weight: 0.8,
				},
				{
					kind: "grass",
					x: 0,
					z: 0,
					spread: 14,
					heightMin: 0.3,
					heightMax: 2.5,
					weight: 1,
				},
				{
					kind: "grass",
					x: 6,
					z: 5,
					spread: 10,
					heightMin: 0.3,
					heightMax: 2.2,
					weight: 0.7,
				},
			],
		});
		this.scene.add(this.fireflies.points);
	}

	private async setupCar() {
		const car = await createCar(this.loadingManager);
		this.car = car;

		this.scene.add(car.mesh);
		for (const wheel of car.wheels) {
			car.mesh.add(wheel);
		}

		// Car on its own light layer so headlights only hit grass/terrain
		assignCarLightingLayer(car.mesh);

		this.carHeadlights = createCarHeadlights(car.mesh, CAR_CONFIG.scale);
		car.mesh.add(this.carHeadlights.group);
		// Keep beams on world layer even though the group is parented under the car
		this.carHeadlights.group.traverse((obj) => {
			if (obj instanceof THREE.Light) {
				obj.layers.set(0);
			}
		});
		this.carHeadlights.setIntensity(0);

		this.carController = new CarController(
			car.body,
			car.vehicle,
			car.driveFrontAxleIndices,
			car.driveRearAxleIndices,
			car.steeringWheelIndices
		);

		this.carInput = new CarInput(this.carController, () => {
			if (this.car && this.carController) {
				resetCarUpright(this.car, this.carController);
			}
		});

		this.chaseCameraInput = new ChaseCameraInput(this.canvas);
		syncCar(car);
	}

	private render = () => {
		const now = performance.now();
		let frameDt = (now - this.lastFrameTime) * 0.001;
		this.lastFrameTime = now;
		if (frameDt <= 0 || isNaN(frameDt)) frameDt = 1 / 60;
		const dt = Math.min(Math.max(frameDt, 0.001), 0.033);

		this.Uniforms.uTime.value += this.clock.getDelta();
		this.grassMaterial.update(this.Uniforms.uTime.value);
		updateFoliageWind(dt);

		if (this.dayNight) {
			const fireflyIntensity = this.dayNight.update(dt);
			this.dayNightGui.hour = this.dayNight.hour;
			this.dayNightGui.period = this.dayNight.period;
			this.dayNightGui.auto = this.dayNight.auto;

			const grassLight = this.dayNight.getGrassLight();
			this.grassMaterial.uniforms.uGrassLightIntensity.value = grassLight;

			// Headlights on through evening → night
			const hour = this.dayNight.hour;
			let headAmount = 0;
			if (hour >= 18 || hour < 6.5) {
				headAmount = Math.max(0.55, fireflyIntensity);
			}
			if (hour >= 19.5 || hour < 5.5) {
				headAmount = 1;
			}
			this.carHeadlights?.setIntensity(headAmount);
			this.frameFireflyIntensity = fireflyIntensity;
			this.frameHeadAmount = headAmount;
		}

		if (this.car && this.carInput && this.chaseCameraInput) {
			const world = getWorld();
			world.timestep = dt;
			this.carInput.applyInput(dt);
			world.step();
			this.carInput.afterPhysics(dt);
			syncCar(this.car);
			updateChaseCamera(this.camera, this.car, this.chaseCameraInput, dt);

			// Leave the map → wait 2s → respawn at start
			if (this.carController && isCarOutsideWorld(this.car)) {
				this.outOfWorldTimer += dt;
				if (this.outOfWorldTimer >= 2) {
					respawnCarAtStart(this.car, this.carController);
					syncCar(this.car);
					this.outOfWorldTimer = 0;
				}
			} else {
				this.outOfWorldTimer = 0;
			}
		}

		// Fireflies slowly drift out of the headlight beam into darker grass
		if (this.dayNight && this.fireflies) {
			let threat = null;
			if (this.car && this.frameHeadAmount > 0.05) {
				const mesh = this.car.mesh;
				mesh.updateMatrixWorld(true);
				mesh.getWorldPosition(this._fireflyCarPos);
				mesh.getWorldQuaternion(this._fireflyCarQuat);
				this._fireflyCarFwd
					.set(0, 0, 1)
					.applyQuaternion(this._fireflyCarQuat)
					.normalize();
				threat = {
					position: this._fireflyCarPos,
					forward: this._fireflyCarFwd,
					intensity: this.frameHeadAmount,
					range: 20,
					halfAngle: 0.72,
				};
			}
			this.fireflies.update(dt, this.frameFireflyIntensity, threat);
		}

		this.renderer.render(this.scene, this.camera);
		this.stats.update();
		requestAnimationFrame(this.render);
	};

	private setupTextures() {
		this.textures.perlinNoise = this.textureLoader.load("/perlinnoise.webp");

		this.textures.perlinNoise.wrapS = this.textures.perlinNoise.wrapT =
			THREE.RepeatWrapping;

		this.textures.grassAlpha = this.textureLoader.load("/grass.jpeg");

		this.grassMaterial.setupTextures(
			this.textures.grassAlpha,
			this.textures.perlinNoise
		);
	}

	private setupGUI() {
		this.gui.close();
		const guiContainer = this.gui.domElement.parentElement as HTMLDivElement;
		guiContainer.style.zIndex = "9999";
		guiContainer.style.position = "fixed";
		guiContainer.style.top = "0";
		guiContainer.style.left = "0";
		guiContainer.style.right = "auto";
		guiContainer.style.display = "block";

		this.sceneGUI = this.gui.addFolder("Scene Properties");
		this.sceneGUI
			.add(this.sceneProps, "fogDensity", 0, 0.05, 0.000001)
			.onChange((value) => {
				(this.scene.fog as THREE.FogExp2).density = value;
			});
		this.sceneGUI.addColor(this.sceneProps, "fogColor").onChange((value) => {
			this.scene.fog?.color.set(value);
			this.scene.background = new THREE.Color(value);
		});

		this.grassMaterial.setupGUI(this.sceneGUI);

		const skyFolder = this.gui.addFolder("Day / Night");
		skyFolder
			.add(this.dayNightGui, "period", [
				"morning",
				"noon",
				"evening",
				"sunset",
				"night",
			])
			.name("Period")
			.onChange((value: DayPeriod) => {
				this.dayNight?.setPeriod(value);
				this.dayNightGui.auto = false;
				this.dayNightGui.hour = this.dayNight?.hour ?? this.dayNightGui.hour;
			});
		skyFolder
			.add(this.dayNightGui, "auto")
			.name("Auto cycle")
			.onChange((value: boolean) => {
				if (this.dayNight) this.dayNight.auto = value;
			});
		skyFolder
			.add(this.dayNightGui, "speed", 0.02, 0.5, 0.01)
			.name("Cycle speed (5min≈0.08)")
			.onChange((value: number) => {
				if (this.dayNight) this.dayNight.speed = value;
			});
		skyFolder
			.add(this.dayNightGui, "hour", 0, 24, 0.1)
			.name("Hour")
			.listen()
			.onChange((value: number) => {
				this.dayNight?.setHour(value);
				if (this.dayNight) this.dayNight.auto = false;
				this.dayNightGui.auto = false;
			});
		skyFolder.open();

		this.sceneGUI.open();
	}

	private setupStats() {
		this.stats.init(this.renderer);
		const statsDom = (this.stats as unknown as { dom: HTMLElement }).dom;
		statsDom.style.bottom = "45px";
		statsDom.style.top = "auto";
		statsDom.style.left = "auto";
		statsDom.style.display = "none";
		document.body.appendChild(statsDom);
	}

	private setupEventListeners() {
		window.addEventListener("resize", () => this.setAspectResolution(), false);

		const statsDom = (this.stats as unknown as { dom: HTMLElement }).dom;
		statsDom.addEventListener("click", () => {
			console.log(this.renderer.info.render);
		});
	}

	private setAspectResolution() {
		this.camera.aspect = window.innerWidth / window.innerHeight;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(window.innerWidth, window.innerHeight);
	}
}

const canvas = document.querySelector("#canvas") as HTMLCanvasElement;
const app = new FluffyGrass(canvas);
app.start().catch((err) => {
	console.error("Failed to start FluffyGrass:", err);
	(window as unknown as { __bootError?: string }).__bootError =
		err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
	const hint = document.querySelector(".controls-hint");
	if (hint) {
		hint.textContent = `Boot error: ${err instanceof Error ? err.message : String(err)}`;
	}
});
