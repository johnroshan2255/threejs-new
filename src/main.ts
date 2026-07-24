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
import { resetCarUpright } from "./entities/car/resetCar";
import { syncCar } from "./entities/car/syncCar";
import { updateChaseCamera } from "./three/chaseCamera";
import { ChaseCameraInput } from "./three/chaseCameraInput";
import {
	createTree,
	updateFoliageWind,
	type TreeHandle,
} from "./entities/tree";

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
	private lastFrameTime = performance.now();

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
		this.addLights();
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

	private addLights() {
		const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
		this.scene.add(ambientLight);

		const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
		directionalLight.castShadow = true;
		directionalLight.position.set(220, 220, 220);
		directionalLight.shadow.camera.far = 500;
		directionalLight.shadow.camera.left = -90;
		directionalLight.shadow.camera.right = 90;
		directionalLight.shadow.camera.top = 90;
		directionalLight.shadow.camera.bottom = -90;
		directionalLight.shadow.mapSize.set(2048, 2048);

		this.scene.add(directionalLight);
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
		grassScene.traverse((child) => {
			if (child instanceof THREE.Mesh && child.name.includes("LOD00")) {
				child.geometry.scale(5, 5, 5);
				this.grassGeometry = child.geometry;
			}
		});

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
			// Bigger leaf cards + stacked rotated layers = fuller canopy
			foliageScale: 1.55,
			inflate: 0.12,
			leafLayers: 5,
			manager: this.loadingManager,
		});
		this.trees = [tree];
		this.scene.add(tree.group);
	}

	private async setupCar() {
		const car = await createCar(this.loadingManager);
		this.car = car;

		this.scene.add(car.mesh);
		for (const wheel of car.wheels) {
			car.mesh.add(wheel);
		}

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

		(window as unknown as { __fluffyDebug?: unknown }).__fluffyDebug = {
			getCarPos: () => {
				const t = car.body.translation();
				return { x: t.x, y: t.y, z: t.z };
			},
			getCamPos: () => ({
				x: this.camera.position.x,
				y: this.camera.position.y,
				z: this.camera.position.z,
			}),
			sceneChildren: this.scene.children.length,
		};
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

		if (this.car && this.carInput && this.chaseCameraInput) {
			const world = getWorld();
			world.timestep = dt;
			this.carInput.applyInput(dt);
			world.step();
			this.carInput.afterPhysics(dt);
			syncCar(this.car);
			updateChaseCamera(this.camera, this.car, this.chaseCameraInput, dt);
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
