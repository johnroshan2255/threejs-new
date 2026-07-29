import * as THREE from "three";
import Stats from "stats-gl";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Socket } from "socket.io-client";

import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import { GrassMaterial } from "./GrassMaterial";
import { initPhysics, getWorld } from "./physics/world";
import {
	createTerrainHeightfieldCollider,
	type TerrainColliderHandle,
} from "./physics/terrainCollider";
import { setIslandTerrain, getWorldTerrainY } from "./terrain/islandHeight";
import { createLargeTerrain, TERRAIN_CONFIG } from "./terrain/createLargeTerrain";
import { Pond } from "./entities/water";
import { createCar, type CarEntity } from "./entities/car/createCar";
import { loadKenneySuvVisual } from "./entities/car/kenneyCarVisual";
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
import { EngineSound } from "./entities/car/EngineSound";
import { updateChaseCamera, updateHumanCamera } from "./three/chaseCamera";
import { ChaseCameraInput } from "./three/chaseCameraInput";
import { HumanEntity } from "./entities/human/HumanEntity";
import { HumanInput } from "./entities/human/HumanInput";
import {
	createTree,
	updateFoliageWind,
	type TreeHandle,
} from "./entities/tree";
import {
	createPondStones,
	type PondStoneHandle,
} from "./entities/stone";
import { GrassChunkField } from "./entities/grass";
import {
	createDayNightCycle,
	type DayNightCycle,
	type DayPeriod,
} from "./environment/dayNightCycle";
import { createFireflies, type Fireflies } from "./environment/fireflies";
import { VolumetricFogSystem } from "./environment/VolumetricFogSystem";
import { SmokeTrailSystem } from "./environment/smokeTrail";
import { ExplosionSystem } from "./environment/ExplosionSystem";
import { BombSound } from "./audio/BombSound";
import { HornSound } from "./audio/HornSound";
import { ProceduralBridge } from "./environment/ProceduralBridge";
import { createMobileControls, type MobileControls } from "./ui/mobileControls";
import { createOrientationGate, type OrientationGate } from "./ui/orientationGate";
import { AuthService, type AuthUser } from "./auth/AuthService";
import { GameNavigation } from "./ui/GameNavigation";
import { LoadingScreenController } from "./ui/LoadingScreenController";
import {
	GameSettings,
	type GameWorldId,
	type GraphicsQuality,
} from "./ui/GameSettings";
import { WorldLoadingOverlay } from "./ui/WorldLoadingOverlay";

type RemotePlayer = {
	loaded: boolean;
	humanGroup?: THREE.Group;
	carGroup?: THREE.Group;
	humanBody?: RAPIER.RigidBody;
	carBody?: RAPIER.RigidBody;
	engineSound?: EngineSound;
	hornSound?: HornSound;
	mixer?: THREE.AnimationMixer;
	animations?: Map<string, THREE.AnimationAction>;
	currentAction?: THREE.AnimationAction | null;
	targetHumanPosition: THREE.Vector3;
	targetHumanQuaternion: THREE.Quaternion;
	targetCarPosition: THREE.Vector3;
	targetCarQuaternion: THREE.Quaternion;
	isBeingCarried?: boolean;
	isCarryingPlayer?: boolean;
};

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";

export class FluffyGrass {
	private loadingManager: THREE.LoadingManager;
	private textureLoader: THREE.TextureLoader;
	private gltfLoader: GLTFLoader;

	private camera: THREE.PerspectiveCamera;
	private renderer: THREE.WebGLRenderer;
	private scene: THREE.Scene;
	private canvas: HTMLCanvasElement;
	private stats: Stats;
	private sceneProps = {
		fogColor: "#eeeeee",
		terrainColor: "#5e875e",
		fogDensity: 0.012,
		humanScale: 0.03,
		mapMode: false,
	};
	private textures: { [key: string]: THREE.Texture } = {};

	// Interactive Objects
	private bombs: { mesh: THREE.Group, body: RAPIER.RigidBody | null, id: number, isFlying?: boolean, flightTime?: number }[] = [];

	Uniforms = {
		uTime: { value: 0 },
		color: { value: new THREE.Color("#0000ff") },
	};
	private clock = new THREE.Clock();

	private terrainMat: THREE.MeshPhongMaterial;
	private pond?: Pond;
	private grassGeometry = new THREE.BufferGeometry();
	private grassMaterial: GrassMaterial;
	private grassCount = 50000;
	private grassDensity = 100;
	private islandGrassField: GrassChunkField | null = null;
	private valleyGrassField: GrassChunkField | null = null;
	private graphicsQuality: GraphicsQuality = "High";
	private waterUpdateInterval = 1;
	private waterFrameCounter = 0;
	private waterDeltaAccumulator = 0;
	private renderFrameCounter = 0;
	private lastGpuPanelUpdate = 0;
	private lastSettingsSync = 0;
	private lastRippleInjection = 0;
	private readonly viewFrustum = new THREE.Frustum();
	private readonly viewProjectionMatrix = new THREE.Matrix4();

	private car: CarEntity | null = null;
	private carInput: CarInput | null = null;
	private carController: CarController | null = null;
	private chaseCameraInput: ChaseCameraInput | null = null;
	private engineSound: EngineSound | null = null;
	private carOutOfWorldTimer = 0;
	private humanOutOfWorldTimer = 0;

	private audioListener: THREE.AudioListener | null = null;

	private activePlayer: "car" | "human" = "car";
	private human: HumanEntity | null = null;
	private humanInput: HumanInput | null = null;
	private interactionPrompt: HTMLElement | null = null;

	private socket: Socket | null = null;
	private roomCode = "";

	private userData: AuthUser | null = null;
	private readonly authService = new AuthService(SERVER_URL);
	private gameNavigation: GameNavigation | null = null;
	private loadingScreenController: LoadingScreenController | null = null;
	private mySlotIndex = 0;

	private isBeingCarriedBy: string | null = null;
	private lobbyModels: THREE.Group[] = [];
	private lobbyMixers: THREE.AnimationMixer[] = [];
	private remotePlayers: Map<string, RemotePlayer> = new Map();

	private trees: TreeHandle[] = [];
	private pondStones: PondStoneHandle | null = null;
	private dayNight: DayNightCycle | null = null;
	private fireflies: Fireflies | null = null;
	private proceduralBridge: ProceduralBridge | null = null;
	private smokeSystem: SmokeTrailSystem | null = null;
	private explosionSystem: ExplosionSystem | null = null;
	private mobileControls: MobileControls | null = null;
	private orientationGate: OrientationGate | null = null;
	private carHeadlights: CarHeadlights | null = null;
	private dayNightGui = {
		period: "morning" as DayPeriod,
		auto: true,
		speed: 0.08, // ~5 min full cycle
		hour: 7,
	};
	private worldGroup = new THREE.Group();
	private newWorldGroup = new THREE.Group();
	private currentWorld: GameWorldId = "island";
	private isWorldSwitching = false;
	private settings!: GameSettings;
	private worldLoading!: WorldLoadingOverlay;
	private islandTerrainHandle: TerrainColliderHandle | null = null;
	private valleyTerrainBody: RAPIER.RigidBody | null = null;
	private valleySpawn = new THREE.Vector3(0, 4, 5);
	private initializationPromise: Promise<void>;
	private currentFogRadius = 65;
	private volumetricFog: VolumetricFogSystem | null = null;
	private lastFrameTime = performance.now();
	private frameFireflyIntensity = 0;
	private frameHeadAmount = 0;
	public isGameActive = false;
	/** Accumulated time spent outside the world before respawn (seconds). */
	private readonly _fireflyCarPos = new THREE.Vector3();
	private readonly _fireflyCarFwd = new THREE.Vector3();
	private readonly _fireflyCarQuat = new THREE.Quaternion();

	constructor(_canvas: HTMLCanvasElement) {
		this.loadingManager = new THREE.LoadingManager();

		const loadingBar = document.getElementById("loading-bar");
		const loadingText = document.getElementById("loading-text");
		this.loadingManager.onProgress = (url, itemsLoaded, itemsTotal) => {
			const progress = (itemsLoaded / itemsTotal) * 100;
			if (loadingBar) loadingBar.style.width = progress + "%";
			if (loadingText) {
				loadingText.textContent = `Loading... ${Math.round(progress)}%`;
			}
		};
		this.textureLoader = new THREE.TextureLoader(this.loadingManager);

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
		this.scene.add(this.camera);
		this.scene.add(this.worldGroup);
		this.scene.add(this.newWorldGroup);
		this.newWorldGroup.visible = false;

		this.audioListener = new THREE.AudioListener();
		this.camera.add(this.audioListener);

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
			shininess: 0,
			flatShading: true
		});

		this.setupStats();
		this.setupTextures();
		this.setupEventListeners();
		this.setupInteractionUI();
		this.orientationGate = createOrientationGate();
		this.dayNight = createDayNightCycle(this.scene, { shadowExtent: 90 });
		this.dayNight.auto = this.dayNightGui.auto;
		this.worldLoading = new WorldLoadingOverlay();
		this.setupSettings();

		this.dayNight.speed = this.dayNightGui.speed;

		this.smokeSystem = new SmokeTrailSystem();
		this.scene.add(this.smokeSystem.mesh);

		this.explosionSystem = new ExplosionSystem();
		this.scene.add(this.explosionSystem.mesh);

		this.initializationPromise = (async () => {
			await initPhysics();
			await this.buildIslandWorld();
			await this.setupCar();
			await this.setupHuman();

			// Initialize Volumetric Fog
			this.volumetricFog = new VolumetricFogSystem(300);
			this.scene.add(this.volumetricFog.group);

			await this.createLobbyModels();
		})();
	}

	async start() {
		const mark = (stage: string) => {
			console.log(`[FluffyGrass] ${stage}`);
			(window as unknown as { __bootStage?: string }).__bootStage = stage;
		};

		try {
			mark("loading");
			this.render();
			await this.initializationPromise;
			mark("ready");

			const loadingText = document.getElementById("loading-text");
			if (loadingText) loadingText.textContent = "Ready to play!";

			const proceed = (_action: "play", user: AuthUser | null) => {
				this.userData = user;
				this.isGameActive = true;
				this.settings.show();
				if (this.carInput) this.carInput.isEnabled = true;
				if (this.humanInput) this.humanInput.isEnabled = true;
				this.gameNavigation?.show();
				const settingsToggle = document.getElementById("settings-toggle");
				if (settingsToggle) settingsToggle.style.display = "flex";
				this.loadingScreenController?.hide();

				if (this.engineSound) this.engineSound.init();

				for (const model of this.lobbyModels) {
					model.visible = false;
				}

				// Spawn based on slot index to avoid overlapping cars
				const spawnX = this.mySlotIndex * 8;
				if (this.car && this.car.body) {
					const currPos = this.car.body.translation();
					const spawnY = getWorldTerrainY(spawnX, currPos.z) + 2.0;
					this.car.body.setTranslation({ x: spawnX, y: spawnY, z: currPos.z }, true);
				}
				// Also shift human (even if they are at -100 underground, shift X)
				if (this.human && this.human.body) {
					const currPos = this.human.body.translation();
					if (currPos.y > -50) {
						// Human is active and above ground, keep them on the terrain next to car
						const humanSpawnY = getWorldTerrainY(spawnX + 3, currPos.z) + 3.0;
						this.human.body.setTranslation({ x: spawnX + 3, y: humanSpawnY, z: currPos.z }, true);
					} else {
						// Human is hidden underground, just shift X
						this.human.body.setTranslation({ x: spawnX, y: currPos.y, z: currPos.z }, true);
					}
				}
			};
			(window as any).proceedPlayFn = proceed;

			this.gameNavigation = new GameNavigation({
				auth: this.authService,
				onUserChanged: (user) => {
					this.userData = user;
				},
				onHost: () => this.connectSocket("host"),
				onJoin: () => this.fetchRooms(),
				onLogout: () => this.disconnectMultiplayer(),
			});
			this.gameNavigation.initialize();

			const restoredUser = await this.authService.restoreSession();
			this.userData = restoredUser;
			this.gameNavigation.setUser(restoredUser);

			this.loadingScreenController = new LoadingScreenController({
				auth: this.authService,
				onPlay: () => proceed("play", this.userData),
			});
			this.loadingScreenController.initialize();

			// Setup Room List Panel Buttons
			const closeRoomListBtn = document.getElementById("close-room-list-btn");
			const refreshRoomsBtn = document.getElementById("refresh-rooms-btn");
			const roomListPanel = document.getElementById("room-list-panel");

			if (closeRoomListBtn && roomListPanel) {
				closeRoomListBtn.addEventListener("click", () => {
					roomListPanel.style.display = "none";

					// If they were in-game, bring back the top nav
					if (this.isGameActive) {
						this.gameNavigation?.show();
					}
				});
			}

			if (refreshRoomsBtn) {
				refreshRoomsBtn.addEventListener("click", () => {
					this.fetchRooms();
				});
			}

			// Setup Lobby Buttons
			const leaveLobbyBtn = document.getElementById("leave-lobby-btn");
			const startGameBtn = document.getElementById("start-game-btn");

			if (leaveLobbyBtn) {
				leaveLobbyBtn.addEventListener("click", () => {
					this.disconnectMultiplayer();
					proceed("play", this.userData);
				});
			}
			if (startGameBtn) {
				startGameBtn.addEventListener("click", () => {
					if (this.socket && this.roomCode) {
						this.socket.emit("start-game", this.roomCode);
					} else {
						document.getElementById("lobby-panel")!.style.display = "none";
						proceed("play", this.userData);
					}
				});
			}

		} catch (err) {
			mark(`error: ${err instanceof Error ? err.message : String(err)}`);
			throw err;
		}
	}

	private async ensureSocket() {
		if (this.socket) return;
		const { io } = await import("socket.io-client");
		if (this.socket) return;
		this.socket = io(SERVER_URL);

			this.socket.on("room-updated", (players: any[]) => {
				for (let i = 0; i < 4; i++) {
					const slot = document.querySelector(`#player-slot-${i} .slot-content`);
					if (slot) {
						if (i < players.length) {
							slot.textContent = players[i].user.username;
							slot.classList.remove("empty");
							slot.classList.add("filled");
							if (this.lobbyModels[i]) this.lobbyModels[i].visible = !this.isGameActive;
						} else {
							slot.textContent = "Waiting...";
							slot.classList.remove("filled");
							slot.classList.add("empty");
							if (this.lobbyModels[i]) this.lobbyModels[i].visible = false;
						}
					}
				}

				// Enable Start Game if host and >= 2 players
				const startBtn = document.getElementById("start-game-btn") as HTMLButtonElement;
				if (startBtn && this.socket?.id === players[0]?.socketId) {
					if (players.length >= 2) {
						startBtn.disabled = false;
						startBtn.textContent = "Start Game";
					} else {
						startBtn.disabled = true;
						startBtn.textContent = "Waiting for players...";
					}
				}
			});

			this.socket.on("host-migrated", (newHostId: string) => {
				if (newHostId === this.socket?.id) {
					const startBtn = document.getElementById("start-game-btn");
					if (startBtn) startBtn.style.display = "block";
				}
			});

			this.socket.on("room-closed", () => {
				this.roomCode = "";
				for (const [id, rp] of this.remotePlayers.entries()) {
					if (rp.carGroup) this.scene.remove(rp.carGroup);
					if (rp.humanGroup) this.scene.remove(rp.humanGroup);
					if (rp.carBody) getWorld().removeRigidBody(rp.carBody);
					if (rp.humanBody) getWorld().removeRigidBody(rp.humanBody);
					if (rp.engineSound) rp.engineSound.dispose();
					if (rp.hornSound) rp.hornSound.stop();
				}
				this.remotePlayers.clear();
			});

			this.socket.on("player-left", (socketId: string) => {
				const rp = this.remotePlayers.get(socketId);
				if (rp) {
					if (rp.carGroup) this.scene.remove(rp.carGroup);
					if (rp.humanGroup) this.scene.remove(rp.humanGroup);
					if (rp.engineSound) rp.engineSound.dispose();
					if (rp.hornSound) rp.hornSound.stop();
					this.remotePlayers.delete(socketId);
				}
			});

			this.socket.on("game-started", (players: any[]) => {
				if (players) {
					const idx = players.findIndex(p => p.socketId === this.socket?.id);
					if (idx !== -1) this.mySlotIndex = idx;
				}
				document.getElementById("lobby-panel")!.style.display = "none";
				const proceedPlay = (window as any).proceedPlayFn; // We will attach proceed to window in start()
				if (proceedPlay) {
					proceedPlay("play", this.userData);
				}
			});

			this.socket.on("bomb-picked-up", (data: any) => {
				const { socketId, bombId } = data;
				const rp = this.remotePlayers.get(socketId);
				const bombData = this.bombs.find(b => b.id === bombId);

				if (rp && rp.loaded && bombData) {
					bombData.isFlying = false;
					// Remove physics body
					if (bombData.body) {
						getWorld().removeRigidBody(bombData.body);
						bombData.body = null;
					}

					let hand: THREE.Object3D | null = null;
					rp.humanGroup.traverse((child: any) => {
						if (child.name.toLowerCase().includes("righthand") && !hand) hand = child;
					});

					if (hand) {
						bombData.mesh.position.set(0, 0.1, 0);
						hand.add(bombData.mesh);
					} else {
						bombData.mesh.position.set(0, 0.5, 0.5);
						rp.humanGroup.add(bombData.mesh);
					}
				}
			});

			this.socket.on("bomb-thrown", (data: any) => {
				const { bombId, position, velocity } = data;
				const bombData = this.bombs.find(b => b.id === bombId);

				if (bombData) {
					// Add back to scene
					this.scene.add(bombData.mesh);
					bombData.mesh.position.set(position.x, position.y, position.z);

					// Recreate physics
					const rbDesc = RAPIER.RigidBodyDesc.dynamic()
						.setTranslation(position.x, position.y, position.z)
						.setLinearDamping(0.1)
						.setAngularDamping(0.5);
					const body = getWorld().createRigidBody(rbDesc);

					const colDesc = RAPIER.ColliderDesc.ball(0.5).setMass(10);
					getWorld().createCollider(colDesc, body);

					bombData.body = body;
					bombData.isFlying = true;
					bombData.flightTime = 0;
					body.applyImpulse(velocity, true);

					BombSound.playThrowSound(bombData.mesh.position);
				}
			});

			this.socket.on("player-picked-up", (data: any) => {
				const { socketId, targetSocketId } = data;
				if (targetSocketId === this.socket?.id) {
					// We are being carried!
					this.isBeingCarriedBy = socketId;
				}
				
				// Update remote player state
				const carrier = this.remotePlayers.get(socketId);
				if (carrier) carrier.isCarryingPlayer = true;
				
				const target = this.remotePlayers.get(targetSocketId);
				if (target) target.isBeingCarried = true;
			});

			this.socket.on("player-thrown", (data: any) => {
				const { socketId, targetSocketId, position, velocity } = data;
				if (targetSocketId === this.socket?.id) {
					// We were thrown!
					this.isBeingCarriedBy = null;
					if (this.human && this.humanInput) {
						this.human.body.setTranslation(position, true);
						this.humanInput.applyKnockback(new THREE.Vector3(velocity.x, velocity.y, velocity.z));
						this.humanInput.startRecoverySequence();
					}
				}
				
				// Update remote player state
				const carrier = this.remotePlayers.get(socketId);
				if (carrier) carrier.isCarryingPlayer = false;
				
				const target = this.remotePlayers.get(targetSocketId);
				if (target) target.isBeingCarried = false;
			});

			this.socket.on("player-state-updated", async (data: any) => {
				const { socketId, state } = data;

				// Ensure remote player object exists
				let rp = this.remotePlayers.get(socketId);
				if (!rp) {
					// Async load the remote models
					rp = {
						loaded: false,
						targetHumanPosition: new THREE.Vector3(),
						targetHumanQuaternion: new THREE.Quaternion(),
						targetCarPosition: new THREE.Vector3(),
						targetCarQuaternion: new THREE.Quaternion()
					};
					this.remotePlayers.set(socketId, rp);

					const humanGltf = await this.loadGltfFull("/poutine.glb");
					const humanGroup = humanGltf.scene;
					humanGroup.scale.setScalar(this.sceneProps.humanScale);
					this.scene.add(humanGroup);

					const mixer = new THREE.AnimationMixer(humanGroup);
					const animations = new Map<string, THREE.AnimationAction>();
					humanGltf.animations.forEach((clip: any) => {
						const nameLower = clip.name.toLowerCase();
						if (nameLower.includes("walk") || nameLower.includes("run")) {
							clip.tracks.forEach((track: any) => {
								if (track.name.toLowerCase().includes(".position")) {
									const values = track.values;
									const startX = values[0];
									const startZ = values[2];
									for (let i = 0; i < values.length; i += 3) {
										values[i] = startX;
										values[i + 2] = startZ;
									}
								}
							});
						}
						const action = mixer.clipAction(clip);
						if (nameLower === "being carried" || nameLower === "fall down" || nameLower === "sit to stand" || nameLower === "sweep fall" || nameLower === "stand to sit") {
							action.setLoop(THREE.LoopOnce, 1);
							action.clampWhenFinished = true;
						} else {
							action.setLoop(THREE.LoopRepeat, Infinity);
						}
						animations.set(nameLower, action);
					});

					const layout = await loadKenneySuvVisual(CAR_CONFIG.colliderYOffset, this.loadingManager);
					const carGroup = new THREE.Group();
					carGroup.add(layout.body);
					layout.physicsWheelPositions.forEach(pos => {
						const wheel = layout.wheelTemplate.clone();
						wheel.position.set(pos[0], pos[1], pos[2]);
						carGroup.add(wheel);
					});
					this.scene.add(carGroup);

					// Create Kinematic Physics Bodies
					const humanRadius = 0.45;
					const humanHalfHeight = 1.5;
					const humanDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
					const humanBody = getWorld().createRigidBody(humanDesc);
					const humanCollider = RAPIER.ColliderDesc.capsule(humanHalfHeight, humanRadius)
						.setTranslation(0, 2.4, 0); // Offset upwards from feet
					getWorld().createCollider(humanCollider, humanBody);

					const hx = Math.max(0.1, (layout.chassisSize.x / 2) - CAR_CONFIG.colliderRoundness);
					const hy = layout.chassisSize.y / 2;
					const hz = Math.max(0.1, (layout.chassisSize.z / 2) - CAR_CONFIG.colliderRoundness);
					const colliderHy = Math.max(0.1, (hy * CAR_CONFIG.colliderHeightScale) - CAR_CONFIG.colliderRoundness);
					const colliderLocalY = CAR_CONFIG.colliderYOffset + hy * CAR_CONFIG.colliderLocalYFactor;

					const carDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
					const carBody = getWorld().createRigidBody(carDesc);
					const carCollider = RAPIER.ColliderDesc.roundCuboid(hx, colliderHy, hz, CAR_CONFIG.colliderRoundness)
						.setTranslation(0, colliderLocalY, 0);
					getWorld().createCollider(carCollider, carBody);

					rp.loaded = true;
					rp.humanGroup = humanGroup;
					rp.carGroup = carGroup;
					rp.humanBody = humanBody;
					rp.carBody = carBody;
					rp.mixer = mixer;
					rp.animations = animations;
					rp.currentAction = null;

					// Avoid overwriting if they disconnected while loading
					if (!this.remotePlayers.has(socketId)) {
						this.scene.remove(humanGroup);
						this.scene.remove(carGroup);
						getWorld().removeRigidBody(humanBody);
						getWorld().removeRigidBody(carBody);
						return;
					}
				}

				if (!rp.loaded) return;

				// Apply State Target
				if (state.humanPosition) {
					rp.targetHumanPosition.set(state.humanPosition.x, state.humanPosition.y, state.humanPosition.z);
					rp.targetHumanQuaternion.set(state.humanQuaternion.x, state.humanQuaternion.y, state.humanQuaternion.z, state.humanQuaternion.w);
				}
				if (state.carPosition) {
					rp.targetCarPosition.set(state.carPosition.x, state.carPosition.y, state.carPosition.z);
					rp.targetCarQuaternion.set(state.carQuaternion.x, state.carQuaternion.y, state.carQuaternion.z, state.carQuaternion.w);
				}

				if (!rp.engineSound) {
					rp.engineSound = new EngineSound(true);
					rp.engineSound.init();
				}
				if (!rp.hornSound) {
					rp.hornSound = new HornSound();
				}

				if (state.honking && !rp.hornSound.isPlaying) {
					rp.hornSound.play();
				} else if (!state.honking && rp.hornSound.isPlaying) {
					rp.hornSound.stop();
				}

				if (state.activeEntity === "human") {
					rp.carGroup.visible = true; // Wait, actually should carGroup be true here? Yes, if they left it. But humanGroup should be true too!
					rp.humanGroup.visible = true;
					rp.engineSound.update(0, 0, rp.carGroup.position);

					// Handle Animation
					if (rp.isBeingCarried && rp.animations.has("being carried")) {
						if (rp.currentAction !== rp.animations.get("being carried")) {
							if (rp.currentAction) rp.currentAction.fadeOut(0.2);
							rp.currentAction = rp.animations.get("being carried");
							rp.currentAction!.reset().fadeIn(0.2).play();
						}
					} else if (state.animation && rp.animations.has(state.animation)) {
						if (rp.currentAction !== rp.animations.get(state.animation)) {
							if (rp.currentAction) rp.currentAction.fadeOut(0.2);
							rp.currentAction = rp.animations.get(state.animation);
							rp.currentAction!.reset().fadeIn(0.2).play();
						}
					}
				} else if (state.activeEntity === "car") {
					rp.humanGroup.visible = false;
					rp.carGroup.visible = true;
					rp.engineSound.update(state.speed || 0, state.throttle || 0, rp.carGroup.position);
				}
			});

			this.socket.on("user-disconnected", (socketId: string) => {
				const rp = this.remotePlayers.get(socketId);
				if (rp && rp.loaded) {
					this.scene.remove(rp.humanGroup!);
					this.scene.remove(rp.carGroup!);
					if (rp.carBody) getWorld().removeRigidBody(rp.carBody);
					if (rp.humanBody) getWorld().removeRigidBody(rp.humanBody);
					if (rp.engineSound) rp.engineSound.dispose();
				}
				this.remotePlayers.delete(socketId);
			});
	}

	private async connectSocket(action: "host" | "join", roomCodeToJoin?: string) {
		await this.ensureSocket();

		const loadingScreen = document.getElementById("loading-screen");
		const lobbyPanel = document.getElementById("lobby-panel");
		const startBtn = document.getElementById("start-game-btn");
		const settingsToggle = document.getElementById("settings-toggle");

		if (action === "host") {
			this.socket!.emit("create-room", this.userData, (res: any) => {
				if (res.success) {
					this.roomCode = res.roomCode;
					this.isGameActive = false;
					if (lobbyPanel) lobbyPanel.style.display = "flex";
					if (startBtn) startBtn.style.display = "block";
					if (loadingScreen) loadingScreen.style.display = "none";
					if (settingsToggle) settingsToggle.style.display = "none";
					this.gameNavigation?.hide();
					this.settings.hide();
				}
			});
		} else if (action === "join" && roomCodeToJoin) {
			this.socket!.emit("join-room", { roomCode: roomCodeToJoin, userData: this.userData }, (res: any) => {
				if (res.success) {
					this.roomCode = res.roomCode;
					this.isGameActive = false;
					if (lobbyPanel) lobbyPanel.style.display = "flex";
					if (startBtn) startBtn.style.display = "none";
					if (loadingScreen) loadingScreen.style.display = "none";
					if (settingsToggle) settingsToggle.style.display = "none";
					this.gameNavigation?.hide();
					this.settings.hide();
				} else {
					console.error(res.error || "Failed to join room");
				}
			});
		}
	}

	private disconnectMultiplayer() {
		this.socket?.disconnect();
		this.socket = null;
		this.roomCode = "";

		for (const remotePlayer of this.remotePlayers.values()) {
			if (remotePlayer.carGroup) this.scene.remove(remotePlayer.carGroup);
			if (remotePlayer.humanGroup) this.scene.remove(remotePlayer.humanGroup);
			if (remotePlayer.carBody) getWorld().removeRigidBody(remotePlayer.carBody);
			if (remotePlayer.humanBody) getWorld().removeRigidBody(remotePlayer.humanBody);
			remotePlayer.engineSound?.dispose();
			remotePlayer.hornSound?.stop();
		}
		this.remotePlayers.clear();

		const lobbyPanel = document.getElementById("lobby-panel");
		const roomListPanel = document.getElementById("room-list-panel");
		if (lobbyPanel) lobbyPanel.style.display = "none";
		if (roomListPanel) roomListPanel.style.display = "none";
		if (this.isGameActive) this.gameNavigation?.show();
	}

	private async fetchRooms() {
		// Ensure socket is connected and listeners are attached
		await this.ensureSocket();

		const roomListPanel = document.getElementById("room-list-panel");
		const roomListContainer = document.getElementById("room-list-container");

		if (roomListPanel) roomListPanel.style.display = "flex";
		this.gameNavigation?.hide();

		if (roomListContainer) {
			roomListContainer.innerHTML = `<div style="color: white; text-align: center; padding: 20px;">Fetching rooms...</div>`;
		}

		this.socket!.emit("get-rooms", (res: any) => {
			if (res.success && roomListContainer) {
				roomListContainer.innerHTML = "";

				if (res.rooms.length === 0) {
					roomListContainer.innerHTML = `<div style="color: rgba(255,255,255,0.5); text-align: center; padding: 20px;">No active rooms found. Why not host one?</div>`;
					return;
				}

				res.rooms.forEach((room: any) => {
					const roomItem = document.createElement("div");
					roomItem.className = "room-item";

					const isFull = room.playerCount >= 4;

					roomItem.innerHTML = `
						<div class="room-info">
							<div class="room-host">${room.hostName}'s Game</div>
							<div class="room-players">${room.playerCount} / 4 Players</div>
						</div>
						<button class="room-join-btn" ${isFull ? 'disabled style="background: rgba(14, 22, 16, 0.5); cursor: not-allowed;"' : ''}>
							${isFull ? 'Full' : 'Join'}
						</button>
					`;

					if (!isFull) {
						const joinBtn = roomItem.querySelector(".room-join-btn");
						if (joinBtn) {
							joinBtn.addEventListener("click", () => {
								roomListPanel!.style.display = "none";
								this.connectSocket("join", room.roomCode);
							});
						}
					}

					roomListContainer.appendChild(roomItem);
				});
			}
		});
	}

	private async createBombs() {
		const gltf = await this.loadGltfFull("/bomb.glb");
		const bombScene = gltf.scene;

		// The grass is very tall, so make the bomb 1.0 meter tall so it can be seen above the grass!
		const box = new THREE.Box3().setFromObject(bombScene);
		const size = new THREE.Vector3();
		box.getSize(size);
		const scaleFactor = 1.0 / Math.max(0.01, size.y);
		bombScene.scale.setScalar(scaleFactor);

		const world = getWorld();

		for (let i = 0; i < 5; i++) {
			const clone = bombScene.clone(true);

			const startPos = new THREE.Vector3();
			if (i === 0) {
				// Put the very first bomb exactly next to the car so it's impossible to miss
				startPos.set(CAR_CONFIG.spawn.x + 3, 0, CAR_CONFIG.spawn.z);
			} else {
				const angle = Math.random() * Math.PI * 2;
				const dist = 5 + Math.random() * 15;
				startPos.set(
					CAR_CONFIG.spawn.x + Math.cos(angle) * dist,
					0,
					CAR_CONFIG.spawn.z + Math.sin(angle) * dist
				);
			}

			// Float it slightly above the ground so it drops in realistically
			startPos.y = getWorldTerrainY(startPos.x, startPos.z) + 3.0;

			clone.position.copy(startPos);
			clone.traverse((child) => {
				if (child instanceof THREE.Mesh) {
					child.castShadow = true;
					child.receiveShadow = true;
				}
			});

			// Create physics body for the bomb
			// A 1.0m tall bomb roughly has a radius of 0.5m
			const rbDesc = RAPIER.RigidBodyDesc.dynamic()
				.setTranslation(startPos.x, startPos.y, startPos.z)
				.setLinearDamping(0.5)
				.setAngularDamping(0.5);
			const body = world.createRigidBody(rbDesc);

			const colDesc = RAPIER.ColliderDesc.ball(0.5).setMass(10);
			world.createCollider(colDesc, body);

			this.bombs.push({ mesh: clone, body, id: i });
			this.worldGroup.add(clone);
		}
	}

	private addGrass(
		surfaceMesh: THREE.Mesh,
		grassGeometry: THREE.BufferGeometry,
		targetGroup: THREE.Group,
		pondLocalPos: THREE.Vector2 = new THREE.Vector2(-20, 5),
		grassHeightMultiplier: number = 1.0,
		isNewWorld: boolean = false
	) {
		const sampler = new MeshSurfaceSampler(surfaceMesh).build();
		const matrices: THREE.Matrix4[] = [];

		const position = new THREE.Vector3();
		const quaternion = new THREE.Quaternion();
		const scale = new THREE.Vector3(1, 1, 1);

		const normal = new THREE.Vector3();
		const yAxis = new THREE.Vector3(0, 1, 0);
		const matrix = new THREE.Matrix4();

		let instanceIndex = 0;
		for (let i = 0; i < this.grassCount * 1.5; i++) { // sample more to hit target
			if (instanceIndex >= this.grassCount) break;
			sampler.sample(position, normal);

			if (isNewWorld) {
				// Only place grass on flat-ish surfaces (like real mountains)
				// dot = 1.0 means perfectly flat, dot = 0 means vertical cliff
				const steepness = normal.dot(yAxis);
				if (steepness < 0.5) continue; // Very steep cliff — no grass at all
				if (steepness < 0.7 && Math.random() > 0.15) continue; // Moderately steep — very sparse grass

				// Cluster grass into natural patches using noise
				// This creates distinct groups of grass with bare ground between them
				const clusterNoise =
					Math.sin(position.x * 0.4 + position.z * 0.3) *
					Math.cos(position.z * 0.5 - position.x * 0.2) +
					Math.sin(position.x * 0.8 + 2.1) * Math.cos(position.z * 0.7 + 1.3) * 0.5;
				if (clusterNoise < 0.2) continue; // Skip — bare ground between clusters
			}

			// Use the provided pond local position to clear grass around it
			const distToPond = Math.hypot(position.x - pondLocalPos.x, position.z - pondLocalPos.y);
			let heightScale = 1.0;

			if (distToPond < 14) {
				if (distToPond < 8) {
					// Deep water - very sparse and short grass
					if (Math.random() > 0.15) continue;
					heightScale = 0.25 + Math.random() * 0.15;
				} else if (distToPond < 10) {
					// Shallow water - sparse short grass
					if (Math.random() > 0.4) continue;
					heightScale = 0.35 + Math.random() * 0.2;
				} else {
					// Shoreline - transition from short grass to full height
					const t = (distToPond - 10) / 4;
					heightScale = 0.45 + 0.55 * t;
				}
			}

			// Base random scale variation for all grass
			const randomVariation = 0.8 + Math.random() * 0.4;
			scale.set(
				randomVariation * grassHeightMultiplier,                 // X: Scaled width
				heightScale * randomVariation * grassHeightMultiplier,   // Y: Scaled height
				randomVariation * grassHeightMultiplier                  // Z: Scaled width
			);

			quaternion.setFromUnitVectors(yAxis, normal);
			const randomRotation = new THREE.Euler(0, Math.random() * Math.PI * 2, 0);
			const randomQuaternion = new THREE.Quaternion().setFromEuler(
				randomRotation
			);

			quaternion.multiply(randomQuaternion);
			matrix.compose(position, quaternion, scale);

			matrices.push(matrix.clone());
			instanceIndex++;
		}

		const field = new GrassChunkField({
			matrices,
			geometry: grassGeometry,
			material: this.grassMaterial.material,
			origin: surfaceMesh.position,
			chunkSize: 20,
			density: this.grassDensity,
		});
		targetGroup.add(field.group);
		return field;
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

	private loadGltfFull(url: string): Promise<any> {
		return new Promise((resolve, reject) => {
			this.gltfLoader.load(url, resolve, undefined, reject);
		});
	}

	private async loadModels() {
		const { mesh, heights, nrows, ncols } = createLargeTerrain(this.terrainMat);
		this.worldGroup.add(mesh);

		mesh.updateMatrixWorld(true);
		setIslandTerrain(mesh);
		this.islandTerrainHandle = createTerrainHeightfieldCollider(heights, nrows, ncols);

		this.pond = new Pond({
			width: 20,
			height: 20,
			circular: true,
			color: this.sceneProps.terrainColor,
			bottomColor: this.sceneProps.terrainColor,
			renderer: this.renderer,
			scene: this.scene,
			camera: this.camera,
			sunDirection: new THREE.Vector3(1, 1, 1).normalize()
		});
		// Position exactly in the basin we scooped out at (-20, 5)
		this.pond.mesh.position.set(-20, -0.5, 5);
		this.pond.mesh.renderOrder = 1; // Force water to draw AFTER grass!
		this.worldGroup.add(this.pond.mesh);
		this.resizePondTargets();

		if (!this.grassGeometry.hasAttribute("position")) {
			const grassScene = await this.loadGltf("/grassLODs.glb");
			let foundGrass = false;
			grassScene.traverse((child) => {
				if (child instanceof THREE.Mesh && child.name.includes("LOD00")) {
					child.geometry.scale(5, 1, 5);
					this.grassGeometry = child.geometry;
					foundGrass = true;
				}
			});
			if (!foundGrass) {
				throw new Error("grassLODs.glb: GrassLOD00 mesh not found");
			}
		}

		this.islandGrassField = this.addGrass(mesh, this.grassGeometry, this.worldGroup);

		console.log(
			`[FluffyGrass] terrain ${TERRAIN_CONFIG.size}×${TERRAIN_CONFIG.size}, grass=${this.grassCount}`
		);
	}

	private async buildIslandWorld() {
		await this.loadModels();
		await this.setupPondStones();
		await this.setupTrees();
		await this.createBombs();
		this.proceduralBridge = new ProceduralBridge(
			getWorld(),
			new THREE.Vector3(0, -1.0, 60),
			8,
			2,
			200
		);
		this.scene.add(this.proceduralBridge.group);
	}

	private async setupPondStones() {
		this.pondStones?.dispose();
		this.pondStones = await createPondStones({
			center: new THREE.Vector3(-20, 0, 5),
			pondRadius: 10,
			manager: this.loadingManager,
		});
		this.worldGroup.add(this.pondStones.group);
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
		this.worldGroup.add(tree.group);

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
		this.worldGroup.add(this.fireflies.points);
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

		this.engineSound = new EngineSound();

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

		this.mobileControls = createMobileControls(() => {
			if (this.car && this.carController) {
				resetCarUpright(this.car, this.carController);
			}
		});
		this.carInput.setMobileControls(this.mobileControls);

		this.chaseCameraInput = new ChaseCameraInput(this.canvas);
		syncCar(car);
	}

	private async setupHuman() {
		const gltf = await this.loadGltfFull("/poutine.glb");
		const scene = gltf.scene;

		// Default to the scale in sceneProps
		scene.scale.setScalar(this.sceneProps.humanScale);

		this.human = new HumanEntity(
			scene,
			gltf.animations,
			getWorld(),
			new THREE.Vector3(0, -100, 0) // Start hidden far underground
		);
		this.scene.add(this.human.mesh);
		this.human.mesh.visible = false;

		this.humanInput = new HumanInput(this.human);
		if (this.mobileControls) {
			this.humanInput.setMobileControls(this.mobileControls);
		}

		// Connect the procedural pickup animation to grab the object
		this.humanInput.checkCanPickup = () => {
			if (!this.human) return null;

			// Check if already holding a bomb
			let holdingBomb = false;
			for (const bomb of this.bombs) {
				bomb.mesh.traverseAncestors(ancestor => {
					if (ancestor === this.human?.mesh) holdingBomb = true;
				});
			}
			if (holdingBomb) return null;

			let nearestBomb: THREE.Group | null = null;
			let minDst = Infinity;
			for (const bomb of this.bombs) {
				if (bomb.mesh.parent === this.worldGroup) {
					const dist = this.human.mesh.position.distanceTo(bomb.mesh.position);
					if (dist < 3.0 && dist < minDst) {
						minDst = dist;
						nearestBomb = bomb.mesh;
					}
				}
			}
			return nearestBomb;
		};

		this.humanInput.checkIsHoldingObject = () => {
			for (const bomb of this.bombs) {
				let heldByMe = false;
				bomb.mesh.traverseAncestors(ancestor => {
					if (ancestor === this.human?.mesh) heldByMe = true;
				});
				if (heldByMe) return bomb.mesh;
			}
			return null;
		};

		this.humanInput.onThrowObject = (obj: THREE.Object3D) => {
			if (!this.human) return;
			const bombData = this.bombs.find(b => b.mesh === obj);
			if (!bombData) return;

			// Get character's forward direction
			const forward = new THREE.Vector3(0, 0, 1);
			forward.applyQuaternion(this.human.mesh.quaternion);
			forward.normalize();

			// Throw from shoulder height, slightly forward
			const worldPos = new THREE.Vector3();
			worldPos.copy(this.human.mesh.position);
			worldPos.y += 1.5; // Shoulder height
			worldPos.addScaledVector(forward, 0.8);

			this.worldGroup.add(obj); // Parent is now worldGroup again
			obj.position.copy(worldPos);

			// Recreate physics body
			const rbDesc = RAPIER.RigidBodyDesc.dynamic()
				.setTranslation(worldPos.x, worldPos.y, worldPos.z)
				.setLinearDamping(0.1)
				.setAngularDamping(0.5);
			const body = getWorld().createRigidBody(rbDesc);

			const colDesc = RAPIER.ColliderDesc.ball(0.5).setMass(10);
			getWorld().createCollider(colDesc, body);

			bombData.body = body;

			// Throw it forward and HIGH into the air!
			// We already have 'forward' from the top of the function
			forward.y = 0; // flatten it so we don't depend on character pitch
			forward.normalize();

			// Mass is 10. 
			// Y Impulse = 80 -> Upward velocity 8m/s. Reaches ~3.2m high (plus the 1.5m start height = 4.7m total height!)
			// X/Z Impulse = 50 -> Forward velocity 5m/s. Travels 7+ meters before hitting the ground.
			const vel = {
				x: forward.x * 50,
				y: 80,
				z: forward.z * 50
			};
			body.applyImpulse(vel, true);
			bombData.isFlying = true;
			bombData.flightTime = 0;

			BombSound.playThrowSound(bombData.mesh.position);

			if (this.socket && this.roomCode) {
				this.socket.emit("bomb-throw", {
					roomCode: this.roomCode,
					bombId: bombData.id,
					position: { x: worldPos.x, y: worldPos.y, z: worldPos.z },
					velocity: vel
				});
			}
		};

		this.humanInput.onGrabObject = (obj: THREE.Object3D) => {
			if (!this.human) return;
			if (obj.parent !== this.worldGroup) return; // already picked up

			// Remove physics body from the world so it stops falling
			const bombData = this.bombs.find(b => b.mesh === obj);
			if (bombData && bombData.body) {
				getWorld().removeRigidBody(bombData.body);
				bombData.body = null;
			}

			let hand: THREE.Object3D | null = null;
			this.human.mesh.traverse(child => {
				if (child.name.toLowerCase().includes("righthand") && !hand) hand = child;
			});

			if (hand) {
				// Attach the object to the character's hand
				obj.position.set(0, 0.1, 0); // local to hand
				hand.add(obj);
			} else {
				// Fallback if no bone found, attach to body
				obj.position.set(0, 0.5, 0.5);
				this.human.mesh.add(obj);
			}

			if (this.socket && this.roomCode && bombData) {
				this.socket.emit("bomb-pickup", { roomCode: this.roomCode, bombId: bombData.id });
			}
		};
		this.humanInput.checkCanPickupPlayer = () => {
			if (!this.human) return null;
			let nearestPlayerId: string | null = null;
			let minDst = Infinity;
			
			for (const [socketId, rp] of this.remotePlayers.entries()) {
				if (!rp.loaded || !rp.humanGroup) continue;
				if (rp.humanGroup.visible) {
					const dist = this.human.mesh.position.distanceTo(rp.humanGroup.position);
					if (dist < 2.5 && dist < minDst) {
						minDst = dist;
						nearestPlayerId = socketId;
					}
				}
			}
			return nearestPlayerId;
		};

		this.humanInput.onGrabPlayer = (socketId: string) => {
			if (this.socket && this.roomCode) {
				this.socket.emit("player-pickup", { roomCode: this.roomCode, targetSocketId: socketId });
			}
			const target = this.remotePlayers.get(socketId);
			if (target) target.isBeingCarried = true;
		};

		this.humanInput.onThrowPlayer = (socketId: string) => {
			if (!this.human) return;
			// Get character's forward direction
			const forward = new THREE.Vector3(0, 0, 1);
			forward.applyQuaternion(this.human.mesh.quaternion);
			forward.y = 0;
			forward.normalize();
			
			const worldPos = new THREE.Vector3();
			worldPos.copy(this.human.mesh.position);
			worldPos.y += 1.5; 
			worldPos.y += 2.4; // Account for physics body offset so they don't spawn underground!
			worldPos.addScaledVector(forward, 1.5);
			
			const vel = {
				x: forward.x * 3, // Toss them gently forward
				y: 3,             // and slightly upward
				z: forward.z * 3
			};
			
			if (this.socket && this.roomCode) {
				this.socket.emit("player-throw", {
					roomCode: this.roomCode,
					targetSocketId: socketId,
					position: { x: worldPos.x, y: worldPos.y, z: worldPos.z },
					velocity: vel
				});
			}
			
			const target = this.remotePlayers.get(socketId);
			if (target) target.isBeingCarried = false;
		};
	}
	private async createLobbyModels() {
		// Add a light to the camera so the models are always visible in the lobby
		const camLight = new THREE.PointLight(0xffffff, 1.5, 20);
		camLight.position.set(0, 2, 0); // slightly above camera
		this.camera.add(camLight);

		const colors = [
			0xffffff, // Original (White/None)
			0xff3333, // Red
			0x33ff33, // Green
			0xffff33, // Yellow
		];

		const spacing = 3.4;
		const startX = -1.5 * spacing - 0.85; // Shifted even further left to perfectly center with UI

		for (let i = 0; i < 4; i++) {
			// Reloading GLTF fixes SkinnedMesh bone references (clone() breaks them)
			const gltf = await this.loadGltfFull("/poutine.glb");
			const clone = gltf.scene;
			clone.scale.setScalar(this.sceneProps.humanScale * 1.25); // Scale up slightly

			// Models will remain their original color
			// (Removed tinting logic since model is a single mesh)

			// Set rotation to face the camera. (Math.PI / 4 is exactly forward!)
			clone.rotation.set(0, Math.PI / 4, 0);

			// Position exactly aligned with 4 columns at z = -5, moved down slightly to sit nicely
			clone.position.set(startX + (i * spacing), -1.0, -5.0);

			// Add to camera so it moves with it
			this.camera.add(clone);

			// Play idle animation
			const mixer = new THREE.AnimationMixer(clone);
			const idleClip = gltf.animations.find((c: any) => c.name.toLowerCase().includes("idle"));
			if (idleClip) {
				mixer.clipAction(idleClip).play();
			}
			this.lobbyMixers.push(mixer);

			// Initially hidden until someone joins that slot
			clone.visible = false;
			this.lobbyModels.push(clone);
		}
	}

	private render = () => {
		requestAnimationFrame(this.render);

		const now = performance.now();
		let frameDt = (now - this.lastFrameTime) * 0.001;
		this.lastFrameTime = now;
		if (frameDt <= 0 || isNaN(frameDt)) frameDt = 1 / 60;
		const dt = Math.min(Math.max(frameDt, 0.001), 0.033);
		this.renderFrameCounter++;
		if (
			this.graphicsQuality === "Medium" &&
			this.renderFrameCounter % 6 === 0
		) {
			this.renderer.shadowMap.needsUpdate = true;
		}

		this.Uniforms.uTime.value += this.clock.getDelta();

		if (this.car) {
			const fogCenter = this.currentWorld === "valley" ? this.car.mesh.position : undefined;
			const fogUpdateInterval = this.graphicsQuality === "High" ? 2 : 3;
			if (
				this.volumetricFog?.group.visible &&
				this.renderFrameCounter % fogUpdateInterval === 0
			) {
				this.volumetricFog.update(
					this.car.mesh.position,
					this.camera,
					this.currentFogRadius,
					fogCenter
				);
			}
			if (this.currentWorld === "island") {
				this.proceduralBridge?.update(this.car.mesh.position);
			}
		}

		if (this.currentWorld === "island" && this.worldGroup.visible) {
			this.grassMaterial.update(this.Uniforms.uTime.value);
			if (this.renderFrameCounter % 2 === 0) {
				this.islandGrassField?.updateDistanceCulling(this.camera.position);
			}
			updateFoliageWind(dt);
			if (this.pond) {
				const pondVisible = this.isObjectVisible(this.pond.mesh);
				if (pondVisible) {
					this.waterDeltaAccumulator = Math.min(
						0.1,
						this.waterDeltaAccumulator + dt
					);
					this.waterFrameCounter++;
					if (this.waterFrameCounter >= this.waterUpdateInterval) {
						this.pond.update(this.waterDeltaAccumulator);
						this.waterFrameCounter = 0;
						this.waterDeltaAccumulator = 0;
					}
				}

				if (pondVisible && now - this.lastRippleInjection >= 100) {
					this.lastRippleInjection = now;
					const waterY = this.pond.mesh.position.y;

					if (this.car?.body) {
						if (Math.abs(this.car.mesh.position.y - waterY) < 2.0) {
							const speed = this.car.body.linvel();
							const velocity = Math.hypot(speed.x, speed.z);
							if (velocity > 1.0) {
								this.pond.createRipple({
									position: this.car.mesh.position,
									strength: Math.min(0.5, velocity * 0.05),
									radius: 1.5
								});
							}
						}
					}

					if (this.human?.body) {
						if (Math.abs(this.human.mesh.position.y - waterY) < 1.0) {
							const speed = this.human.body.linvel();
							const velocity = Math.hypot(speed.x, speed.z);
							if (velocity > 0.5) {
								this.pond.createRipple({
									position: this.human.mesh.position,
									strength: 0.1,
									radius: 0.8
								});
							}
						}
					}

					for (const bomb of this.bombs) {
						if (bomb.body && Math.abs(bomb.mesh.position.y - waterY) < 0.5) {
							const speed = bomb.body.linvel();
							const velocity = Math.hypot(speed.x, speed.z);
							if (velocity > 0.5) {
								this.pond.createRipple({
									position: bomb.mesh.position,
									strength: 0.05,
									radius: 0.5
								});
							}
						}
					}
				}
			}
		}

		if (this.currentWorld === "valley" && this.newWorldGroup.visible) {
			this.grassMaterial.update(this.Uniforms.uTime.value);
			if (this.renderFrameCounter % 2 === 0) {
				this.valleyGrassField?.updateDistanceCulling(this.camera.position);
			}
		}

		if (!this.isGameActive) {
			for (const mixer of this.lobbyMixers) {
				mixer.update(dt);
			}
		}

		if (this.dayNight) {
			const fireflyIntensity = this.dayNight.update(dt);
			this.dayNightGui.hour = this.dayNight.hour;
			this.dayNightGui.period = this.dayNight.period;
			this.dayNightGui.auto = this.dayNight.auto;
			if (now - this.lastSettingsSync >= 200) {
				this.lastSettingsSync = now;
				this.settings.setHour(this.dayNight.hour);
				this.settings.setPeriod(this.dayNight.period);
				this.settings.setAutoDayNight(this.dayNight.auto);
			}

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

		if (!this.isWorldSwitching && this.isGameActive && this.car && this.carInput && this.chaseCameraInput && this.human && this.humanInput) {
			const playAllowed = this.orientationGate?.isPlayAllowed() ?? true;
			const world = getWorld();
			world.timestep = dt;

			if (playAllowed) {
				if (this.activePlayer === "car") {
					this.carInput.applyInput(dt);
				} else {
					if (!this.isBeingCarriedBy) {
						this.humanInput.isEnabled = true;
						this.humanInput.update(dt, this.camera);
					} else {
						this.humanInput.isEnabled = false;
					}
				}
			}

			if (this.isBeingCarriedBy) {
				const carrier = this.remotePlayers.get(this.isBeingCarriedBy);
				if (carrier && carrier.loaded && carrier.humanGroup) {
					const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(carrier.humanGroup.quaternion).normalize();
					const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(carrier.humanGroup.quaternion).normalize();
					
					const worldPos = new THREE.Vector3();
					carrier.humanGroup.getWorldPosition(worldPos);
					worldPos.addScaledVector(forward, 0.65); // Move forward into hands (increased distance)
					worldPos.addScaledVector(right, 0.7); // Move to the right side (centered slightly more)
					worldPos.y += 1.4; // Hands height for mesh
					worldPos.y += 2.4; // Add physics body offset
					
					this.human.body.setTranslation(worldPos, true);
					this.human.body.setLinvel({x:0, y:0, z:0}, true);
				}
				this.human.playAnimation("being carried");
			}

			world.step();

			if (playAllowed) {
				if (this.activePlayer === "car") {
					this.carInput.afterPhysics(dt);
				}
				this.human.update(dt);
			}
			syncCar(this.car);

			if (this.engineSound && this.carController) {
				const speed = this.carController.getSpeed();
				const throttle = this.carController.getThrottle();
				this.engineSound.update(speed, throttle);
			}

			// Sync bomb physics
			if (this.worldGroup.visible) {
				for (const bomb of this.bombs) {
					if (bomb.body) {
						const t = bomb.body.translation();
						const r = bomb.body.rotation();
						bomb.mesh.position.set(t.x, t.y, t.z);
						bomb.mesh.quaternion.set(r.x, r.y, r.z, r.w);

						if (bomb.isFlying) {
							bomb.flightTime = (bomb.flightTime || 0) + dt;
							// If y is close to terrain, we've landed
							const ty = getWorldTerrainY(t.x, t.z);
							if (bomb.flightTime > 0.2 && t.y <= ty + 0.8) {
								bomb.isFlying = false;

								// Trigger blast sound after 1 second
								const blastPos = bomb.mesh.position.clone();
								const blastId = bomb.id;
								setTimeout(() => {
									BombSound.playBlastSound(blastPos);
									this.explosionSystem?.emit(blastPos);

									// --- WATER SPLASH ---
									if (this.pond) {
										const distToPond = Math.hypot(blastPos.x - (-20), blastPos.z - 5);
										const waterY = this.pond.mesh.position.y;
										// If bomb is anywhere near or inside the pond (radius 15 to include shores)
										if (distToPond < 15 && Math.abs(blastPos.y - waterY) < 4.0) {
											this.pond.createRipple({
												position: blastPos,
												strength: 1.5, // Huge displacement
												radius: 5.0    // Huge area
											});
										}
									}

									// --- KNOCKBACK PHYSICS ---
									const blastRadius = 3.5; // Blast radius

									// 1. Player Knockback
									if (this.human && this.humanInput) {
										const dist = this.human.mesh.position.distanceTo(blastPos);
										if (dist < blastRadius) {
											// Just trigger the animation sequence, do not apply physics knockback
											this.humanInput.startRecoverySequence("explosion");
										}
									}

									// 2. Car Knockback
									if (this.car && this.car.body) {
										// Car is large, check distance from center
										const dist = this.car.mesh.position.distanceTo(blastPos);
										// Give car slightly larger blast reception radius due to size
										if (dist < blastRadius + 2.0) {
											const dir = new THREE.Vector3().subVectors(this.car.mesh.position, blastPos);
											dir.y = Math.max(0.5, dir.y + 1.0); // Cars should flip!
											dir.normalize();
											// Car is massive (e.g. 1500kg). It requires a massive impulse to move/flip.
											const force = 25000 * (1 - dist / (blastRadius + 2.0));
											this.car.body.applyImpulse(dir.multiplyScalar(force), true);
										}
									}

									// 3. Other Bombs Knockback (Chain Reactions!)
									for (const otherBomb of this.bombs) {
										if (otherBomb.id !== blastId && otherBomb.body && otherBomb.mesh.parent === this.worldGroup) {
											const dist = otherBomb.mesh.position.distanceTo(blastPos);
											if (dist < blastRadius) {
												const dir = new THREE.Vector3().subVectors(otherBomb.mesh.position, blastPos);
												dir.y = Math.max(0.5, dir.y + 1.0);
												dir.normalize();
												const force = 150 * (1 - dist / blastRadius);
												otherBomb.body.applyImpulse(dir.multiplyScalar(force), true);

												// Start their timer too! Chain reactions!
												otherBomb.isFlying = true;
												otherBomb.flightTime = 0;
											}
										}
									}
									// -------------------------

									// Reset bomb position after explosion
									const b = this.bombs.find(x => x.id === blastId);
									if (b && b.body) {
										const newPos = new THREE.Vector3(
											(Math.random() - 0.5) * 50,
											0,
											(Math.random() - 0.5) * 50
										);
										newPos.y = getWorldTerrainY(newPos.x, newPos.z) + 5.0;
										b.body.setTranslation(newPos, true);
										b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
										b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
									}
								}, 1000);
							} else {
								this.smokeSystem?.emit(bomb.mesh.position);
							}
						}
					}
				}
			}

			if (!this.sceneProps.mapMode) {
				if (this.activePlayer === "car") {
					updateChaseCamera(this.camera, this.car, this.chaseCameraInput, dt);
				} else {
					updateHumanCamera(this.camera, this.human, this.chaseCameraInput, dt);
				}
			}

			// Update car entry/exit UI prompt
			if (this.interactionPrompt) {
				if (this.activePlayer === "car") {
					// Hide while in car
					this.interactionPrompt.style.display = "none";
				} else {
					const distToCar = this.human.mesh.position.distanceTo(this.car.mesh.position);

					let nearestBombDist = Infinity;
					let holdingBomb = false;
					for (const bomb of this.bombs) {
						if (bomb.mesh.parent === this.worldGroup) { // Still on ground
							const d = this.human.mesh.position.distanceTo(bomb.mesh.position);
							if (d < nearestBombDist) nearestBombDist = d;
						} else {
							bomb.mesh.traverseAncestors(ancestor => {
								if (ancestor === this.human?.mesh) holdingBomb = true;
							});
						}
					}

					let nearestPlayerDist = Infinity;
					for (const [socketId, rp] of this.remotePlayers.entries()) {
						if (rp.loaded && rp.humanGroup && rp.humanGroup.visible) {
							const d = this.human.mesh.position.distanceTo(rp.humanGroup.position);
							if (d < nearestPlayerDist) nearestPlayerDist = d;
						}
					}

					if (distToCar < 3.0) {
						this.interactionPrompt.style.display = "flex";
						this.interactionPrompt.style.alignItems = "center";
						this.interactionPrompt.style.justifyContent = "center";
						this.interactionPrompt.textContent = "U";
					} else if (holdingBomb || nearestBombDist < 3.0) {
						this.interactionPrompt.style.display = "flex";
						this.interactionPrompt.style.alignItems = "center";
						this.interactionPrompt.style.justifyContent = "center";
						this.interactionPrompt.textContent = "T";
					} else if (this.humanInput.isCarryingPlayer || nearestPlayerDist < 2.5) {
						this.interactionPrompt.style.display = "flex";
						this.interactionPrompt.style.alignItems = "center";
						this.interactionPrompt.style.justifyContent = "center";
						this.interactionPrompt.textContent = "H";
					} else {
						this.interactionPrompt.style.display = "none";
					}
				}
			}

			// Leave the map → wait 2s → respawn
			if (playAllowed) {
				// Car respawn
				if (this.car && this.carController) {
					if (isCarOutsideWorld(this.car)) {
						this.carOutOfWorldTimer += dt;
						if (this.carOutOfWorldTimer >= 2) {
							let customSpawn: THREE.Vector3 | undefined = undefined;
							// If we are far enough along, respawn at the new world entrance
							if (this.car.mesh.position.z > 130 && this.proceduralBridge) {
								const finalHeight = this.proceduralBridge.getFinalHeight();
								const bridgeEndZ = this.proceduralBridge.getLastGeneratedZ();
								const bridgeEndX = this.proceduralBridge.getLastGeneratedX();
								customSpawn = new THREE.Vector3(bridgeEndX, finalHeight, bridgeEndZ + 2);
							}
							respawnCarAtStart(this.car, this.carController, customSpawn);
							this.carOutOfWorldTimer = 0;
						}
					} else {
						this.carOutOfWorldTimer = 0;
					}
				}

				// Human respawn
				if (this.human) {
					const ht = this.human.body.translation();
					const isOutside = ht.y < -120 || ht.y > 90;

					if (isOutside) {
						this.humanOutOfWorldTimer += dt;
						if (this.humanOutOfWorldTimer >= 2) {
							// Respawn human safely next to the car, or at center
							const spawnPos = this.car ? this.car.mesh.position.clone() : new THREE.Vector3(0, 0, 0);
							spawnPos.y += 3.0; // Drop from slightly above to avoid clipping
							this.human.body.setTranslation(spawnPos, true);
							this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
							this.humanOutOfWorldTimer = 0;
						}
					} else {
						this.humanOutOfWorldTimer = 0;
					}
				}
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
			if (this.worldGroup.visible) {
				this.fireflies.update(dt, this.frameFireflyIntensity, threat);
			}
		}

		if (this.smokeSystem) {
			this.smokeSystem.update(dt);
		}
		this.explosionSystem?.update(dt);

		// Multiplayer Synchronization Loop
		if (this.socket && this.socket.connected && this.roomCode && this.isGameActive) {
			const anyThis = this as any;
			if (!anyThis._lastNetTick || now - anyThis._lastNetTick > 50) { // ~20Hz
				anyThis._lastNetTick = now;
				const state: any = {
					activeEntity: this.activePlayer,
					speed: this.carController ? this.carController.getSpeed() : 0,
					throttle: this.carController ? this.carController.getThrottle() : 0
				};

				if (this.human) {
					const hp = this.human.mesh.position;
					const hq = this.human.mesh.quaternion;
					state.humanPosition = { x: hp.x, y: hp.y, z: hp.z };
					state.humanQuaternion = { x: hq.x, y: hq.y, z: hq.z, w: hq.w };
					state.animation = this.human.activeAnimationName;
				}

				if (this.car) {
					const cp = this.car.mesh.position;
					const cq = this.car.mesh.quaternion;
					state.carPosition = { x: cp.x, y: cp.y, z: cp.z };
					state.carQuaternion = { x: cq.x, y: cq.y, z: cq.z, w: cq.w };
				}

				this.socket.emit("player-state", { roomCode: this.roomCode, state });
			}
		}

		// Update remote player animations and interpolation
		for (const [id, rp] of this.remotePlayers.entries()) {
			if (!rp.loaded) continue;

			const lerpFactor = 10 * dt; // Smoothness factor

			if (rp.humanGroup && rp.humanGroup.visible) {
				let isCarriedByMe = false;
				if (this.humanInput && this.humanInput.isCarryingPlayer && this.humanInput.carriedPlayerId === id && this.human) {
					isCarriedByMe = true;
					// We are carrying this player! Snap them to our hands locally!
					const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.human.mesh.quaternion).normalize();
					const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(this.human.mesh.quaternion).normalize();
					
					const worldPos = new THREE.Vector3();
					this.human.mesh.getWorldPosition(worldPos);
					worldPos.addScaledVector(forward, 0.65); // Move forward into hands
					worldPos.addScaledVector(right, 0.7); // Move to the right side
					worldPos.y += 1.4; // Hands height
					
					rp.humanGroup.position.copy(worldPos);
					rp.humanGroup.quaternion.copy(this.human.mesh.quaternion);
				} else {
					rp.humanGroup.position.lerp(rp.targetHumanPosition, lerpFactor);
					rp.humanGroup.quaternion.slerp(rp.targetHumanQuaternion, lerpFactor);
				}
				
				if (rp.humanBody) {
					if (isCarriedByMe || rp.isBeingCarried) {
						// Move their physics body far away so it doesn't push us into the sky!
						rp.humanBody.setNextKinematicTranslation({ x: 0, y: -100, z: 0 });
					} else {
						rp.humanBody.setNextKinematicTranslation(rp.humanGroup.position);
						rp.humanBody.setNextKinematicRotation(rp.humanGroup.quaternion);
					}
				}
				if (rp.mixer) rp.mixer.update(dt);
			} else {
				if (rp.humanBody) {
					rp.humanBody.setNextKinematicTranslation({ x: 0, y: -100, z: 0 });
				}
			}

			if (rp.carGroup && rp.carGroup.visible) {
				rp.carGroup.position.lerp(rp.targetCarPosition, lerpFactor);
				rp.carGroup.quaternion.slerp(rp.targetCarQuaternion, lerpFactor);
				if (rp.carBody) {
					rp.carBody.setNextKinematicTranslation(rp.carGroup.position);
					rp.carBody.setNextKinematicRotation(rp.carGroup.quaternion);
				}
			} else {
				if (rp.carBody) {
					rp.carBody.setNextKinematicTranslation({ x: 0, y: -100, z: 0 });
				}
			}
		}

		this.renderer.render(this.scene, this.camera);
		this.stats.update();

		if (now - this.lastGpuPanelUpdate >= 250) {
			this.lastGpuPanelUpdate = now;
			const gpuPanel = document.getElementById("custom-gpu-panel");
			if (gpuPanel) {
				gpuPanel.innerHTML = `GPU LOAD<br/>Calls: ${this.renderer.info.render.calls}<br/>Tris: ${this.renderer.info.render.triangles}`;
			}
		}
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

	private setupSettings() {
		this.settings = new GameSettings({
			quality: "High",
			period: this.dayNightGui.period,
			autoDayNight: this.dayNightGui.auto,
			hour: this.dayNightGui.hour,
			grassDensity: this.grassDensity,
			carPower: CAR_CONFIG.drive.engineForce,
			world: this.currentWorld,
			onQualityChange: (quality) => this.applyGraphicsQuality(quality),
			onPeriodChange: (period) => {
				this.dayNight?.setPeriod(period);
				this.dayNightGui.period = period;
				this.dayNightGui.auto = false;
				this.settings.setAutoDayNight(false);
			},
			onAutoDayNightChange: (enabled) => {
				this.dayNightGui.auto = enabled;
				if (this.dayNight) this.dayNight.auto = enabled;
			},
			onHourChange: (hour) => {
				this.dayNightGui.hour = hour;
				this.dayNightGui.auto = false;
				this.dayNight?.setHour(hour);
				if (this.dayNight) this.dayNight.auto = false;
				this.settings.setAutoDayNight(false);
			},
			onGrassDensityChange: (percent) => this.setGrassDensity(percent),
			onCarPowerChange: (power) => {
				CAR_CONFIG.drive.engineForce = power;
			},
			onWorldChange: (world) => this.switchWorld(world),
		});
		this.applyGraphicsQuality(this.graphicsQuality);
	}

	private applyGraphicsQuality(quality: GraphicsQuality) {
		this.graphicsQuality = quality;
		const pixelRatio =
			quality === "Low" ? 0.75 : quality === "Medium" ? 1 : 2;
		const shadowsEnabled = quality !== "Low";
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatio));
		this.renderer.shadowMap.enabled = shadowsEnabled;
		this.renderer.shadowMap.autoUpdate = quality === "High";
		if (shadowsEnabled) this.renderer.shadowMap.needsUpdate = true;
		this.grassMaterial.updateGrassGraphicsChange(quality === "High");
		this.waterUpdateInterval =
			quality === "Low" ? 4 : quality === "Medium" ? 3 : 2;
		this.waterFrameCounter = 0;
		this.waterDeltaAccumulator = 0;
		this.resizePondTargets();
		if (this.volumetricFog) {
			this.volumetricFog.group.visible = quality !== "Low";
		}
	}

	private resizePondTargets() {
		if (!this.pond) return;
		const targetScale =
			this.graphicsQuality === "Low"
				? 0.4
				: this.graphicsQuality === "Medium"
					? 0.7
					: 1;
		const pixelRatio = this.renderer.getPixelRatio();
		const maxDimension =
			this.graphicsQuality === "Low"
				? 512
				: this.graphicsQuality === "Medium"
					? 768
					: 1024;
		this.pond.setSize(
			Math.min(
				maxDimension,
				Math.max(1, Math.floor(window.innerWidth * pixelRatio * targetScale))
			),
			Math.min(
				maxDimension,
				Math.max(1, Math.floor(window.innerHeight * pixelRatio * targetScale))
			)
		);
	}

	private isObjectVisible(object: THREE.Object3D) {
		this.camera.updateMatrixWorld();
		object.updateWorldMatrix(true, false);
		this.viewProjectionMatrix.multiplyMatrices(
			this.camera.projectionMatrix,
			this.camera.matrixWorldInverse
		);
		this.viewFrustum.setFromProjectionMatrix(this.viewProjectionMatrix);
		return this.viewFrustum.intersectsObject(object);
	}

	private setGrassDensity(percent: number) {
		this.grassDensity = THREE.MathUtils.clamp(percent, 0, 100);
		this.islandGrassField?.setDensity(this.grassDensity);
		this.valleyGrassField?.setDensity(this.grassDensity);
	}

	private setupInteractionUI() {
		this.interactionPrompt = document.createElement("div");
		this.interactionPrompt.style.position = "absolute";
		this.interactionPrompt.style.bottom = "20%";
		this.interactionPrompt.style.left = "50%";
		this.interactionPrompt.style.transform = "translateX(-50%)";
		this.interactionPrompt.style.width = "50px";
		this.interactionPrompt.style.height = "50px";
		this.interactionPrompt.style.backgroundColor = "rgba(0, 0, 0, 0.7)";
		this.interactionPrompt.style.color = "white";
		this.interactionPrompt.style.borderRadius = "12px";
		this.interactionPrompt.style.fontFamily = "sans-serif";
		this.interactionPrompt.style.fontWeight = "bold";
		this.interactionPrompt.style.fontSize = "24px";
		this.interactionPrompt.style.display = "none";
		this.interactionPrompt.style.pointerEvents = "auto"; // Make it clickable
		this.interactionPrompt.style.cursor = "pointer";
		this.interactionPrompt.style.zIndex = "1000";

		// Handle touch/click for mobile users
		this.interactionPrompt.addEventListener("click", () => {
			if (!this.isGameActive) return;
			if (this.interactionPrompt!.textContent === "U") {
				this.tryTogglePlayer();
			} else if (this.interactionPrompt!.textContent === "T") {
				if (this.humanInput) {
					this.humanInput.triggerPickup();
				}
			}
		});

		document.body.appendChild(this.interactionPrompt);
	}

	private setupStats() {
		this.stats.init(this.renderer);
		const statsDom = (this.stats as unknown as { dom: HTMLElement }).dom;

		statsDom.style.position = "fixed";
		statsDom.style.bottom = "45px";
		statsDom.style.right = "10px";
		statsDom.style.left = "auto";
		statsDom.style.top = "auto";

		// Use flexbox to line them up side-by-side
		statsDom.style.display = "flex";
		statsDom.style.flexDirection = "row";
		statsDom.style.gap = "5px";
		statsDom.style.zIndex = "10000";

		// Force all internal panels to be visible instead of just one
		setTimeout(() => {
			for (let i = 0; i < statsDom.children.length; i++) {
				const child = statsDom.children[i] as HTMLElement;
				child.style.display = "block";
				child.style.position = "relative";
			}

			// Some browsers block GPU timer queries, causing stats-gl to hide the GPU panel.
			// We inject a custom GPU panel that reads raw Three.js WebGL draw calls and triangles.
			const customGpuPanel = document.createElement("div");
			customGpuPanel.id = "custom-gpu-panel";
			customGpuPanel.style.backgroundColor = "#000000";
			customGpuPanel.style.color = "#ff00ff";
			customGpuPanel.style.fontFamily = "Helvetica, Arial, sans-serif";
			customGpuPanel.style.fontSize = "10px";
			customGpuPanel.style.fontWeight = "bold";
			customGpuPanel.style.padding = "2px 0 0 4px";
			customGpuPanel.style.width = "80px";
			customGpuPanel.style.height = "48px";
			customGpuPanel.style.boxSizing = "border-box";
			customGpuPanel.innerHTML = "GPU LOAD<br/>Calls: 0<br/>Tris: 0";
			statsDom.appendChild(customGpuPanel);
		}, 100); // small delay to ensure stats-gl has created the children

		document.body.appendChild(statsDom);
	}

	private setupEventListeners() {
		window.addEventListener("resize", () => this.setAspectResolution(), false);

		const statsDom = (this.stats as unknown as { dom: HTMLElement }).dom;
		statsDom.addEventListener("click", () => {
			console.log(this.renderer.info.render);
		});

		window.addEventListener("keydown", (e) => {
			if (!this.isGameActive) return;
			if (e.key.toLowerCase() === "u") {
				this.tryTogglePlayer();
			}
		});
	}

	private tryTogglePlayer() {
		if (!this.car || !this.human) return;

		if (this.activePlayer === "car") {
			// Switch to human (can exit car anytime)
			this.activePlayer = "human";
			const spawnPos = this.car.mesh.position.clone();
			spawnPos.x += 3;
			spawnPos.y += 1;
			this.human.body.setTranslation(spawnPos, true);
			this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			this.human.mesh.visible = true;
		} else {
			// Switch to car (must be near car)
			const distToCar = this.human.mesh.position.distanceTo(this.car.mesh.position);
			if (distToCar > 3.0) return; // Too far from car

			this.activePlayer = "car";
			this.human.body.setTranslation(new THREE.Vector3(0, -100, 0), true);
			this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			this.human.mesh.visible = false;
		}
	}

	private async switchWorld(target: GameWorldId) {
		if (target === this.currentWorld || this.isWorldSwitching) return;

		const previous = this.currentWorld;
		const targetName = target === "island" ? "Island" : "Valley";
		this.isWorldSwitching = true;
		this.worldLoading.show(targetName);

		try {
			this.worldLoading.setProgress(15, "Generating terrain and physics...");
			await this.nextFrame();

			if (target === "island") {
				await this.buildIslandWorld();
				this.worldGroup.visible = true;
			} else {
				this.createValleyTerrain(0, 0, 0);
				this.newWorldGroup.visible = true;
			}
			if (previous === "island") {
				this.worldGroup.visible = false;
			} else {
				this.newWorldGroup.visible = false;
			}

			this.worldLoading.setProgress(65, "Compiling world graphics...");
			await this.renderer.compileAsync(this.scene, this.camera);
			await this.nextFrame();

			this.worldLoading.setProgress(82, "Placing player safely...");
			this.teleportPlayerToCurrentTerrain(target);

			this.currentWorld = target;
			this.worldGroup.visible = target === "island";
			this.newWorldGroup.visible = target === "valley";
			this.applyWorldEnvironment(target);

			this.worldLoading.setProgress(92, "Unloading previous world...");
			await this.nextFrame();
			if (previous === "island") {
				this.disposeIslandWorld();
			} else {
				this.disposeValleyWorld();
			}
			this.renderer.renderLists.dispose();

			this.settings.setWorld(target);
			this.worldLoading.setProgress(100, "Ready");
			await this.nextFrame();
			this.worldLoading.hide();
		} catch (error) {
			if (target === "island") this.disposeIslandWorld();
			else this.disposeValleyWorld();

			this.currentWorld = previous;
			this.worldGroup.visible = previous === "island";
			this.newWorldGroup.visible = previous === "valley";
			this.settings.setWorld(previous);
			const message = error instanceof Error ? error.message : "Unable to load world.";
			this.worldLoading.showError(message);
			throw error;
		} finally {
			this.isWorldSwitching = false;
		}
	}

	private teleportPlayerToCurrentTerrain(target: GameWorldId) {
		const x = 0;
		const z = target === "island" ? 0 : this.valleySpawn.z;
		const groundY = getWorldTerrainY(x, z);

		if (this.car) {
			this.car.body.setTranslation(
				{ x, y: groundY + CAR_CONFIG.spawn.clearance, z },
				true
			);
			this.car.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
			this.car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			this.car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
			this.carController?.resetDriveState();
		}

		if (this.human) {
			this.human.body.setTranslation({ x: x + 3, y: groundY + 3, z }, true);
			this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
		}
	}

	private applyWorldEnvironment(world: GameWorldId) {
		const sky = this.scene.getObjectByName("sky-dome");
		if (world === "island") {
			this.grassMaterial.setTerrainSize(TERRAIN_CONFIG.size);
			if (this.dayNight) {
				this.dayNight.overrideColors = false;
				this.dayNight.setHour(this.dayNightGui.hour);
			}
			if (sky) sky.visible = true;
			this.currentFogRadius = 65;
			this.grassMaterial.uniforms.baseColor.value.set("#313f1b");
			this.grassMaterial.uniforms.tipColor1.value.set("#5e875e");
			this.grassMaterial.uniforms.tipColor2.value.set("#1f352a");
		} else {
			this.grassMaterial.setTerrainSize(200);
			if (this.dayNight) this.dayNight.overrideColors = true;
			if (sky) sky.visible = false;
			const color = new THREE.Color(0x1e2b2f);
			this.scene.background = color.clone();
			if (this.scene.fog instanceof THREE.FogExp2) {
				this.scene.fog.color.copy(color);
				this.scene.fog.density = 0.005;
			}
			this.currentFogRadius = 250;
			this.grassMaterial.uniforms.baseColor.value.set(0x3e524e);
			this.grassMaterial.uniforms.tipColor1.value.set(0x799894);
			this.grassMaterial.uniforms.tipColor2.value.set(0x56726e);
		}
	}

	private disposeIslandWorld() {
		this.pond?.mesh.removeFromParent();
		this.pond?.dispose();
		this.pond = undefined;

		this.pondStones?.dispose();
		this.pondStones = null;
		this.islandGrassField?.dispose();
		this.islandGrassField = null;

		for (const tree of this.trees) tree.dispose();
		this.trees = [];
		this.fireflies?.dispose();
		this.fireflies = null;
		this.disposeBombs();

		this.islandTerrainHandle?.dispose();
		this.islandTerrainHandle = null;
		this.proceduralBridge?.dispose();
		this.proceduralBridge?.group.removeFromParent();
		this.proceduralBridge = null;

		this.disposeWorldGroup(this.worldGroup);
	}

	private disposeValleyWorld() {
		this.valleyGrassField?.dispose();
		this.valleyGrassField = null;
		if (this.valleyTerrainBody) {
			getWorld().removeRigidBody(this.valleyTerrainBody);
			this.valleyTerrainBody = null;
		}
		this.disposeWorldGroup(this.newWorldGroup);
	}

	private disposeWorldGroup(group: THREE.Group) {
		group.traverse((object) => {
			if (!(object instanceof THREE.Mesh || object instanceof THREE.Points)) return;
			if (
				object instanceof THREE.InstancedMesh &&
				(object.name === "Grass" || object.name === "GrassChunk")
			) {
				object.dispose();
				return;
			}

			if (object.geometry !== this.grassGeometry) object.geometry.dispose();
			const materials = Array.isArray(object.material)
				? object.material
				: [object.material];
			for (const material of materials) {
				if (material !== this.grassMaterial.material && material !== this.terrainMat) {
					material.dispose();
				}
			}
		});
		group.clear();
	}

	private disposeBombs() {
		const geometries = new Set<THREE.BufferGeometry>();
		const materials = new Set<THREE.Material>();
		for (const bomb of this.bombs) {
			if (bomb.body) getWorld().removeRigidBody(bomb.body);
			bomb.mesh.removeFromParent();
			bomb.mesh.traverse((object) => {
				if (!(object instanceof THREE.Mesh)) return;
				geometries.add(object.geometry);
				const meshMaterials = Array.isArray(object.material)
					? object.material
					: [object.material];
				for (const material of meshMaterials) materials.add(material);
			});
		}
		for (const geometry of geometries) geometry.dispose();
		for (const material of materials) material.dispose();
		this.bombs = [];
	}

	private nextFrame(): Promise<void> {
		return new Promise((resolve) => window.setTimeout(resolve, 0));
	}

	private createValleyTerrain(bridgeEndX: number, bridgeEndHeight: number, bridgeEndZ: number) {
		const width = 200;
		const depth = 200;
		const resolution = 256;
		const geometry = new THREE.PlaneGeometry(width, depth, resolution, resolution);
		geometry.rotateX(-Math.PI / 2); // Flat on the ground

		const posAttr = geometry.attributes.position;

		// We want the terrain to start exactly 1 meter before the bridge ends, so the bridge overlaps the terrain by 1 meter.
		const terrainStartZ = bridgeEndZ - 1;
		const centerZ = terrainStartZ + (depth / 2);
		const centerX = bridgeEndX;

		for (let i = 0; i < posAttr.count; i++) {
			const vx = posAttr.getX(i);
			const vz = posAttr.getZ(i);

			// Distance from center
			const d = Math.sqrt(vx * vx + vz * vz);

			// Angle from center — used to make each side different
			const angle = Math.atan2(vz, vx);

			// Asymmetric depth: each compass direction gets a different max depth
			const depthVariation = 0.4 + 0.6 * (
				0.5 + 0.2 * Math.sin(angle * 1.0)
				+ 0.15 * Math.sin(angle * 2.3 + 1.7)
				+ 0.1 * Math.sin(angle * 3.7 + 0.5)
				+ 0.05 * Math.cos(angle * 5.1 + 2.3)
			);
			const localMaxDepth = 100 * depthVariation;

			// Asymmetric rim distance
			const rimVariation = 63 + 7 * Math.sin(angle * 2.0 + 0.8) + 5 * Math.cos(angle * 3.5);

			// Normalized distance from center to rim
			let nd = Math.min(d / rimVariation, 1.0);

			// GENTLE slope — sqrt gives a gradual descent from the rim that you can drive on
			// nd=1 (rim) → h=1, nd=0.8 → h=0.89, nd=0.5 → h=0.71, nd=0 → h=0
			let h = Math.sqrt(nd);

			// Add organic bumps/ledges along the slope
			const bump1 = Math.sin(nd * 4.0 * Math.PI + angle * 1.5) * 0.06;
			const bump2 = Math.sin(nd * 7.0 * Math.PI + angle * 2.7 + 1.0) * 0.03;
			h = Math.max(0, Math.min(1, h + bump1 + bump2));

			// Keep the outer 5m as a flat plateau for the bridge connection
			if (d > rimVariation) {
				h = 1.0;
			}

			// Height: h=1 is bridge level, h=0 is bottom
			let y = h * localMaxDepth + (bridgeEndHeight - localMaxDepth);

			// ---- Moon-like crater surface ----
			// Multiple overlapping crater depressions
			const craterSeeds = [
				{ cx: 15, cz: 20, r: 12 },
				{ cx: -25, cz: 10, r: 18 },
				{ cx: 5, cz: -30, r: 10 },
				{ cx: -10, cz: -15, r: 14 },
				{ cx: 30, cz: -5, r: 8 },
				{ cx: -35, cz: -25, r: 15 },
				{ cx: 20, cz: -35, r: 11 },
				{ cx: -5, cz: 35, r: 9 },
				{ cx: 40, cz: 25, r: 13 },
				{ cx: -40, cz: 5, r: 10 },
				{ cx: 0, cz: 0, r: 16 },
				{ cx: -20, cz: 40, r: 12 },
			];

			for (const cr of craterSeeds) {
				const cd = Math.sqrt((vx - cr.cx) * (vx - cr.cx) + (vz - cr.cz) * (vz - cr.cz));
				if (cd < cr.r) {
					// Smooth crater shape: deepest at center, raised rim
					const t = cd / cr.r; // 0 at center, 1 at edge
					// Crater profile: dip down then slight raised rim
					const craterDepth = (1 - t * t) * 4.0; // max 4m deep
					const rimBump = Math.exp(-((t - 0.85) * (t - 0.85)) * 50) * 1.5; // raised rim
					y -= craterDepth;
					y += rimBump;
				}
			}

			// Rough, bumpy noise — multi-frequency for a patchy moon-like look
			const n1 = Math.sin(vx * 0.3 + vz * 0.2) * Math.cos(vz * 0.25 - vx * 0.15) * 2.0;
			const n2 = Math.sin(vx * 0.7 + 1.3) * Math.cos(vz * 0.6 + 0.7) * 1.0;
			const n3 = Math.sin(vx * 1.5 + vz * 1.2) * 0.4; // fine grain roughness
			const n4 = Math.cos(vx * 0.12 - vz * 0.18) * Math.sin(vz * 0.15 + vx * 0.1) * 3.0; // big undulations

			// Fade noise near the rim to keep the bridge connection flat
			const noiseFade = Math.min(1.0, Math.max(0, 1.0 - nd) * 3.0); // full noise inside, fades to 0 at rim
			y += (n1 + n2 + n3 + n4) * noiseFade;

			posAttr.setY(i, y);
		}
		geometry.computeVertexNormals();

		const material = new THREE.MeshPhongMaterial({
			color: 0x799894, // Pale desaturated teal
			shininess: 0,
			flatShading: true,
			side: THREE.DoubleSide
		});

		const newTerrain = new THREE.Mesh(geometry, material);
		newTerrain.position.set(centerX, 0, centerZ);
		newTerrain.receiveShadow = true;
		this.newWorldGroup.add(newTerrain);
		newTerrain.updateMatrixWorld(true);
		setIslandTerrain(newTerrain);
		this.valleySpawn.set(centerX, bridgeEndHeight + 4, bridgeEndZ + 5);

		// Add grass to the new world! (shorter grass: 0.3x height, clustered)
		this.valleyGrassField = this.addGrass(
			newTerrain,
			this.grassGeometry,
			this.newWorldGroup,
			new THREE.Vector2(0, 0),
			0.3,
			true
		);

		// Physics Heightfield
		const heights = new Float32Array((resolution + 1) * (resolution + 1));
		for (let i = 0; i < posAttr.count; i++) {
			const col = i % (resolution + 1);
			const row = Math.floor(i / (resolution + 1));
			heights[col * (resolution + 1) + row] = posAttr.getY(i);
		}

		const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(centerX, 0, centerZ);
		const body = getWorld().createRigidBody(bodyDesc);
		this.valleyTerrainBody = body;
		const colliderDesc = RAPIER.ColliderDesc.heightfield(
			resolution, resolution, heights,
			{ x: width, y: 1.0, z: depth }
		);
		getWorld().createCollider(colliderDesc, body);

		// The Pond (flat water plane at the bottom — no cylinder sides poking through)
		const pondGeometry = new THREE.CircleGeometry(18, 32);
		pondGeometry.rotateX(-Math.PI / 2);
		const pondMaterial = new THREE.MeshPhongMaterial({
			color: 0x1a262a, // Dark moody water
			transparent: true,
			opacity: 0.9,
			shininess: 100,
			side: THREE.DoubleSide
		});
		const pondMesh = new THREE.Mesh(pondGeometry, pondMaterial);
		pondMesh.position.set(centerX, bridgeEndHeight - 98, centerZ);
		this.newWorldGroup.add(pondMesh);
	}

	private setAspectResolution() {
		this.camera.aspect = window.innerWidth / window.innerHeight;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(window.innerWidth, window.innerHeight);
		this.resizePondTargets();
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
