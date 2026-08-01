import * as THREE from "three";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

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
import { setIslandTerrain, getWorldTerrainY, findSafeTerrainSpawn, isOutsideTerrain } from "./terrain/islandHeight";
import { createLargeTerrain, TERRAIN_CONFIG } from "./terrain/createLargeTerrain";
import { Pond, REFERENCE_WATER_LOOK } from "./entities/water";
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
import { VehicleGrapple } from "./entities/car/vehicleGrapple";
import { updateChaseCamera, updateHumanCamera } from "./three/chaseCamera";
import { ChaseCameraInput } from "./three/chaseCameraInput";
import { HumanEntity, findCombatBones, hitReactionAnimName, stripRootMotion, type CombatBones, type HitReaction } from "./entities/human/HumanEntity";
import { HumanInput } from "./entities/human/HumanInput";
import { BulletSystem } from "./entities/human/BulletSystem";
import {
	BLAST_KILL_RADIUS,
	PLAYER_MAX_HP,
	damageForPart,
	type DeathCause,
	type GunHitPart,
} from "./entities/human/playerCombat";
import {
	createTree,
	updateFoliageWind,
	type TreeHandle,
} from "./entities/tree";
import {
	createPondStones,
	type PondStoneHandle,
	type PlacedStoneHandle,
} from "./entities/stone";
import {
	placeScenicProp,
	type ScenicPropHandle,
} from "./entities/props";
import { GrassChunkField, DEFAULT_GRASS_CULL_DISTANCE } from "./entities/grass";
import { EditModeController } from "./editor/EditModeController";
import {
	createLargeBlankWorld,
	createProceduralTerrain,
	grassCountForSize,
	ISLAND_GRASS_DENSITY,
	ISLAND_WORLD,
	paintTerrainMudShore,
	VALLEY_WORLD,
	type WorldDefinition,
} from "./worlds";
import type { WorldListItem } from "./editor/WorldEditApi";
import { purgeLegacyWorldStorage } from "./editor/WorldEditStore";
import {
	createDayNightCycle,
	type DayNightCycle,
	type DayPeriod,
} from "./environment/dayNightCycle";
import { createFireflies, type Fireflies } from "./environment/fireflies";
import {
	createLampFireflyGlow,
	type LampFireflyGlow,
} from "./environment/lampFireflyGlow";
import { VolumetricFogSystem } from "./environment/VolumetricFogSystem";
import {
	VolumetricFogPass,
	PLAYER_FOG_BAND,
	PLAYER_FOG_RADIUS,
	fogDensityForWorld,
	fogDensityScaleForHour,
	fogFollowsPlayer,
	fogRadiusForWorld,
} from "./environment/VolumetricFogPass";
import { SmokeTrailSystem } from "./environment/smokeTrail";
import { ExplosionSystem } from "./environment/ExplosionSystem";
import { BombSound } from "./audio/BombSound";
import { HornSound } from "./audio/HornSound";
import { ProceduralBridge } from "./environment/ProceduralBridge";
import {
	createMobileControls,
	isMobileDevice,
	type MobileControls,
} from "./ui/mobileControls";
import {
	isGameKeyBlocked,
	isKeyboardCapturedByUi,
	isTextEntryFocused,
	isTextEntryTarget,
} from "./ui/gameInputFocus";
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
import { HealthHud } from "./ui/HealthHud";

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
	combatBones?: CombatBones;
	targetHumanPosition: THREE.Vector3;
	targetHumanQuaternion: THREE.Quaternion;
	targetCarPosition: THREE.Vector3;
	targetCarQuaternion: THREE.Quaternion;
	isBeingCarried?: boolean;
	isCarryingPlayer?: boolean;
	/** Occupied island bench seat (0 | 1), or null if not sitting. */
	benchSeat?: 0 | 1 | null;
	hp?: number;
	dead?: boolean;
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
	/** Prevent double-detonation (bullet + land fuse, chain, etc.). */
	private readonly detonatingBombIds = new Set<number>();
	private readonly _bombWorldPos = new THREE.Vector3();

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
	private grassCullDistance = DEFAULT_GRASS_CULL_DISTANCE;
	private islandGrassField: GrassChunkField | null = null;
	private valleyGrassField: GrassChunkField | null = null;
	private customGrassField: GrassChunkField | null = null;
	private customWorldGroup = new THREE.Group();
	private customTerrainMesh: THREE.Mesh | null = null;
	private customHeights: Float32Array | null = null;
	private customTerrainHandle: TerrainColliderHandle | null = null;
	private activeWorldDef: WorldDefinition = ISLAND_WORLD;
	/** Custom world defs known this session (created here or fetched from the DB). */
	private customWorldDefs: WorldDefinition[] = [];
	/** Last GET /api/worlds?mine=1 result — the source of truth for the picker. */
	private savedWorldList: WorldListItem[] = [];
	private graphicsQuality: GraphicsQuality = "High";
	private waterUpdateInterval = 1;
	private waterFrameCounter = 0;
	private waterDeltaAccumulator = 0;
	private renderFrameCounter = 0;
	private lastGpuPanelUpdate = 0;
	private lastSettingsSync = 0;
	private lastRippleInjection = 0;
	private lastEditorRippleInjection = 0;
	/** Next time (ms) to drop a soft ambient ripple on some pond. */
	private nextAmbientRippleAt = 0;
	private editorWaterDeltaAccumulator = 0;
	private editorWaterFrameCounter = 0;
	private readonly viewFrustum = new THREE.Frustum();
	private readonly viewProjectionMatrix = new THREE.Matrix4();

	private car: CarEntity | null = null;
	private carInput: CarInput | null = null;
	private carController: CarController | null = null;
	private vehicleGrapple: VehicleGrapple | null = null;
	private chaseCameraInput: ChaseCameraInput | null = null;
	private engineSound: EngineSound | null = null;
	private carOutOfWorldTimer = 0;
	private humanOutOfWorldTimer = 0;

	private audioListener: THREE.AudioListener | null = null;

	private activePlayer: "car" | "human" = "car";
	private human: HumanEntity | null = null;
	private humanInput: HumanInput | null = null;
	/** Held firearm mesh — lives in the scene, snapped to the right hand each frame. */
	private gunMesh: THREE.Object3D | null = null;
	private bulletSystem: BulletSystem | null = null;
	private localHp = PLAYER_MAX_HP;
	private localDead = false;
	private deathTimer = 0;
	private deathCause: DeathCause | null = null;
	private healthHud: HealthHud | null = null;
	private readonly gunHandPos = new THREE.Vector3();
	private readonly gunHandQuat = new THREE.Quaternion();
	private readonly gunWorldOffset = new THREE.Vector3();
	private readonly gunMuzzleWorld = new THREE.Vector3();
	private readonly gunMuzzleLocal = new THREE.Vector3(0.02, 0.05, 0.42);
	private readonly gunOffsetPos = new THREE.Vector3(0.05, 0.02, 0.08);
	private readonly gunOffsetQuat = new THREE.Quaternion().setFromEuler(
		new THREE.Euler(-Math.PI * 0.5, Math.PI, 0.2)
	);
	private readonly _shotOrigin = new THREE.Vector3();
	private readonly _shotDir = new THREE.Vector3();
	private readonly _shotAim = new THREE.Vector3();
	private readonly _shotClosest = new THREE.Vector3();
	private readonly _shotTo = new THREE.Vector3();
	/** Dedupe networked hit tracers (attacker->victim). */
	private readonly recentGunFxAt = new Map<string, number>();
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
	private editorStones: PlacedStoneHandle[] = [];
	private editorPonds: Pond[] = [];
	private islandScenicProps: ScenicPropHandle[] = [];
	private lampFireflyGlow: LampFireflyGlow | null = null;
	/** Island bench: two seats along the plank. */
	private benchInteract: {
		seats: [THREE.Vector3, THREE.Vector3];
		yaw: number;
	} | null = null;
	private sitState: "none" | "entering" | "sitting" | "exiting" = "none";
	private sitTimer = 0;
	/** Which seat we occupy (0 = left, 1 = right). */
	private sitSeatIndex: 0 | 1 | null = null;
	private islandTerrainMesh: THREE.Mesh | null = null;
	private islandHeights: Float32Array | null = null;
	private editMode: EditModeController | null = null;
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
	private valleyTerrainMesh: THREE.Mesh | null = null;
	private valleyHeights: Float32Array | null = null;
	private valleySpawn = new THREE.Vector3(0, 4, 5);
	private initializationPromise: Promise<void>;
	private currentFogRadius = 65;
	private volumetricFogDensity = 0.022;
	private fogFollowPlayer = false;
	private volumetricFog: VolumetricFogSystem | null = null;
	private volumetricFogPass: VolumetricFogPass | null = null;
	/** Residual FogExp2 while the screen-space pass does the heavy lifting. */
	private residualFogDensity = 0.0008;
	/** Full FogExp2 density to restore when the volumetric pass is off. */
	private atmosphereFogDensity = 0.012;
	private readonly _fogCenter = new THREE.Vector3();
	private readonly _fogColorTmp = new THREE.Color();
	/** Snapshot while edit/map mode disables fog so top view stays readable. */
	private editFogBackup: {
		density: number;
		bg: THREE.Color;
		volVisible: boolean;
		passEnabled: boolean;
	} | null = null;
	/** Day/night state while editing — editor uses fixed noon; peers keep their own cycle. */
	private editDayNightBackup: { auto: boolean; hour: number } | null = null;
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
		this.scene.add(this.customWorldGroup);
		this.newWorldGroup.visible = false;
		this.customWorldGroup.visible = false;
		purgeLegacyWorldStorage();

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

		this.volumetricFogPass = new VolumetricFogPass();
		this.volumetricFogPass.setSize(
			window.innerWidth * this.renderer.getPixelRatio(),
			window.innerHeight * this.renderer.getPixelRatio()
		);
		this.volumetricFogPass.setQuality(this.graphicsQuality);

		this.grassMaterial = new GrassMaterial();
		this.terrainMat = new THREE.MeshPhongMaterial({
			color: this.sceneProps.terrainColor,
			shininess: 0,
			flatShading: true,
			vertexColors: false,
			// Dug basin cliffs face inward — DoubleSide keeps walls solid from outside.
			side: THREE.DoubleSide,
		});

		this.setupStats();
		this.setupTextures();
		this.setupEventListeners();
		this.setupInteractionUI();
		this.healthHud = new HealthHud();
		this.orientationGate = createOrientationGate();
		this.dayNight = createDayNightCycle(this.scene, { shadowExtent: 90 });
		this.dayNight.auto = this.dayNightGui.auto;
		this.worldLoading = new WorldLoadingOverlay();
		this.setupSettings();
		this.setupEditMode();

		this.dayNight.speed = this.dayNightGui.speed;

		this.smokeSystem = new SmokeTrailSystem();
		this.scene.add(this.smokeSystem.mesh);

		this.explosionSystem = new ExplosionSystem();
		this.scene.add(this.explosionSystem.mesh);

		this.bulletSystem = new BulletSystem();
		this.scene.add(this.bulletSystem.group);
		this.bulletSystem.getGroundY = (x, z) => getWorldTerrainY(x, z);

		this.initializationPromise = (async () => {
			await initPhysics();
			await this.buildIslandWorld();
			await this.setupCar();
			await this.setupHuman();

			// Billboard fog kept only as a Low-quality fallback (hidden when the
			// screen-space volumetric pass is active).
			this.volumetricFog = new VolumetricFogSystem(180);
			this.volumetricFog.group.visible = false;
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
				this.healthHud?.setVisible(true);
				this.healthHud?.setHp(this.localHp);
				if (this.carInput) this.carInput.isEnabled = this.activePlayer === "car";
				if (this.humanInput) {
					this.humanInput.isEnabled = this.activePlayer === "human";
				}
				this.gameNavigation?.show();
				this.editMode?.onGameActiveChanged(true);
				void this.tryOpenSharedWorldFromUrl();
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
					this.editMode?.onAuthChanged();
					void this.refreshSavedWorldList();
				},
				onHost: () => this.connectSocket("host"),
				onJoin: () => this.fetchRooms(),
				onLogout: () => this.disconnectMultiplayer(),
			});
			this.gameNavigation.initialize();

			const restoredUser = await this.authService.restoreSession();
			this.userData = restoredUser;
			this.gameNavigation.setUser(restoredUser);
			void this.refreshSavedWorldList();

			this.loadingScreenController = new LoadingScreenController({
				auth: this.authService,
				onPlay: () => proceed("play", this.userData),
				onAccountCreated: (user) => {
					this.userData = user;
					this.gameNavigation?.setUser(user);
					this.editMode?.onAuthChanged();
					void this.refreshSavedWorldList();
				},
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
		this.socket = io(SERVER_URL, {
			transports: ["websocket"],
			upgrade: false
		});
		this.editMode?.attachSocket(this.socket);

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

		this.socket.on("player-hit", (data: any) => {
			const { targetSocketId, hitZone } = data;
			const reaction: HitReaction =
				hitZone === "uppercut" || hitZone === "sweep" || hitZone === "side"
					? hitZone
					: hitZone === "head"
						? "uppercut"
						: "side";
			const animName = hitReactionAnimName(reaction);

			// Local player was hit — play reaction (syncs out via player-state)
			if (targetSocketId === this.socket?.id) {
				if (this.localDead) return;
				this.humanInput?.applyHitReaction(reaction);
				return;
			}

			// Eagerly play on the remote victim for snappier feedback
			const rp = this.remotePlayers.get(targetSocketId);
			if (!rp?.loaded || !rp.animations || rp.dead) return;
			const action = [...rp.animations.entries()].find(
				([name]) => name === animName || name.includes(animName)
			)?.[1];
			if (!action) return;
			if (rp.currentAction !== action) {
				if (rp.currentAction) rp.currentAction.fadeOut(0.15);
				action.reset().setLoop(THREE.LoopOnce, 1);
				action.clampWhenFinished = true;
				action.fadeIn(0.15).play();
				rp.currentAction = action;
			}
		});

		this.socket.on("player-damage", (data: any) => {
			const { targetSocketId, part, damage, socketId: attackerId } = data;
			const hitPart: GunHitPart = part === "head" ? "head" : "body";
			const dmg =
				typeof damage === "number" ? damage : damageForPart(hitPart);

			if (targetSocketId === this.socket?.id) {
				this.applyLocalDamage(hitPart, dmg, attackerId);
			} else {
				// Optimistic remote HP (no flinch anim on gun hits)
				const rp = this.remotePlayers.get(targetSocketId);
				if (rp && !rp.dead) {
					rp.hp = Math.max(0, (rp.hp ?? PLAYER_MAX_HP) - dmg);
				}
			}

			// Every client sees a tracer into the victim's local body (matches HP sync)
			if (attackerId && targetSocketId) {
				this.spawnSyncedHitTracer(attackerId, targetSocketId, hitPart);
			}
		});

		this.socket.on("player-died", (data: any) => {
			const { socketId, cause, position, animation } = data;
			if (socketId === this.socket?.id) return;
			const rp = this.remotePlayers.get(socketId);
			if (!rp?.loaded || !rp.humanGroup) return;
			rp.dead = true;
			rp.hp = 0;
			if (position) {
				rp.targetHumanPosition.set(position.x, position.y, position.z);
				rp.humanGroup.position.copy(rp.targetHumanPosition);
			}
			const anim =
				animation ||
				(cause === "bomb" ? "fall down" : "dying");
			if (rp.animations) {
				const action = [...rp.animations.entries()].find(
					([name]) => name === anim || name.includes(anim)
				)?.[1];
				if (action) {
					if (rp.currentAction) rp.currentAction.fadeOut(0.1);
					action.reset().setLoop(THREE.LoopOnce, 1);
					action.clampWhenFinished = true;
					action.fadeIn(0.1).play();
					rp.currentAction = action;
				}
			}
		});

		this.socket.on("player-respawned", (data: any) => {
			const { socketId, position, hp } = data;
			if (socketId === this.socket?.id) return;
			const rp = this.remotePlayers.get(socketId);
			if (!rp?.loaded || !rp.humanGroup || !position) return;
			rp.dead = false;
			rp.hp = typeof hp === "number" ? hp : PLAYER_MAX_HP;
			rp.targetHumanPosition.set(position.x, position.y, position.z);
			rp.humanGroup.position.copy(rp.targetHumanPosition);
			if (rp.humanBody) {
				rp.humanBody.setNextKinematicTranslation({
					x: position.x,
					y: position.y + HumanEntity.MESH_Y_OFFSET,
					z: position.z,
				});
			}
			if (rp.animations?.has("idle")) {
				const idle = rp.animations.get("idle")!;
				if (rp.currentAction) rp.currentAction.fadeOut(0.15);
				idle.reset().fadeIn(0.15).play();
				rp.currentAction = idle;
			}
		});

		this.socket.on("bomb-blast", (data: any) => {
			const { bombId, position, socketId } = data;
			if (socketId === this.socket?.id) return; // we already detonated locally
			if (typeof bombId === "number" && this.detonatingBombIds.has(bombId)) {
				return;
			}
			const blastPos = new THREE.Vector3(
				position.x,
				position.y,
				position.z
			);
			this.applyRemoteBombBlast(bombId, blastPos);
		});

		this.socket.on("gun-shot", (data: any) => {
			const { socketId, origin, direction, targetId } = data;
			if (socketId === this.socket?.id) return;
			if (!origin || !direction || !this.bulletSystem) return;
			const ox = Number(origin.x);
			const oy = Number(origin.y);
			const oz = Number(origin.z);
			const dx = Number(direction.x);
			const dy = Number(direction.y);
			const dz = Number(direction.z);
			if (![ox, oy, oz, dx, dy, dz].every((n) => Number.isFinite(n))) return;

			this._shotOrigin.set(ox, oy, oz);
			this._shotDir.set(dx, dy, dz).normalize();
			this.spawnRemoteGunTracer(
				socketId,
				this._shotOrigin,
				this._shotDir,
				typeof targetId === "string" ? targetId : null
			);
		});

		this.socket.on("player-reposition", (data: any) => {
			const { socketId, position, quaternion, animation } = data;
			if (socketId === this.socket?.id) return;
			const rp = this.remotePlayers.get(socketId);
			if (!rp?.loaded || !rp.humanGroup || !position) return;

			// Snap remote to baked post-hit position (skip lerp lag)
			rp.targetHumanPosition.set(position.x, position.y, position.z);
			rp.humanGroup.position.set(position.x, position.y, position.z);
			if (quaternion) {
				rp.targetHumanQuaternion.set(
					quaternion.x,
					quaternion.y,
					quaternion.z,
					quaternion.w
				);
				rp.humanGroup.quaternion.copy(rp.targetHumanQuaternion);
			}
			if (rp.humanBody) {
				rp.humanBody.setNextKinematicTranslation(rp.humanGroup.position);
				rp.humanBody.setNextKinematicRotation(rp.humanGroup.quaternion);
			}

			if (animation && rp.animations) {
				const action = [...rp.animations.entries()].find(
					([name]) => name === animation || name.includes(animation)
				)?.[1];
				if (action && rp.currentAction !== action) {
					if (rp.currentAction) rp.currentAction.fadeOut(0.15);
					const once =
						animation.includes("sit to stand") ||
						animation.includes("sweep") ||
						animation.includes("uppercut") ||
						animation.includes("hit on side") ||
						animation.includes("dying") ||
						animation.includes("fall down");
					if (once) {
						action.reset().setLoop(THREE.LoopOnce, 1);
						action.clampWhenFinished = true;
					} else {
						action.reset().setLoop(THREE.LoopRepeat, Infinity);
					}
					action.fadeIn(0.15).play();
					rp.currentAction = action;
				}
			}
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
					targetCarQuaternion: new THREE.Quaternion(),
					hp: PLAYER_MAX_HP,
					dead: false,
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
						stripRootMotion(clip);
					}
					const action = mixer.clipAction(clip);
					if (
						nameLower === "being carried" ||
						nameLower === "fall down" ||
						nameLower === "sit to stand" ||
						nameLower === "sweep fall" ||
						nameLower === "stand to sit" ||
						nameLower.includes("receiving an uppercut") ||
						nameLower.includes("hit on side of body") ||
						nameLower === "punch one" ||
						nameLower === "drop kick" ||
						nameLower === "dying" ||
						nameLower.includes("dying")
					) {
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
					.setTranslation(0, HumanEntity.MESH_Y_OFFSET, 0); // Offset upwards from feet
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
				rp.combatBones = findCombatBones(humanGroup);

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

			rp.benchSeat =
				state.benchSeat === 0 || state.benchSeat === 1 ? state.benchSeat : null;

			if (typeof state.hp === "number") rp.hp = state.hp;
			if (typeof state.dead === "boolean") rp.dead = state.dead;

			if (state.activeEntity === "human") {
				rp.carGroup.visible = true; // Wait, actually should carGroup be true here? Yes, if they left it. But humanGroup should be true too!
				rp.humanGroup.visible = true;
				rp.engineSound.update(0, 0, rp.carGroup.position, true);

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
						const next = rp.animations.get(state.animation)!;
						const anim = String(state.animation).toLowerCase();
						const once =
							anim.includes("dying") ||
							anim.includes("fall down") ||
							anim.includes("sit to stand") ||
							anim.includes("sweep") ||
							anim.includes("uppercut") ||
							anim.includes("hit on side") ||
							anim.includes("punch") ||
							anim.includes("drop kick");
						next.reset();
						if (once) {
							next.setLoop(THREE.LoopOnce, 1);
							next.clampWhenFinished = true;
						} else {
							next.setLoop(THREE.LoopRepeat, Infinity);
							next.clampWhenFinished = false;
						}
						next.fadeIn(0.2).play();
						rp.currentAction = next;
					}
				}
			} else if (state.activeEntity === "car") {
				rp.humanGroup.visible = false;
				rp.carGroup.visible = true;
				rp.engineSound.update(
					state.speed || 0,
					state.throttle || 0,
					rp.carGroup.position
				);
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

	private async tryOpenSharedWorldFromUrl() {
		const worldId = new URLSearchParams(window.location.search).get("world");
		if (!worldId || !this.editMode) return;
		try {
			await this.editMode.onRoomWorldBound(worldId);
		} catch (error) {
			console.warn("[world] Failed to open shared world", worldId, error);
		}
	}

	private async connectSocket(action: "host" | "join", roomCodeToJoin?: string) {
		await this.ensureSocket();

		const loadingScreen = document.getElementById("loading-screen");
		const lobbyPanel = document.getElementById("lobby-panel");
		const startBtn = document.getElementById("start-game-btn");
		const settingsToggle = document.getElementById("settings-toggle");

		if (action === "host") {
			const worldId = this.editMode?.getActiveWorldId() ?? this.activeWorldDef.id;
			const worldDefinition = this.knownWorldDefinition(worldId);
			this.socket!.emit(
				"create-room",
				{
					user: this.userData,
					worldId,
					worldDefinition,
				},
				(res: any) => {
					if (res.success) {
						this.roomCode = res.roomCode;
						this.editMode?.attachSocket(this.socket);
						void this.editMode?.onRoomWorldBound(res.worldId ?? worldId);
						this.isGameActive = false;
						this.healthHud?.setVisible(false);
						if (lobbyPanel) lobbyPanel.style.display = "flex";
						if (startBtn) startBtn.style.display = "block";
						if (loadingScreen) loadingScreen.style.display = "none";
						if (settingsToggle) settingsToggle.style.display = "none";
						this.gameNavigation?.hide();
						this.settings.hide();
					}
				}
			);
		} else if (action === "join" && roomCodeToJoin) {
			this.socket!.emit(
				"join-room",
				{
					roomCode: roomCodeToJoin,
					userData: this.userData,
					worldId: this.editMode?.getActiveWorldId() ?? this.activeWorldDef.id,
				},
				(res: any) => {
					if (res.success) {
						this.roomCode = res.roomCode;
						this.editMode?.attachSocket(this.socket);
						void this.editMode?.onRoomWorldBound(
							res.worldId ?? this.activeWorldDef.id
						);
						this.isGameActive = false;
						this.healthHud?.setVisible(false);
						if (lobbyPanel) lobbyPanel.style.display = "flex";
						if (startBtn) startBtn.style.display = "none";
						if (loadingScreen) loadingScreen.style.display = "none";
						if (settingsToggle) settingsToggle.style.display = "none";
						this.gameNavigation?.hide();
						this.settings.hide();
					} else {
						console.error(res.error || "Failed to join room");
					}
				}
			);
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
		/** Blade height only (1 = full). Does not change XZ / chunk coverage width. */
		grassHeightMultiplier: number = 1.0,
		isNewWorld: boolean = false,
		options?: {
			chunkSize?: number;
			clearPondHole?: boolean;
			/** Even grid + jitter (custom worlds) — avoids random patchy gaps. */
			evenCoverage?: boolean;
			/** Skip grass steeper than this slope angle (degrees). Default 65. */
			maxSlopeDeg?: number;
			heights?: Float32Array;
			nrows?: number;
			ncols?: number;
			terrainSize?: number;
		}
	) {
		const matrices: THREE.Matrix4[] = [];
		const clearPondHole = options?.clearPondHole !== false;
		const maxSlopeDeg = options?.maxSlopeDeg ?? 65;
		const minNormalY = Math.cos((maxSlopeDeg * Math.PI) / 180);
		// Shader tip lift is world-space after instanceMatrix — keep it in sync with Y scale.
		this.grassMaterial.setBladeHeightScale(grassHeightMultiplier);

		const position = new THREE.Vector3();
		const quaternion = new THREE.Quaternion();
		const scale = new THREE.Vector3(1, 1, 1);
		const normal = new THREE.Vector3();
		const yAxis = new THREE.Vector3(0, 1, 0);
		const matrix = new THREE.Matrix4();

		const pushBlade = () => {
			const distToPond = clearPondHole
				? Math.hypot(position.x - pondLocalPos.x, position.z - pondLocalPos.y)
				: Infinity;
			let heightScale = 1.0;

			if (distToPond < 14) {
				if (distToPond < 8) {
					if (Math.random() > 0.15) return false;
					heightScale = 0.25 + Math.random() * 0.15;
				} else if (distToPond < 10) {
					if (Math.random() > 0.4) return false;
					heightScale = 0.35 + Math.random() * 0.2;
				} else {
					const t = (distToPond - 10) / 4;
					heightScale = 0.45 + 0.55 * t;
				}
			}

			const randomVariation = 0.8 + Math.random() * 0.4;
			// X/Z = blade / footprint width (unchanged by height multiplier).
			// Y = blade height only.
			scale.set(
				randomVariation,
				heightScale * randomVariation * grassHeightMultiplier,
				randomVariation
			);

			quaternion.setFromUnitVectors(yAxis, normal);
			const randomRotation = new THREE.Euler(0, Math.random() * Math.PI * 2, 0);
			const randomQuaternion = new THREE.Quaternion().setFromEuler(randomRotation);
			quaternion.multiply(randomQuaternion);
			matrix.compose(position, quaternion, scale);
			matrices.push(matrix.clone());
			return true;
		};

		const useEven =
			options?.evenCoverage &&
			options.heights &&
			options.nrows != null &&
			options.ncols != null &&
			options.terrainSize != null;

		if (useEven) {
			const heights = options.heights!;
			const nrows = options.nrows!;
			const ncols = options.ncols!;
			const size = options.terrainSize!;
			const half = size * 0.5;
			// Same blade spacing as island (~0.9 m). If budget is lower than full
			// coverage, keep probability so thinning stays uniform (not patchy corners).
			const spacing = Math.sqrt(1 / ISLAND_GRASS_DENSITY);
			const fullCount = (size * size) * ISLAND_GRASS_DENSITY;
			const keepProb = Math.min(1, this.grassCount / Math.max(1, fullCount));
			const stride = nrows + 1;
			/**
			 * Bilinear over the terrain grid. The rendered surface interpolates
			 * between vertices, so nearest-vertex snapping would sink blades into
			 * slopes (or float them) by up to half a cell × tan(slope) — metres on
			 * big worlds, where cells reach ~39 m at the 254-segment cap.
			 */
			const sampleH = (x: number, z: number) => {
				const fx = THREE.MathUtils.clamp(((x + half) / size) * ncols, 0, ncols);
				const fz = THREE.MathUtils.clamp(((z + half) / size) * nrows, 0, nrows);
				const col0 = Math.floor(fx);
				const row0 = Math.floor(fz);
				const col1 = Math.min(col0 + 1, ncols);
				const row1 = Math.min(row0 + 1, nrows);
				const tx = fx - col0;
				const tz = fz - row0;
				const h00 = heights[row0 + col0 * stride]!;
				const h10 = heights[row0 + col1 * stride]!;
				const h01 = heights[row1 + col0 * stride]!;
				const h11 = heights[row1 + col1 * stride]!;
				const hRow0 = h00 + (h10 - h00) * tx;
				const hRow1 = h01 + (h11 - h01) * tx;
				return hRow0 + (hRow1 - hRow0) * tz;
			};
			const sampleN = (x: number, z: number, out: THREE.Vector3) => {
				const e = Math.max(spacing * 0.5, size / ncols);
				out.set(
					sampleH(x - e, z) - sampleH(x + e, z),
					e * 2,
					sampleH(x, z - e) - sampleH(x, z + e)
				).normalize();
			};

			let rowIndex = 0;
			for (let gz = -half + spacing * 0.5; gz < half; gz += spacing, rowIndex++) {
				if (matrices.length >= this.grassCount) break;
				// Offset every other row by half a cell (hex-style packing). A square
				// lattice lines blades up in axis-aligned rows, and the seam between
				// rows reads as a bare stripe on any hillside seen face-on.
				const rowShift = (rowIndex & 1) * spacing * 0.5;
				for (let gx = -half + spacing * 0.5 + rowShift; gx < half; gx += spacing) {
					if (matrices.length >= this.grassCount) break;
					if (keepProb < 1 && Math.random() > keepProb) continue;
					// Full-cell jitter (stratified). At 0.9 every cell kept a 5%
					// no-blade margin, and those margins joined up into grid lines.
					const x = gx + (Math.random() - 0.5) * spacing;
					const z = gz + (Math.random() - 0.5) * spacing;
					if (x < -half || x > half || z < -half || z > half) continue;
					sampleN(x, z, normal);
					// Only bare on steep slopes (> maxSlopeDeg). Gentle hills keep grass.
					if (normal.y < minNormalY) continue;
					position.set(x, sampleH(x, z), z);
					pushBlade();
				}
			}
		} else {
			const sampler = new MeshSurfaceSampler(surfaceMesh).build();
			let instanceIndex = 0;
			const maxAttempts = this.grassCount * (isNewWorld ? 4 : 2);
			for (let i = 0; i < maxAttempts; i++) {
				if (instanceIndex >= this.grassCount) break;
				sampler.sample(position, normal);
				if (normal.lengthSq() > 1e-8) normal.normalize();
				else normal.copy(yAxis);

				if (isNewWorld) {
					const steepness = normal.dot(yAxis);
					if (steepness < 0.5) continue;
					if (steepness < 0.7 && Math.random() > 0.15) continue;
					const clusterNoise =
						Math.sin(position.x * 0.4 + position.z * 0.3) *
						Math.cos(position.z * 0.5 - position.x * 0.2) +
						Math.sin(position.x * 0.8 + 2.1) *
						Math.cos(position.z * 0.7 + 1.3) *
						0.5;
					if (clusterNoise < 0.2) continue;
				} else if (normal.y < minNormalY) {
					continue;
				}

				if (pushBlade()) instanceIndex++;
			}
		}

		const field = new GrassChunkField({
			matrices,
			geometry: grassGeometry,
			material: this.grassMaterial.material,
			origin: surfaceMesh.position,
			chunkSize: options?.chunkSize ?? 15,
			density: this.grassDensity,
			cullDistance: this.grassCullDistance,
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
		this.islandTerrainMesh = mesh;
		this.islandHeights = heights;

		mesh.updateMatrixWorld(true);
		setIslandTerrain(mesh);
		this.islandTerrainHandle = createTerrainHeightfieldCollider(
			heights,
			nrows,
			ncols,
			TERRAIN_CONFIG.size
		);

		this.pond = new Pond({
			width: 20,
			height: 20,
			segments: 128,
			resolution: 256,
			circular: true,
			...REFERENCE_WATER_LOOK,
			renderer: this.renderer,
			scene: this.scene,
			camera: this.camera,
			sunDirection: { x: 12, y: 22, z: 8 },
		});
		// Position exactly in the basin we scooped out at (-20, 5)
		this.pond.mesh.position.set(-20, -0.5, 5);
		this.pond.mesh.renderOrder = 1; // Force water to draw AFTER grass!
		this.worldGroup.add(this.pond.mesh);
		this.resizePondTargets();

		// Green → muddy shore → water on the island pond basin.
		this.terrainMat.vertexColors = true;
		this.terrainMat.color.setHex(0xffffff);
		this.terrainMat.needsUpdate = true;
		paintTerrainMudShore(mesh, -20, 5, 10, 16);

		if (!this.grassGeometry.hasAttribute("position")) {
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
		}

		this.islandGrassField = this.addGrass(
			mesh,
			this.grassGeometry,
			this.worldGroup,
			new THREE.Vector2(-20, 5),
			0.6 // blade height only (XZ / chunk coverage unchanged)
		);

		console.log(
			`[FluffyGrass] terrain ${TERRAIN_CONFIG.size}×${TERRAIN_CONFIG.size}, grass=${this.grassCount}`
		);
	}

	private async buildIslandWorld() {
		await this.loadModels();
		await this.setupPondStones();
		await this.setupTrees();
		await this.setupIslandScenicProps();
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

	/**
	 * Bridge near top-center; props on the RIGHT side of the world.
	 * Looking +Z toward the bridge, right = +X. Island is 200 m (−100…100).
	 */
	private async setupIslandScenicProps() {
		for (const prop of this.islandScenicProps) prop.dispose();
		this.islandScenicProps = [];

		const placements = [
			{
				// Wooden sign — a bit more left (+top) from the bench cluster
				assetUrl: "/models/wooden_sign.glb",
				position: { x: 70, z: 75 },
				targetHeight: 9.6,
				rotationY: Math.PI * 0.1,
			},
			{
				// Lamp ~0.8 m from the bench
				assetUrl: "/models/medieval_lamp_post.glb",
				position: { x: 68, z: -52 },
				targetHeight: 8,
				rotationY: -Math.PI * 0.8,
			},
			{
				// Bench — seat height for a human (~knee / sit height)
				assetUrl: "/models/bench.glb",
				position: { x: 69.5, z: -46 },
				targetHeight: 0.55,
				rotationY: -Math.PI * 0.55,
			},
		] as const;

		const placed = await Promise.all(
			placements.map((p) =>
				placeScenicProp({
					...p,
					withCollider: true,
					manager: this.loadingManager,
				})
			)
		);
		this.islandScenicProps = placed;
		for (const prop of placed) this.worldGroup.add(prop.group);

		const bench = placed.find((p) => p.group.userData.assetUrl === "/models/bench.glb");
		if (bench) {
			bench.group.updateMatrixWorld(true);
			const box = new THREE.Box3().setFromObject(bench.group);
			const center = new THREE.Vector3();
			const size = new THREE.Vector3();
			box.getCenter(center);
			box.getSize(size);
			const yaw = -Math.PI * 0.55;
			// Along the bench plank (local +X after yaw).
			const along = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
			const halfSpan = Math.max(size.x, size.z) * 0.28;
			const seatY = box.max.y;
			const left = center.clone().addScaledVector(along, -halfSpan);
			const right = center.clone().addScaledVector(along, halfSpan);
			left.y = seatY;
			right.y = seatY;
			this.benchInteract = {
				seats: [left, right],
				yaw,
			};
		} else {
			this.benchInteract = null;
		}

		// Big firefly-style glow at the lamp (same look as night bugs). Tweak position later.
		this.lampFireflyGlow?.dispose();
		this.lampFireflyGlow = createLampFireflyGlow({
			x: 68,
			z: -50,
			heightAboveGround: 5.2,
			size: 5.5,
		});
		this.worldGroup.add(this.lampFireflyGlow.points);
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

		this.vehicleGrapple?.dispose();
		this.vehicleGrapple = new VehicleGrapple(car);
		assignCarLightingLayer(this.vehicleGrapple.group);

		this.mobileControls = createMobileControls(() => {
			if (this.car && this.carController) {
				resetCarUpright(this.car, this.carController);
			}
		});
		this.carInput.setMobileControls(this.mobileControls);

		this.chaseCameraInput = new ChaseCameraInput(this.canvas, {
			// Mouse-look only while actually driving / walking: never in the
			// lobby, never in edit mode (needs the cursor), never on touch.
			isFreeLookAllowed: () =>
				this.isGameActive &&
				!this.isWorldSwitching &&
				!this.sceneProps.mapMode &&
				!this.editMode?.isEnabled &&
				// A login / logout form or the room list needs a usable cursor.
				!isKeyboardCapturedByUi() &&
				!isTextEntryFocused() &&
				!isMobileDevice(),
		});
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

		// Free gun — kept in scene (world space), snapped to the right hand each
		// frame. Parenting under humanScale (~0.03) made the mesh vanish.
		try {
			const gunGltf = await this.loadGltfFull("/gun.glb");
			const gunVisual = gunGltf.scene as THREE.Group;
			gunVisual.traverse((child: THREE.Object3D) => {
				if (child instanceof THREE.Mesh) {
					child.castShadow = true;
					child.receiveShadow = true;
					const mats = Array.isArray(child.material)
						? child.material
						: [child.material];
					for (const m of mats) {
						if (m && "metalness" in m) {
							(m as THREE.MeshStandardMaterial).metalness = Math.min(
								(m as THREE.MeshStandardMaterial).metalness ?? 0.4,
								0.45
							);
						}
						if (m) m.side = THREE.DoubleSide;
					}
				}
			});

			const rawBox = new THREE.Box3().setFromObject(gunVisual);
			const rawSize = new THREE.Vector3();
			rawBox.getSize(rawSize);
			const longest = Math.max(rawSize.x, rawSize.y, rawSize.z, 1e-3);
			// World-space length ~0.5m (not affected by humanScale)
			gunVisual.scale.setScalar(0.5 / longest);
			rawBox.setFromObject(gunVisual);
			const center = new THREE.Vector3();
			rawBox.getCenter(center);
			gunVisual.position.sub(center);

			const grip = new THREE.Group();
			grip.name = "GunGrip";
			grip.add(gunVisual);
			grip.visible = false;
			this.scene.add(grip);
			this.gunMesh = grip;
			console.log(
				"[setupHuman] Gun ready in world space, scale",
				gunVisual.scale.x.toFixed(4)
			);
		} catch (err) {
			console.warn("[setupHuman] Failed to load /gun.glb", err);
		}

		this.humanInput.onWeaponEquip = () => {
			if (!this.gunMesh || !this.humanInput) return;
			this.gunMesh.visible = this.humanInput.shouldShowGun();
		};

		this.humanInput.onWeaponWheelToggle = (open) => {
			this.chaseCameraInput?.setUiCapture(open);
		};

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

			// Hide gun while a bomb occupies the hand
			if (this.gunMesh) this.gunMesh.visible = false;

			// Remove physics body from the world so it stops falling
			const bombData = this.bombs.find(b => b.mesh === obj);
			if (bombData && bombData.body) {
				getWorld().removeRigidBody(bombData.body);
				bombData.body = null;
			}

			const hand = this.human.rightHandBone;
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
			worldPos.y += HumanEntity.MESH_Y_OFFSET; // Account for physics body offset so they don't spawn underground!
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

		const _punchHead = new THREE.Vector3();
		const _punchSpine = new THREE.Vector3();

		this.humanInput.getPunchTargets = () => {
			const results: Array<{
				id: string;
				head: THREE.Vector3;
				spine: THREE.Vector3;
				feetY: number;
				position: THREE.Vector3;
				quaternion: THREE.Quaternion;
			}> = [];
			if (!this.human) return results;

			for (const [socketId, rp] of this.remotePlayers.entries()) {
				if (!rp.loaded || !rp.humanGroup || !rp.humanGroup.visible) continue;
				if (rp.isBeingCarried) continue;
				if (rp.dead) continue;

				rp.humanGroup.updateMatrixWorld(true);
				const feetY = rp.humanGroup.position.y;
				const bones = rp.combatBones;

				if (bones?.head) {
					bones.head.getWorldPosition(_punchHead);
				} else {
					_punchHead.set(
						rp.humanGroup.position.x,
						feetY + 1.65,
						rp.humanGroup.position.z
					);
				}

				if (bones?.spine) {
					bones.spine.getWorldPosition(_punchSpine);
				} else {
					_punchSpine.set(
						rp.humanGroup.position.x,
						feetY + 1.05,
						rp.humanGroup.position.z
					);
				}

				results.push({
					id: socketId,
					head: _punchHead.clone(),
					spine: _punchSpine.clone(),
					feetY,
					position: rp.humanGroup.position.clone(),
					quaternion: rp.humanGroup.quaternion.clone(),
				});
			}
			return results;
		};

		this.humanInput.onPunchHit = (targetId, reaction) => {
			if (this.socket && this.roomCode) {
				this.socket.emit("player-hit", {
					roomCode: this.roomCode,
					targetSocketId: targetId,
					hitZone: reaction,
				});
			}

			// Optimistic remote reaction (victim also applies from player-hit)
			const rp = this.remotePlayers.get(targetId);
			if (!rp?.loaded || !rp.animations) return;
			const animName = hitReactionAnimName(reaction);
			const action = [...rp.animations.entries()].find(
				([name]) => name === animName || name.includes(animName)
			)?.[1];
			if (!action) return;
			if (rp.currentAction) rp.currentAction.fadeOut(0.15);
			action.reset().setLoop(THREE.LoopOnce, 1);
			action.clampWhenFinished = true;
			action.fadeIn(0.15).play();
			rp.currentAction = action;
		};

		this.humanInput.onGunHit = (targetId, part) => {
			const dmg = damageForPart(part);
			if (this.socket && this.roomCode) {
				this.socket.emit("player-damage", {
					roomCode: this.roomCode,
					targetSocketId: targetId,
					part,
					damage: dmg,
				});
			}
			// Optimistic remote HP (victim applies real death; no flinch anim)
			const rp = this.remotePlayers.get(targetId);
			if (!rp || rp.dead) return;
			rp.hp = Math.max(0, (rp.hp ?? PLAYER_MAX_HP) - dmg);
		};

		this.humanInput.getMuzzleWorldPosition = () => {
			if (!this.gunMesh || !this.gunMesh.visible) return null;
			this.gunMuzzleLocal.set(0.02, 0.05, 0.42);
			this.gunMuzzleLocal.applyQuaternion(this.gunMesh.quaternion);
			this.gunMuzzleWorld.copy(this.gunMesh.position).add(this.gunMuzzleLocal);
			return this.gunMuzzleWorld;
		};

		this.humanInput.onFireProjectile = (origin, direction) => {
			const ownerId = this.socket?.id ?? null;
			this.bulletSystem?.spawn(origin, direction, {
				dealDamage: true,
				ownerId,
			});
			if (this.socket && this.roomCode) {
				const predictedId = this.predictShotTargetId(origin, direction);
				this.socket.emit("gun-shot", {
					roomCode: this.roomCode,
					origin: {
						x: origin.x,
						y: origin.y,
						z: origin.z,
					},
					direction: {
						x: direction.x,
						y: direction.y,
						z: direction.z,
					},
					targetId: predictedId,
				});
			}
		};

		if (this.bulletSystem) {
			this.bulletSystem.onHit = (targetId, _point, part) => {
				this.humanInput?.onGunHit?.(targetId, part);
			};
			this.bulletSystem.onBombHit = (bombId) => {
				this.detonateBomb(bombId);
			};
		}

		this.humanInput.onHitRepositioned = (pos, quat) => {
			if (!this.socket || !this.roomCode || !this.human) return;
			const animation = this.human.activeAnimationName;
			this.socket.emit("player-reposition", {
				roomCode: this.roomCode,
				position: { x: pos.x, y: pos.y, z: pos.z },
				quaternion: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
				animation,
			});
			// Also push a full state tick so animation/pos stay aligned
			this.socket.emit("player-state", {
				roomCode: this.roomCode,
				state: {
					activeEntity: this.activePlayer,
					humanPosition: { x: pos.x, y: pos.y, z: pos.z },
					humanQuaternion: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
					animation,
					benchSeat: null,
				},
			});
		};
	}

	/** Snap the world-space gun mesh to the animated right-hand bone. */
	private syncGunToHand() {
		if (!this.gunMesh || !this.human || !this.gunMesh.visible) return;
		const hand = this.human.rightHandBone;
		if (!hand) {
			this.gunMesh.position.copy(this.human.mesh.position);
			this.gunMesh.position.y += 1.2;
			this.gunMesh.quaternion.copy(this.human.mesh.quaternion);
			return;
		}
		this.human.mesh.updateMatrixWorld(true);
		hand.getWorldPosition(this.gunHandPos);
		hand.getWorldQuaternion(this.gunHandQuat);

		// Offset in hand local space → world
		this.gunWorldOffset.copy(this.gunOffsetPos).applyQuaternion(this.gunHandQuat);
		this.gunMesh.position.copy(this.gunHandPos).add(this.gunWorldOffset);
		this.gunMesh.quaternion.copy(this.gunHandQuat).multiply(this.gunOffsetQuat);
	}

	/** Who the shot will likely hit on this client (for network visual aim). */
	private predictShotTargetId(
		origin: THREE.Vector3,
		direction: THREE.Vector3
	): string | null {
		const targets = this.humanInput?.getPunchTargets?.() ?? [];
		const dir = this._shotDir.copy(direction).normalize();
		let bestId: string | null = null;
		let bestDist = 80;
		const radius = 0.95;

		for (const t of targets) {
			for (const point of [t.head, t.spine, t.position]) {
				this._shotTo.copy(point).sub(origin);
				const along = this._shotTo.dot(dir);
				if (along < 0.4 || along > bestDist) continue;
				this._shotClosest.copy(origin).addScaledVector(dir, along);
				if (this._shotClosest.distanceTo(point) > radius) continue;
				bestDist = along;
				bestId = t.id;
			}
		}
		return bestId;
	}

	private getPlayerShotAimPoint(
		playerId: string,
		part: GunHitPart = "body"
	): THREE.Vector3 | null {
		if (playerId === this.socket?.id) {
			if (!this.human || this.localDead) return null;
			this.human.mesh.updateMatrixWorld(true);
			if (part === "head" && this.human.headBone) {
				this.human.headBone.getWorldPosition(this._shotAim);
				return this._shotAim;
			}
			if (this.human.spineBone) {
				this.human.spineBone.getWorldPosition(this._shotAim);
				return this._shotAim;
			}
			this._shotAim.copy(this.human.mesh.position);
			this._shotAim.y += part === "head" ? 1.65 : 1.05;
			return this._shotAim;
		}

		const rp = this.remotePlayers.get(playerId);
		if (!rp?.loaded || !rp.humanGroup || rp.dead) return null;
		rp.humanGroup.updateMatrixWorld(true);
		if (part === "head" && rp.combatBones?.head) {
			rp.combatBones.head.getWorldPosition(this._shotAim);
			return this._shotAim;
		}
		if (rp.combatBones?.spine) {
			rp.combatBones.spine.getWorldPosition(this._shotAim);
			return this._shotAim;
		}
		this._shotAim.copy(rp.humanGroup.position);
		this._shotAim.y += part === "head" ? 1.65 : 1.05;
		return this._shotAim;
	}

	private getRemoteMuzzleWorld(shooterId: string): THREE.Vector3 | null {
		const rp = this.remotePlayers.get(shooterId);
		if (!rp?.loaded || !rp.humanGroup) return null;
		rp.humanGroup.updateMatrixWorld(true);
		const hand = rp.combatBones?.rightHand;
		if (hand) {
			hand.getWorldPosition(this._shotOrigin);
			this._shotOrigin.y += 0.08;
			return this._shotOrigin;
		}
		this._shotOrigin.copy(rp.humanGroup.position);
		this._shotOrigin.y += 1.35;
		return this._shotOrigin;
	}

	/**
	 * Remote gun tracer: start from the shooter's visible body and aim at the
	 * local representation of the predicted target so all clients see the hit.
	 */
	private spawnRemoteGunTracer(
		shooterId: string,
		netOrigin: THREE.Vector3,
		netDir: THREE.Vector3,
		targetId: string | null
	) {
		if (!this.bulletSystem) return;

		const muzzle = this.getRemoteMuzzleWorld(shooterId);
		const origin = muzzle ? muzzle.clone() : netOrigin.clone();

		let aimId = targetId;
		if (!aimId) {
			// Fall back: whoever sits near the networked ray on THIS client
			aimId = this.predictShotTargetId(origin, netDir);
		}
		// Always consider the local player for visual aim (they aren't in getPunchTargets)
		if (!aimId && this.human && !this.localDead && this.socket?.id) {
			const head = this.getPlayerShotAimPoint(this.socket.id, "head");
			const spine = this.getPlayerShotAimPoint(this.socket.id, "body");
			if (head && spine) {
				const dir = this._shotDir.copy(netDir).normalize();
				let bestDist = 80;
				for (const point of [head, spine, this.human.mesh.position]) {
					this._shotTo.copy(point).sub(origin);
					const along = this._shotTo.dot(dir);
					if (along < 0.4 || along > bestDist) continue;
					this._shotClosest.copy(origin).addScaledVector(dir, along);
					if (this._shotClosest.distanceTo(point) > 1.1) continue;
					bestDist = along;
					aimId = this.socket.id;
				}
			}
		}

		let dir = netDir.clone().normalize();
		if (aimId) {
			const aimAt = this.getPlayerShotAimPoint(aimId, "body");
			if (aimAt) {
				dir.copy(aimAt).sub(origin);
				if (dir.lengthSq() > 1e-6) dir.normalize();
				else dir.copy(netDir).normalize();
				const fxKey = `${shooterId}->${aimId}`;
				this.recentGunFxAt.set(fxKey, performance.now());
			}
		}

		this.bulletSystem.spawn(origin, dir, {
			dealDamage: false,
			ownerId: shooterId,
		});
	}

	/** Authoritative hit FX when damage is applied — aims into local victim body. */
	private spawnSyncedHitTracer(
		attackerId: string,
		victimId: string,
		part: GunHitPart
	) {
		if (!this.bulletSystem) return;
		if (attackerId === this.socket?.id) return; // shooter already has local bullet

		const fxKey = `${attackerId}->${victimId}`;
		const now = performance.now();
		const prev = this.recentGunFxAt.get(fxKey) ?? 0;
		if (now - prev < 550) return; // gun-shot tracer already covered this hit
		this.recentGunFxAt.set(fxKey, now);

		const muzzle =
			this.getRemoteMuzzleWorld(attackerId)?.clone() ??
			(() => {
				const rp = this.remotePlayers.get(attackerId);
				if (!rp?.humanGroup) return null;
				return rp.humanGroup.position
					.clone()
					.add(new THREE.Vector3(0, 1.35, 0));
			})();
		const aimAt = this.getPlayerShotAimPoint(victimId, part);
		if (!muzzle || !aimAt) return;

		const dir = aimAt.clone().sub(muzzle);
		if (dir.lengthSq() < 1e-6) return;
		dir.normalize();

		this.bulletSystem.spawn(muzzle, dir, {
			dealDamage: false,
			ownerId: attackerId,
		});
	}

	/**
	 * Full bomb detonation — same VFX / SFX / knockback as a thrown landing fuse.
	 * Safe to call from bullet hits or the land timer.
	 */
	private detonateBomb(blastId: number) {
		if (this.detonatingBombIds.has(blastId)) return;
		const bomb = this.bombs.find((x) => x.id === blastId);
		if (!bomb) return;

		this.detonatingBombIds.add(blastId);
		bomb.isFlying = false;

		const blastPos = new THREE.Vector3();
		bomb.mesh.getWorldPosition(blastPos);

		// If still attached to a hand, drop back into the world for the blast/reset
		if (bomb.mesh.parent !== this.worldGroup) {
			this.worldGroup.add(bomb.mesh);
			bomb.mesh.position.copy(blastPos);
		}

		BombSound.playBlastSound(blastPos);
		this.explosionSystem?.emit(blastPos);

		// --- WATER SPLASH ---
		if (this.pond) {
			const distToPond = Math.hypot(blastPos.x - -20, blastPos.z - 5);
			const waterY = this.pond.mesh.position.y;
			if (distToPond < 15 && Math.abs(blastPos.y - waterY) < 4.0) {
				this.pond.createRipple({
					position: blastPos,
					strength: 1.5,
					radius: 5.0,
				});
			}
		}

		const blastRadius = BLAST_KILL_RADIUS;

		// Instant kill if local player is in blast radius
		if (this.human && this.humanInput && !this.localDead) {
			const dist = this.human.mesh.position.distanceTo(blastPos);
			if (dist < blastRadius) {
				this.dieLocal("bomb");
			}
		}

		// Car knockback
		if (this.car?.body) {
			const dist = this.car.mesh.position.distanceTo(blastPos);
			if (dist < blastRadius + 2.0) {
				const dir = new THREE.Vector3().subVectors(this.car.mesh.position, blastPos);
				dir.y = Math.max(0.5, dir.y + 1.0);
				dir.normalize();
				const force = 25000 * (1 - dist / (blastRadius + 2.0));
				this.car.body.applyImpulse(dir.multiplyScalar(force), true);
			}
		}

		// Other bombs (chain reaction)
		for (const otherBomb of this.bombs) {
			if (
				otherBomb.id !== blastId &&
				otherBomb.body &&
				otherBomb.mesh.parent === this.worldGroup
			) {
				const dist = otherBomb.mesh.position.distanceTo(blastPos);
				if (dist < blastRadius) {
					const dir = new THREE.Vector3().subVectors(
						otherBomb.mesh.position,
						blastPos
					);
					dir.y = Math.max(0.5, dir.y + 1.0);
					dir.normalize();
					const force = 150 * (1 - dist / blastRadius);
					otherBomb.body.applyImpulse(dir.multiplyScalar(force), true);
					otherBomb.isFlying = true;
					otherBomb.flightTime = 0;
				}
			}
		}

		// Respawn this bomb elsewhere
		if (bomb.body) {
			const newPos = new THREE.Vector3(
				(Math.random() - 0.5) * 50,
				0,
				(Math.random() - 0.5) * 50
			);
			newPos.y = getWorldTerrainY(newPos.x, newPos.z) + 5.0;
			bomb.body.setTranslation(newPos, true);
			bomb.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			bomb.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
			bomb.mesh.position.copy(newPos);
		} else {
			// Was held / no body — recreate a simple dynamic body at a random spot
			const newPos = new THREE.Vector3(
				(Math.random() - 0.5) * 50,
				0,
				(Math.random() - 0.5) * 50
			);
			newPos.y = getWorldTerrainY(newPos.x, newPos.z) + 5.0;
			const rbDesc = RAPIER.RigidBodyDesc.dynamic()
				.setTranslation(newPos.x, newPos.y, newPos.z)
				.setLinearDamping(0.1)
				.setAngularDamping(0.5);
			const body = getWorld().createRigidBody(rbDesc);
			getWorld().createCollider(RAPIER.ColliderDesc.ball(0.5).setMass(10), body);
			bomb.body = body;
			if (bomb.mesh.parent !== this.worldGroup) {
				this.worldGroup.add(bomb.mesh);
			}
			bomb.mesh.position.copy(newPos);
		}

		if (this.socket && this.roomCode) {
			this.socket.emit("bomb-blast", {
				roomCode: this.roomCode,
				bombId: blastId,
				position: { x: blastPos.x, y: blastPos.y, z: blastPos.z },
			});
		}

		this.detonatingBombIds.delete(blastId);
	}

	/** Remote client received a bomb blast (VFX + local kill check + bomb reset). */
	private applyRemoteBombBlast(bombId: number, blastPos: THREE.Vector3) {
		if (typeof bombId === "number") {
			if (this.detonatingBombIds.has(bombId)) return;
			this.detonatingBombIds.add(bombId);
		}

		BombSound.playBlastSound(blastPos);
		this.explosionSystem?.emit(blastPos);

		if (this.pond) {
			const distToPond = Math.hypot(blastPos.x - -20, blastPos.z - 5);
			const waterY = this.pond.mesh.position.y;
			if (distToPond < 15 && Math.abs(blastPos.y - waterY) < 4.0) {
				this.pond.createRipple({
					position: blastPos,
					strength: 1.5,
					radius: 5.0,
				});
			}
		}

		if (this.human && !this.localDead) {
			const dist = this.human.mesh.position.distanceTo(blastPos);
			if (dist < BLAST_KILL_RADIUS) {
				this.dieLocal("bomb");
			}
		}

		if (this.car?.body) {
			const dist = this.car.mesh.position.distanceTo(blastPos);
			if (dist < BLAST_KILL_RADIUS + 2.0) {
				const dir = new THREE.Vector3().subVectors(this.car.mesh.position, blastPos);
				dir.y = Math.max(0.5, dir.y + 1.0);
				dir.normalize();
				const force = 25000 * (1 - dist / (BLAST_KILL_RADIUS + 2.0));
				this.car.body.applyImpulse(dir.multiplyScalar(force), true);
			}
		}

		const bomb = this.bombs.find((x) => x.id === bombId);
		if (bomb?.body) {
			const newPos = new THREE.Vector3(
				(Math.random() - 0.5) * 50,
				0,
				(Math.random() - 0.5) * 50
			);
			newPos.y = getWorldTerrainY(newPos.x, newPos.z) + 5.0;
			bomb.body.setTranslation(newPos, true);
			bomb.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			bomb.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
			bomb.mesh.position.copy(newPos);
			bomb.isFlying = false;
		}

		if (typeof bombId === "number") {
			this.detonatingBombIds.delete(bombId);
		}
	}

	private applyLocalDamage(
		part: GunHitPart,
		damage: number,
		_attackerId?: string
	) {
		if (this.localDead || !this.humanInput) return;
		this.localHp = Math.max(0, this.localHp - damage);
		this.healthHud?.setHp(this.localHp);
		if (this.localHp <= 0) {
			this.dieLocal("gun");
		}
	}

	private dieLocal(cause: DeathCause) {
		if (this.localDead || !this.human || !this.humanInput) return;
		this.localDead = true;
		this.localHp = 0;
		this.healthHud?.setHp(0);
		this.deathCause = cause;
		this.humanInput.isDead = true;
		this.humanInput.clearAimLock();
		this.humanInput.releaseControls();

		const anim = cause === "bomb" ? "fall down" : "dying";
		const duration = this.human.playAnimation(anim, 0.15, true);
		this.deathTimer = Math.max(duration, 1.2) + 0.6;

		if (this.gunMesh) this.gunMesh.visible = false;

		if (this.socket && this.roomCode) {
			const p = this.human.mesh.position;
			this.socket.emit("player-died", {
				roomCode: this.roomCode,
				cause,
				position: { x: p.x, y: p.y, z: p.z },
				animation: this.human.activeAnimationName,
			});
		}
	}

	private updateLocalDeath(dt: number) {
		if (!this.localDead) return;
		this.deathTimer -= dt;
		if (this.human && this.deathCause) {
			const anim = this.deathCause === "bomb" ? "fall down" : "dying";
			this.human.playAnimation(anim);
		}
		if (this.deathTimer <= 0) {
			this.respawnLocal();
		}
	}

	/** Snap human onto safe terrain (combat / out-of-bounds). */
	private respawnHumanOnTerrain(preferX?: number, preferZ?: number) {
		if (!this.human) return;
		const px =
			preferX ??
			(this.car ? this.car.mesh.position.x + 3 : this.human.mesh.position.x);
		const pz =
			preferZ ??
			(this.car ? this.car.mesh.position.z : this.human.mesh.position.z);
		const spawn = findSafeTerrainSpawn(px, pz, 2.5);
		this.human.body.setTranslation(
			{
				x: spawn.x,
				y: spawn.y + HumanEntity.MESH_Y_OFFSET,
				z: spawn.z,
			},
			true
		);
		this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
		this.human.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
		this.human.mesh.position.copy(spawn);
	}

	private respawnLocal() {
		if (!this.human || !this.humanInput) return;
		this.respawnHumanOnTerrain();
		this.human.playAnimation("idle");

		this.localHp = PLAYER_MAX_HP;
		this.localDead = false;
		this.deathCause = null;
		this.deathTimer = 0;
		this.humanInput.isDead = false;
		this.humanInput.isEnabled = this.activePlayer === "human";
		this.healthHud?.setHp(this.localHp);
		if (this.gunMesh) {
			this.gunMesh.visible = this.humanInput.shouldShowGun();
		}

		if (this.socket && this.roomCode) {
			const p = this.human.mesh.position;
			this.socket.emit("player-respawned", {
				roomCode: this.roomCode,
				position: { x: p.x, y: p.y, z: p.z },
				hp: PLAYER_MAX_HP,
			});
		}
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
			const fogCenter = this.fogFollowPlayer
				? this.car.mesh.position
				: undefined;
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

		// Cull around the player (not the orbiting chase camera) so mouse-look
		// doesn't slide the grass ring in a weird direction.
		let cullPos: THREE.Vector3;
		if (this.editMode?.isEnabled) {
			cullPos = this.editMode.activeCamera.position;
		} else if (this.activePlayer === "human" && this.human?.mesh) {
			cullPos = this.human.mesh.position;
		} else if (this.car?.mesh) {
			cullPos = this.car.mesh.position;
		} else {
			cullPos = this.camera.position;
		}
		if (this.renderFrameCounter % 2 === 0) {
			if (this.currentWorld === "island" && this.worldGroup.visible) {
				this.islandGrassField?.updateDistanceCulling(cullPos);
			} else if (this.currentWorld === "valley" && this.newWorldGroup.visible) {
				this.valleyGrassField?.updateDistanceCulling(cullPos);
			} else if (this.activeWorldDef.kind === "custom" && this.customWorldGroup.visible) {
				this.customGrassField?.updateDistanceCulling(cullPos);
			}
			this.updateMeshDistanceCulling(cullPos);
		}

		if (this.currentWorld === "island" && this.worldGroup.visible) {
			this.grassMaterial.update(this.Uniforms.uTime.value);
			updateFoliageWind(dt);
			if (this.pond) {
				const pondVisible = this.isObjectVisible(this.pond.mesh);
				this.pond.mesh.visible = pondVisible;
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
				this.updateEditorPonds(dt);

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

		if (
			(this.currentWorld === "valley" && this.newWorldGroup.visible) ||
			(this.activeWorldDef.kind === "custom" && this.customWorldGroup.visible)
		) {
			this.grassMaterial.update(this.Uniforms.uTime.value);
			if (this.renderFrameCounter % 2 === 0) {
				// distance cull already handled above
			}
			updateFoliageWind(dt);
			this.updateEditorPonds(dt);
		}

		this.maybeInjectAmbientWaterRipples(now);

		if (!this.isGameActive) {
			for (const mixer of this.lobbyMixers) {
				mixer.update(dt);
			}
		}

		// Hand the cursor back the moment mouse-look stops being allowed
		// (lobby, edit mode, world switch).
		this.chaseCameraInput?.syncFreeLook();

		if (this.dayNight) {
			const fireflyIntensity = this.dayNight.update(dt);
			this.dayNightGui.hour = this.dayNight.hour;
			this.dayNightGui.period = this.dayNight.period;
			this.dayNightGui.auto = this.dayNight.auto;
			if (this.sceneProps.mapMode) {
				// Day/night re-applies FogExp2 every frame — keep it off in edit top-down.
				this.suppressFogForEditMode();
			} else {
				this.syncVolumetricFogFrame(now * 0.001);
			}
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

			// Lamp glow: same evening/night curve as fireflies (big soft sprite).
			this.lampFireflyGlow?.setIntensity(fireflyIntensity);
		}

		if (!this.isWorldSwitching && this.isGameActive && this.car && this.carInput && this.chaseCameraInput && this.human && this.humanInput) {
			const playAllowed = this.orientationGate?.isPlayAllowed() ?? true;
			const world = getWorld();
			world.timestep = dt;

			if (playAllowed) {
				if (this.activePlayer === "car") {
					this.carInput.applyInput(dt);
					if (this.vehicleGrapple) {
						const justPressed = this.carInput.consumeGrapplePress();
						const detachPressed = this.carInput.consumeGrappleDetach();
						this.vehicleGrapple.update(
							dt,
							this.carInput.isGrappleHeld,
							justPressed,
							detachPressed
						);
					}
				} else {
					this.vehicleGrapple?.release();
					if (this.localDead) {
						this.humanInput.forceCloseWeaponWheel();
						this.humanInput.isEnabled = false;
					} else if (!this.isBeingCarriedBy && this.sitState === "none") {
						this.humanInput.isEnabled = true;
						this.humanInput.update(dt, this.camera);
					} else {
						this.humanInput.forceCloseWeaponWheel();
						this.humanInput.isEnabled = false;
					}
				}
				if (this.localDead) {
					this.updateLocalDeath(dt);
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
					worldPos.y += HumanEntity.MESH_Y_OFFSET; // Add physics body offset

					this.human.body.setTranslation(worldPos, true);
					this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
				}
				this.human.playAnimation("being carried");
			}

			world.step();

			if (playAllowed) {
				if (this.activePlayer === "car") {
					this.carInput.afterPhysics(dt);
					if (this.vehicleGrapple?.isAttached()) {
						this.vehicleGrapple.afterPhysics(dt);
					}
				}
				this.human.update(dt);
			}
			syncCar(this.car);

			if (
				this.smokeSystem &&
				this.carController &&
				this.activePlayer === "car" &&
				this.car
			) {
				if (this.carController.consumeTireSmokeBurst(dt)) {
					const driveWheels = this.carController.getDriveWheelIndices();
					const _smokePos = new THREE.Vector3();
					// Always both rear tires together.
					for (const wi of driveWheels) {
						const wheel = this.car.wheels[wi];
						if (!wheel) continue;
						wheel.getWorldPosition(_smokePos);
						_smokePos.y = getWorldTerrainY(_smokePos.x, _smokePos.z) + 0.12;
						this.smokeSystem.emitTire(_smokePos);
					}
				}
			}

			if (this.engineSound && this.carController) {
				if (this.activePlayer === "car") {
					const speed = this.carController.getSpeed();
					const throttle = this.carController.getThrottle();
					this.engineSound.update(speed, throttle);
				} else {
					this.engineSound.update(0, 0, undefined, true);
				}
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

								// Fuse delay after landing (same as before)
								const blastId = bomb.id;
								setTimeout(() => {
									this.detonateBomb(blastId);
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
					const aimMode = Boolean(this.humanInput?.isAimingGun());
					updateHumanCamera(
						this.camera,
						this.human,
						this.chaseCameraInput,
						dt,
						{ aimMode }
					);
					this.syncGunToHand();
				}
			}

			this.updateBenchSit(dt);

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
					} else if (
						this.sitState === "sitting" ||
						this.sitState === "entering" ||
						(this.isNearBench() && this.getFreeBenchSeat() != null)
					) {
						this.interactionPrompt.style.display = "flex";
						this.interactionPrompt.style.alignItems = "center";
						this.interactionPrompt.style.justifyContent = "center";
						this.interactionPrompt.textContent = "E";
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

			// Leave the map → wait 2s → respawn on terrain
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

				// Human respawn (skip while dead — combat respawn handles that)
				if (this.human && !this.localDead) {
					const ht = this.human.body.translation();
					const isOutside = isOutsideTerrain(ht.x, ht.y, ht.z);

					if (isOutside) {
						this.humanOutOfWorldTimer += dt;
						if (this.humanOutOfWorldTimer >= 2) {
							this.respawnHumanOnTerrain();
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
					throttle: this.carController ? this.carController.getThrottle() : 0,
					honking: this.carInput?.isHonking ?? false,
					benchSeat:
						this.sitState === "sitting" || this.sitState === "entering"
							? this.sitSeatIndex
							: null,
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

				state.hp = this.localHp;
				state.dead = this.localDead;
				state.aiming = Boolean(this.humanInput?.isAimingGun());
				state.firing = Boolean(this.humanInput?.isFiringGun());

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

		// Bullets after remotes so hit bones match the posed frame
		if (this.bulletSystem && this.humanInput) {
			const targets = this.humanInput.getPunchTargets?.() ?? [];
			const bombTargets = this.bombs
				.filter((b) => !this.detonatingBombIds.has(b.id))
				.map((b) => {
					b.mesh.getWorldPosition(this._bombWorldPos);
					return { id: b.id, position: this._bombWorldPos.clone() };
				});
			this.bulletSystem.update(dt, targets, bombTargets);
		}

		this.volumetricFogPass?.render(
			this.renderer,
			this.scene,
			this.editMode?.isEnabled ? this.editMode.activeCamera : this.camera
		);
		this.stats.update();

		if (this.editMode?.isEnabled) {
			this.editMode.update();
		}

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
			grassCullDistance: this.grassCullDistance,
			carPower: CAR_CONFIG.drive.engineForce,
			world: this.currentWorld,
			worldOptions: this.getWorldSelectOptions(),
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
			onGrassCullDistanceChange: (meters) => this.setGrassCullDistance(meters),
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
		this.editorWaterFrameCounter = 0;
		this.editorWaterDeltaAccumulator = 0;
		this.resizePondTargets();
		const pr = this.renderer.getPixelRatio();
		this.volumetricFogPass?.setSize(
			window.innerWidth * pr,
			window.innerHeight * pr
		);
		this.syncVolumetricFogQuality();
	}

	/** Screen-space fog on Medium/High; billboard fallback only on Low. */
	private syncVolumetricFogQuality() {
		const quality = this.graphicsQuality;
		const pass = this.volumetricFogPass;
		const billboards = this.volumetricFog;
		const inEdit = this.sceneProps.mapMode;

		if (pass) {
			pass.setQuality(quality);
			pass.enabled = !inEdit && quality !== "Low";
		}
		if (billboards) {
			billboards.group.visible = !inEdit && quality === "Low";
		}
		if (pass?.enabled && this.scene.fog instanceof THREE.FogExp2) {
			this.scene.fog.density = this.residualFogDensity;
		} else if (!inEdit && this.scene.fog instanceof THREE.FogExp2) {
			this.scene.fog.density = this.atmosphereFogDensity;
		}
	}

	/**
	 * Feed day/night (or world-override) atmosphere into the raymarch pass and
	 * keep FogExp2 as a light residual so materials don't double-fog.
	 */
	private syncVolumetricFogFrame(timeSec: number) {
		const pass = this.volumetricFogPass;
		if (!pass?.enabled || !this.dayNight) return;

		// Always center the fog ring on the player.
		if (this.activePlayer === "human" && this.human?.mesh) {
			this._fogCenter.copy(this.human.mesh.position);
		} else if (this.car?.mesh) {
			this._fogCenter.copy(this.car.mesh.position);
		} else {
			this._fogCenter.copy(this.camera.position);
		}

		const override = this.dayNight.overrideColors;
		const fogColor = override
			? this.scene.fog instanceof THREE.FogExp2
				? this.scene.fog.color
				: this._fogColorTmp.set(this.sceneProps.fogColor)
			: this.dayNight.getFogColor();

		const timeScale = fogDensityScaleForHour(this.dayNight.hour);
		// Lower base than before; morning ≈ this amount, noon clearer, night a bit more.
		const baseDensity = override
			? this.volumetricFogDensity
			: Math.max(
				this.volumetricFogDensity * 0.55,
				this.dayNight.getFogDensity() * 0.65
			);
		const tableDensity = baseDensity * timeScale;

		const key = this.dayNight.lights.keyLight;
		const sunDir = this.dayNight.getSunDirection();

		pass.setParams({
			fogColor,
			fogDensity: tableDensity,
			fogCenter: this._fogCenter,
			fogRadius: PLAYER_FOG_RADIUS,
			fogRadiusSoft: PLAYER_FOG_BAND,
			fogHeight: 0,
			// ln(2)/15 ≈ half density on ~15m hills
			heightFalloff: Math.LN2 / 15,
			sunDirection: sunDir,
			sunColor: key.color,
			sunIntensity: Math.min(0.85, key.intensity * 0.16),
			time: timeSec,
		});

		// Almost no global FogExp2 — volume is local to the player ring.
		if (this.scene.fog instanceof THREE.FogExp2) {
			this.scene.fog.color.copy(fogColor);
			this.scene.fog.density = this.residualFogDensity * 0.35 * timeScale;
		}
		if (this.volumetricFog) {
			this.volumetricFog.setColor(fogColor);
		}
	}

	private resizePondTargets() {
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
		const w = Math.min(
			maxDimension,
			Math.max(1, Math.floor(window.innerWidth * pixelRatio * targetScale))
		);
		const h = Math.min(
			maxDimension,
			Math.max(1, Math.floor(window.innerHeight * pixelRatio * targetScale))
		);
		this.pond?.setSize(w, h);
		for (const pond of this.editorPonds) {
			pond.setSize(w, h);
		}
	}

	private updateEditorPonds(dt: number) {
		if (!this.editorPonds.length) return;

		const cam = this.editMode?.isEnabled
			? this.editMode.activeCamera
			: this.camera;
		cam.updateMatrixWorld();
		this.viewProjectionMatrix.multiplyMatrices(
			cam.projectionMatrix,
			cam.matrixWorldInverse
		);
		this.viewFrustum.setFromProjectionMatrix(this.viewProjectionMatrix);

		const ranked: Array<{ pond: Pond; dist: number }> = [];
		const camPos = cam.position;

		for (const pond of this.editorPonds) {
			pond.mesh.updateWorldMatrix(true, false);
			// Same as island pond: only draw when the camera is actually looking at it.
			const inView = this.viewFrustum.intersectsObject(pond.mesh);
			pond.mesh.visible = inView;
			if (!inView) continue;
			const dx = pond.mesh.position.x - camPos.x;
			const dz = pond.mesh.position.z - camPos.z;
			const dist = Math.hypot(dx, dz);
			ranked.push({ pond, dist });
		}

		ranked.sort((a, b) => a.dist - b.dist);

		// Same cadence as the island Pond: accumulate dt, then run full
		// reflection / refraction / ripple simulation passes.
		this.editorWaterDeltaAccumulator = Math.min(
			0.1,
			this.editorWaterDeltaAccumulator + dt
		);
		this.editorWaterFrameCounter++;
		const interval = Math.max(1, this.waterUpdateInterval);
		const runFull = this.editorWaterFrameCounter >= interval;
		const simDt = runFull ? this.editorWaterDeltaAccumulator : dt;

		for (let i = 0; i < ranked.length; i++) {
			const { pond } = ranked[i]!;
			// Nearest ponds get the full island shader pipeline.
			if (i < 3 && runFull) {
				pond.update(simDt, { full: true });
			} else {
				pond.update(dt, { full: false });
			}
		}

		if (runFull) {
			this.editorWaterFrameCounter = 0;
			this.editorWaterDeltaAccumulator = 0;
		}

		this.injectEditorPondRipples();
	}

	/**
	 * Soft natural ripples at random intervals so still water doesn’t feel dead.
	 * Picks a visible pond and drops 1–3 light disturbances.
	 */
	private maybeInjectAmbientWaterRipples(now: number) {
		if (this.nextAmbientRippleAt === 0) {
			this.nextAmbientRippleAt = now + 800 + Math.random() * 1600;
			return;
		}
		if (now < this.nextAmbientRippleAt) return;

		const candidates: Pond[] = [];
		if (
			this.pond &&
			this.pond.mesh.visible &&
			this.currentWorld === "island" &&
			this.worldGroup.visible
		) {
			candidates.push(this.pond);
		}
		for (const pond of this.editorPonds) {
			if (pond.mesh.visible) candidates.push(pond);
		}
		if (candidates.length === 0) {
			// Retry soon rather than idling a full interval before water exists.
			this.nextAmbientRippleAt = now + 800;
			return;
		}

		// One pond gets a drip per event, so more water needs more events — a
		// single pond keeps the tuned ~1.5–5.5 s cadence.
		const spread = Math.min(3, candidates.length);
		this.nextAmbientRippleAt = now + (1500 + Math.random() * 4000) / spread;

		const pond = candidates[Math.floor(Math.random() * candidates.length)]!;
		this.spawnNaturalRipples(pond);
	}

	/** 1–3 soft drips / wind puffs somewhere on the pond surface. */
	private spawnNaturalRipples(pond: Pond) {
		const halfW =
			Number(pond.mesh.userData.waterHalfW) ||
			Number(pond.mesh.userData.waterRadius) ||
			10;
		const halfD = Number(pond.mesh.userData.waterHalfD) || halfW;
		const cx = pond.mesh.position.x;
		const cz = pond.mesh.position.z;
		const circular =
			Boolean(pond.mesh.userData.waterRadius) &&
			pond.mesh.userData.waterHalfW == null;
		// Island pond is circular 20×20 with no userData — treat as circle of r≈9.
		const useCircle = circular || (halfW === halfD && !pond.mesh.userData.waterHalfW);

		// Scale activity with surface area — a fixed 1–3 drips is a lively pond at
		// 20 m and an almost still sheet on a 100 m lake. Reference pond keeps 1–3.
		const surface = useCircle
			? Math.PI * halfW * halfW
			: halfW * 2 * (halfD * 2);
		const areaDrops = THREE.MathUtils.clamp(Math.round(surface / 400), 1, 6);
		const drops =
			areaDrops +
			(Math.random() < 0.4 ? 1 + Math.floor(Math.random() * 2) : 0);
		// Stamp size follows the pond too: a 0.85 m dimple on a big lake covers
		// only a couple of simulation texels and dies before it is visible.
		const stampScale = THREE.MathUtils.clamp(
			Math.max(halfW, halfD) / 10,
			1,
			4
		);
		const baseX = useCircle
			? cx + (Math.random() * 2 - 1) * halfW * 0.55
			: cx + (Math.random() * 2 - 1) * halfW * 0.7;
		const baseZ = useCircle
			? cz + (Math.random() * 2 - 1) * halfW * 0.55
			: cz + (Math.random() * 2 - 1) * halfD * 0.7;

		for (let i = 0; i < drops; i++) {
			// Spread the cluster wider on big water so drips are not all in one spot.
			const jitter = i === 0 ? 0 : (0.4 + Math.random() * 1.2) * stampScale;
			const ang = Math.random() * Math.PI * 2;
			let x = baseX + Math.cos(ang) * jitter;
			let z = baseZ + Math.sin(ang) * jitter;
			if (useCircle) {
				const dx = x - cx;
				const dz = z - cz;
				const maxR = halfW * 0.78;
				const d = Math.hypot(dx, dz);
				if (d > maxR && d > 1e-6) {
					const s = maxR / d;
					x = cx + dx * s;
					z = cz + dz * s;
				}
			}
			pond.createRipple({
				position: { x, z },
				strength: (0.05 + Math.random() * 0.09) * stampScale,
				radius: (0.55 + Math.random() * 1.0) * stampScale,
			});
		}
	}

	/** Same car / human / bomb ripples as the island pond (own throttle). */
	private injectEditorPondRipples() {
		const now = performance.now();
		if (now - this.lastEditorRippleInjection < 100) return;
		let didRipple = false;

		for (const pond of this.editorPonds) {
			if (!pond.mesh.visible) continue;
			const waterY = pond.mesh.position.y;
			const halfW = Number(pond.mesh.userData.waterHalfW) || Number(pond.mesh.userData.waterRadius) || 10;
			const halfD = Number(pond.mesh.userData.waterHalfD) || halfW;
			const inBasin = (x: number, z: number) => {
				const dx = Math.abs(x - pond.mesh.position.x);
				const dz = Math.abs(z - pond.mesh.position.z);
				return dx <= halfW + 1.5 && dz <= halfD + 1.5;
			};

			if (this.car?.body) {
				const p = this.car.mesh.position;
				if (inBasin(p.x, p.z) && Math.abs(p.y - waterY) < 2.0) {
					const speed = this.car.body.linvel();
					const velocity = Math.hypot(speed.x, speed.z);
					if (velocity > 1.0) {
						pond.createRipple({
							position: p,
							strength: Math.min(0.5, velocity * 0.05),
							radius: 1.5,
						});
						didRipple = true;
					}
				}
			}

			if (this.human?.body) {
				const p = this.human.mesh.position;
				if (inBasin(p.x, p.z) && Math.abs(p.y - waterY) < 1.0) {
					const speed = this.human.body.linvel();
					const velocity = Math.hypot(speed.x, speed.z);
					if (velocity > 0.5) {
						pond.createRipple({
							position: p,
							strength: 0.1,
							radius: 0.8,
						});
						didRipple = true;
					}
				}
			}

			for (const bomb of this.bombs) {
				if (!bomb.body) continue;
				const p = bomb.mesh.position;
				if (inBasin(p.x, p.z) && Math.abs(p.y - waterY) < 0.5) {
					const speed = bomb.body.linvel();
					const velocity = Math.hypot(speed.x, speed.z);
					if (velocity > 0.5) {
						pond.createRipple({
							position: p,
							strength: 0.05,
							radius: 0.5,
						});
						didRipple = true;
					}
				}
			}
		}

		if (didRipple) this.lastEditorRippleInjection = now;
	}

	/** Hide trees / placed stones beyond ~200 m (same on every world). */
	private updateMeshDistanceCulling(cameraPos: THREE.Vector3) {
		const hideAt = 200;
		const showAt = 170;
		for (const tree of this.trees) {
			const dx = tree.group.position.x - cameraPos.x;
			const dz = tree.group.position.z - cameraPos.z;
			const dist = Math.hypot(dx, dz);
			if (tree.group.visible) {
				if (dist > hideAt) tree.group.visible = false;
			} else if (dist < showAt) {
				tree.group.visible = true;
			}
		}
		for (const stone of this.editorStones) {
			const p = stone.group.position;
			const dx = p.x - cameraPos.x;
			const dz = p.z - cameraPos.z;
			const dist = Math.hypot(dx, dz);
			if (stone.group.visible) {
				if (dist > hideAt) stone.group.visible = false;
			} else if (dist < showAt) {
				stone.group.visible = true;
			}
		}
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
		this.customGrassField?.setDensity(this.grassDensity);
	}

	private setGrassCullDistance(meters: number) {
		this.grassCullDistance = THREE.MathUtils.clamp(meters, 30, 250);
		this.islandGrassField?.setCullDistance(this.grassCullDistance);
		this.valleyGrassField?.setCullDistance(this.grassCullDistance);
		this.customGrassField?.setCullDistance(this.grassCullDistance);
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
			} else if (this.interactionPrompt!.textContent === "E") {
				this.tryToggleBenchSit();
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
		statsDom.style.bottom = "58px";
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

	private setupEditMode() {
		this.editMode = new EditModeController({
			scene: this.scene,
			renderer: this.renderer,
			playCamera: this.camera,
			canvas: this.canvas,
			getEditWorldGroup: () => {
				if (this.currentWorld === "valley") return this.newWorldGroup;
				if (this.activeWorldDef.kind === "custom") return this.customWorldGroup;
				return this.worldGroup;
			},
			getTerrainMesh: () => {
				if (this.activeWorldDef.kind === "custom") return this.customTerrainMesh;
				if (this.currentWorld === "valley") return this.valleyTerrainMesh;
				return this.islandTerrainMesh;
			},
			getTerrainHeights: () => {
				if (this.activeWorldDef.kind === "custom") return this.customHeights;
				if (this.currentWorld === "valley") return this.valleyHeights;
				return this.islandHeights;
			},
			getTerrainHandle: () => {
				if (this.activeWorldDef.kind === "custom") return this.customTerrainHandle;
				return this.islandTerrainHandle;
			},
			setTerrainHandle: (handle) => {
				if (this.activeWorldDef.kind === "custom") this.customTerrainHandle = handle;
				else this.islandTerrainHandle = handle;
			},
			getGrassField: () => {
				if (this.activeWorldDef.kind === "custom") return this.customGrassField;
				if (this.currentWorld === "valley") return this.valleyGrassField;
				return this.islandGrassField;
			},
			getActiveWorldDefinition: () => this.activeWorldDef,
			getWorldDefinitionById: (worldId) => {
				if (worldId === "island") return ISLAND_WORLD;
				if (worldId === "valley") return VALLEY_WORLD;
				return this.customWorldDefs.find((w) => w.id === worldId) ?? null;
			},
			ensureWorldDefinition: (definition) => {
				if (definition.kind !== "custom") return;
				const index = this.customWorldDefs.findIndex((w) => w.id === definition.id);
				if (index >= 0) this.customWorldDefs[index] = definition;
				else this.customWorldDefs.push(definition);
				this.refreshWorldSelectOptions();
			},
			enableTerrainVertexColors: () => {
				const mesh = this.activeWorldDef.kind === "custom"
					? this.customTerrainMesh
					: this.currentWorld === "valley"
						? this.valleyTerrainMesh
						: this.islandTerrainMesh;
				const mat = (mesh?.material as THREE.MeshPhongMaterial | undefined) ?? this.terrainMat;
				mat.vertexColors = true;
				// Keep albedo white so vertex greens (and mud) show at full strength.
				mat.color.setHex(0xffffff);
				mat.needsUpdate = true;
			},
			setMapMode: (enabled) => {
				this.sceneProps.mapMode = enabled;
				if (this.carInput) {
					this.carInput.isEnabled =
						!enabled && this.isGameActive && this.activePlayer === "car";
				}
				if (this.humanInput) {
					this.humanInput.isEnabled =
						!enabled &&
						this.isGameActive &&
						this.activePlayer === "human" &&
						this.sitState === "none";
				}
				this.applyEditMapAtmosphere(enabled);
			},
			addEditorTree: (tree) => {
				this.trees.push(tree);
			},
			addEditorStone: (stone) => {
				this.editorStones.push(stone);
			},
			addEditorPond: (pond) => {
				this.editorPonds.push(pond);
				this.resizePondTargets();
			},
			removeEditorTree: (tree) => {
				this.trees = this.trees.filter((t) => t !== tree);
			},
			removeEditorStone: (stone) => {
				this.editorStones = this.editorStones.filter((s) => s !== stone);
			},
			removeEditorPond: (pond) => {
				this.editorPonds = this.editorPonds.filter((p) => p !== pond);
			},
			getScenePropsTerrainColor: () => this.sceneProps.terrainColor,
			isGameActive: () => this.isGameActive,
			getRoomCode: () => this.roomCode,
			createNewLargeWorld: async (sizeKm) => {
				await this.createAndEnterCustomWorld(sizeKm);
			},
			switchToWorldId: async (worldId) => {
				await this.switchWorld(worldId);
			},
			listLocalCustomWorlds: () => [...this.customWorldDefs],
			rebuildEditGrass: () => {
				this.rebuildActiveEditGrass();
			},
			liftPlayersAboveTerrain: () => {
				this.liftPlayersAboveTerrain();
			},
			onWorldsChanged: () => {
				void this.refreshSavedWorldList();
			},
			getAuthToken: () => this.authService.getToken(),
			getAuthUser: () => this.userData,
			getServerUrl: () => SERVER_URL,
		});
	}

	/**
	 * Refresh the saved-world list from the DB (GET /api/worlds?mine=1).
	 * Logged-out players only ever see the built-in hubs.
	 */
	private async refreshSavedWorldList() {
		const loggedIn = Boolean(this.authService.getToken() && this.userData?.id);
		if (!loggedIn) {
			// A logged-out tab keeps nothing: no list, no other account's worlds.
			this.savedWorldList = [];
			this.customWorldDefs = this.customWorldDefs.filter(
				(def) => def.id === this.activeWorldDef.id
			);
			this.editMode?.forgetCachedWorlds(this.activeWorldDef.id);
			this.refreshWorldSelectOptions();
			return;
		}
		if (!this.editMode) return;
		try {
			this.savedWorldList = await this.editMode.listMyWorlds();
		} catch (error) {
			console.warn("[world] Failed to list saved worlds", error);
			this.savedWorldList = [];
		}
		this.refreshWorldSelectOptions();
	}

	private refreshWorldSelectOptions() {
		if (!this.settings) return;
		this.settings.setWorldOptions(this.getWorldSelectOptions());
		this.settings.setWorld(this.currentWorld);
	}

	/**
	 * Built-in hubs + every world the DB knows about, plus any world created
	 * this session that has not been saved yet.
	 */
	private getWorldSelectOptions(): Record<string, string> {
		const names = new Map<string, string>();
		for (const def of this.customWorldDefs) names.set(def.id, def.name);
		// DB names win — another device may have renamed the world.
		for (const item of this.savedWorldList) {
			names.set(item.worldId, item.worldName || item.worldId);
		}

		const options: Record<string, string> = {
			Island: "island",
			Valley: "valley",
		};
		for (const [worldId, name] of names) {
			// dat.GUI keys on the label, so keep duplicate names distinguishable.
			const label = name in options ? `${name} (${worldId.slice(-4)})` : name;
			options[label] = worldId;
		}
		return options;
	}

	private async createAndEnterCustomWorld(sizeKm = 1) {
		const kmLabel =
			sizeKm >= 1 ? `${sizeKm.toFixed(sizeKm % 1 === 0 ? 0 : 1)}km` : `${Math.round(sizeKm * 1000)}m`;
		const worldNumber =
			Math.max(this.customWorldDefs.length, this.savedWorldList.length) + 1;
		const def = createLargeBlankWorld(`World ${worldNumber} (${kmLabel})`, sizeKm);
		this.customWorldDefs.push(def);
		this.refreshWorldSelectOptions();
		await this.switchWorld(def.id);
	}

	/** Re-sample grass after undo/redo restores terrain (roads bury blades in place). */
	private rebuildActiveEditGrass() {
		const mesh = this.activeWorldDef.kind === "custom"
			? this.customTerrainMesh
			: this.currentWorld === "valley"
				? this.valleyTerrainMesh
				: this.islandTerrainMesh;
		const group =
			this.activeWorldDef.kind === "custom"
				? this.customWorldGroup
				: this.currentWorld === "valley"
					? this.newWorldGroup
					: this.worldGroup;
		if (!mesh || !this.grassGeometry) return;

		const previousCount = this.grassCount;
		this.grassCount = grassCountForSize(this.activeWorldDef.size);

		if (this.activeWorldDef.kind === "custom") {
			const heights = this.customHeights;
			const segs = this.activeWorldDef.segments;
			this.customGrassField?.dispose();
			this.customGrassField = this.addGrass(
				mesh,
				this.grassGeometry,
				group,
				new THREE.Vector2(1e6, 1e6),
				0.6,
				false,
				{
					chunkSize: 15,
					clearPondHole: false,
					evenCoverage: Boolean(heights),
					maxSlopeDeg: 65,
					heights: heights ?? undefined,
					nrows: segs,
					ncols: segs,
					terrainSize: this.activeWorldDef.size,
				}
			);
			this.customGrassField.setDensity(this.grassDensity);
		} else if (this.currentWorld === "valley") {
			this.valleyGrassField?.dispose();
			this.valleyGrassField = this.addGrass(
				mesh,
				this.grassGeometry,
				group,
				new THREE.Vector2(-20, 5),
				0.3,
				true
			);
			this.valleyGrassField.setDensity(this.grassDensity);
		} else {
			this.islandGrassField?.dispose();
			this.islandGrassField = this.addGrass(
				mesh,
				this.grassGeometry,
				group,
				new THREE.Vector2(-20, 5),
				0.6 // blade height only
			);
			this.islandGrassField.setDensity(this.grassDensity);
		}
		this.grassCount = previousCount;
		this.grassMaterial.setTerrainSize(this.activeWorldDef.size);
	}

	private async buildCustomWorld(def: WorldDefinition) {
		this.disposeCustomWorld();
		// Same green look as island until roads need vertex colors.
		const mat = new THREE.MeshPhongMaterial({
			color: this.sceneProps.terrainColor,
			shininess: 0,
			flatShading: true,
			vertexColors: false,
			side: THREE.DoubleSide,
		});
		const { mesh, heights, nrows, ncols, size } = createProceduralTerrain(mat, def);
		this.customTerrainMesh = mesh;
		this.customHeights = heights;
		this.customWorldGroup.add(mesh);
		mesh.updateMatrixWorld(true);
		setIslandTerrain(mesh);
		this.customTerrainHandle = createTerrainHeightfieldCollider(
			heights,
			nrows,
			ncols,
			size
		);

		const previousCount = this.grassCount;
		this.grassCount = grassCountForSize(def.size);
		this.customGrassField = this.addGrass(
			mesh,
			this.grassGeometry,
			this.customWorldGroup,
			new THREE.Vector2(1e6, 1e6),
			0.6,
			false,
			{
				chunkSize: 15,
				clearPondHole: false,
				evenCoverage: true,
				maxSlopeDeg: 65,
				heights,
				nrows,
				ncols,
				terrainSize: size,
			}
		);
		this.grassCount = previousCount;
		this.customGrassField.setDensity(this.grassDensity);
		this.grassMaterial.setTerrainSize(def.size);
	}

	private disposeCustomWorld() {
		this.disposeEditorPondsIn(this.customWorldGroup);
		for (const stone of this.editorStones) stone.dispose();
		this.editorStones = [];
		this.customGrassField?.dispose();
		this.customGrassField = null;
		this.customTerrainHandle?.dispose();
		this.customTerrainHandle = null;
		this.customTerrainMesh = null;
		this.customHeights = null;
		this.disposeWorldGroup(this.customWorldGroup);
	}

	private setupEventListeners() {
		window.addEventListener("resize", () => this.setAspectResolution(), false);

		const statsDom = (this.stats as unknown as { dom: HTMLElement }).dom;
		statsDom.addEventListener("click", () => {
			console.log(this.renderer.info.render);
		});

		// A form taking focus (login, etc.) drops whatever the player was holding,
		// so the car does not keep driving while they type.
		window.addEventListener("focusin", (e) => {
			if (!isTextEntryTarget(e.target)) return;
			this.carInput?.releaseControls();
			this.humanInput?.releaseControls();
		});

		// Clicking the world hands the keyboard back to the game — settings number
		// fields keep focus otherwise and would keep swallowing WASD.
		this.canvas.addEventListener("pointerdown", () => {
			if (isTextEntryFocused()) {
				(document.activeElement as HTMLElement | null)?.blur();
			}
		});

		window.addEventListener("keydown", (e) => {
			if (!this.isGameActive) return;
			// "u" / "e" are common letters — never hijack them while typing.
			if (isGameKeyBlocked(e)) return;
			const key = (e.key ?? "").toLowerCase();
			if (key === "u") {
				this.tryTogglePlayer();
			} else if (key === "e") {
				this.tryToggleBenchSit();
			}
		});
	}

	private isNearBench(): boolean {
		if (!this.human || !this.benchInteract) return false;
		if (this.activePlayer !== "human") return false;
		const p = this.human.mesh.position;
		for (const s of this.benchInteract.seats) {
			if (Math.hypot(p.x - s.x, p.z - s.z) < 2.6) return true;
		}
		return false;
	}

	/** First free seat index, or null if both taken (local + remotes). */
	private getFreeBenchSeat(): 0 | 1 | null {
		const taken = new Set<0 | 1>();
		if (
			this.sitSeatIndex != null &&
			(this.sitState === "sitting" ||
				this.sitState === "entering" ||
				this.sitState === "exiting")
		) {
			taken.add(this.sitSeatIndex);
		}
		for (const rp of this.remotePlayers.values()) {
			if (rp.benchSeat === 0 || rp.benchSeat === 1) taken.add(rp.benchSeat);
		}
		if (!taken.has(0)) return 0;
		if (!taken.has(1)) return 1;
		return null;
	}

	/** Sit / stand on the island bench (E). */
	private tryToggleBenchSit() {
		if (!this.human || !this.humanInput || !this.benchInteract) return;
		if (this.activePlayer !== "human") return;
		if (this.sitState === "entering" || this.sitState === "exiting") return;
		if (this.humanInput.isRecovering()) return;

		if (this.sitState === "sitting") {
			this.beginStandFromBench();
			return;
		}
		if (this.sitState === "none" && this.isNearBench()) {
			const seat = this.getFreeBenchSeat();
			if (seat == null) return; // Both seats full — no E / no sit
			this.beginSitOnBench(seat);
		}
	}

	private beginSitOnBench(seatIndex: 0 | 1) {
		if (!this.human || !this.humanInput || !this.benchInteract) return;
		const seat = this.benchInteract.seats[seatIndex];
		const yaw = this.benchInteract.yaw;
		this.sitSeatIndex = seatIndex;

		this.humanInput.isEnabled = false;
		this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
		this.human.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

		// Place feet on ground at this side of the bench; sit anim lowers hips onto the seat.
		const groundY = getWorldTerrainY(seat.x, seat.z);
		const bodyY = groundY + HumanEntity.MESH_Y_OFFSET;
		this.human.body.setTranslation({ x: seat.x, y: bodyY, z: seat.z }, true);

		const q = new THREE.Quaternion().setFromAxisAngle(
			new THREE.Vector3(0, 1, 0),
			yaw + Math.PI
		);
		this.human.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
		this.human.mesh.quaternion.copy(q);

		const duration = this.human.playAnimation("stand to sit");
		this.sitState = "entering";
		this.sitTimer = duration > 0 ? duration : 1.2;
	}

	private beginStandFromBench() {
		if (!this.human) return;
		const duration = this.human.playAnimation("sit to stand");
		this.sitState = "exiting";
		this.sitTimer = duration > 0 ? duration : 1.2;
	}

	private updateBenchSit(dt: number) {
		if (!this.human || this.sitState === "none") return;

		// Keep seated pose locked on our seat while sitting / transitioning.
		if (
			this.benchInteract &&
			this.sitSeatIndex != null &&
			(this.sitState === "entering" || this.sitState === "sitting")
		) {
			const seat = this.benchInteract.seats[this.sitSeatIndex];
			const yaw = this.benchInteract.yaw;
			const groundY = getWorldTerrainY(seat.x, seat.z);
			const sitRootY = Math.max(groundY, seat.y - 0.48);
			const bodyY = sitRootY + HumanEntity.MESH_Y_OFFSET;
			this.human.body.setTranslation({ x: seat.x, y: bodyY, z: seat.z }, true);
			this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			const q = new THREE.Quaternion().setFromAxisAngle(
				new THREE.Vector3(0, 1, 0),
				yaw + Math.PI
			);
			this.human.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
			this.human.mesh.quaternion.copy(q);
		}

		if (this.sitState === "entering") {
			this.sitTimer -= dt;
			if (this.sitTimer <= 0) {
				this.human.playAnimation("Sitting");
				this.sitState = "sitting";
			}
			return;
		}

		if (this.sitState === "sitting") {
			this.human.playAnimation("Sitting");
			return;
		}

		if (this.sitState === "exiting") {
			this.sitTimer -= dt;
			if (this.sitTimer <= 0) {
				this.human.playAnimation("idle");
				this.sitState = "none";
				this.sitSeatIndex = null;
				if (this.humanInput && this.activePlayer === "human") {
					this.humanInput.isEnabled = true;
				}
			}
		}
	}

	private tryTogglePlayer() {
		if (!this.car || !this.human) return;

		if (this.activePlayer === "car") {
			// Switch to human (can exit car anytime)
			this.activePlayer = "human";
			this.vehicleGrapple?.release();
			if (this.carInput) {
				this.carInput.isEnabled = false;
				this.carInput.releaseControls();
			}
			const spawnPos = this.car.mesh.position.clone();
			spawnPos.x += 3;
			spawnPos.y += 1;
			this.human.body.setTranslation(spawnPos, true);
			this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			this.human.mesh.visible = true;
			if (this.humanInput && this.sitState === "none") {
				this.humanInput.isEnabled = true;
			}
		} else {
			// Switch to car (must be near car)
			const distToCar = this.human.mesh.position.distanceTo(this.car.mesh.position);
			if (distToCar > 3.0) return; // Too far from car

			// Cancel bench sit if leaving for the car
			this.sitState = "none";
			this.sitTimer = 0;
			this.sitSeatIndex = null;
			if (this.humanInput) this.humanInput.isEnabled = false;

			this.activePlayer = "car";
			if (this.carInput) this.carInput.isEnabled = true;
			this.human.body.setTranslation(new THREE.Vector3(0, -100, 0), true);
			this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			this.human.mesh.visible = false;
		}
	}

	/** Def already in memory this session; falls back to Island. */
	private knownWorldDefinition(id: GameWorldId): WorldDefinition {
		if (id === "valley") return VALLEY_WORLD;
		if (id === "island") return ISLAND_WORLD;
		return this.customWorldDefs.find((w) => w.id === id) ?? ISLAND_WORLD;
	}

	/**
	 * Resolve a world def, fetching it from the DB when this session has not
	 * seen it yet (e.g. picked from the list after a reload).
	 */
	private async resolveWorldDefinition(
		id: GameWorldId
	): Promise<WorldDefinition | null> {
		if (id === "island") return ISLAND_WORLD;
		if (id === "valley") return VALLEY_WORLD;
		const known = this.customWorldDefs.find((w) => w.id === id);
		if (known) return known;
		const fetched = (await this.editMode?.loadWorldFromDb(id)) ?? null;
		if (!fetched) return null;
		this.customWorldDefs.push(fetched);
		return fetched;
	}

	private async switchWorld(target: GameWorldId) {
		if (target === this.currentWorld || this.isWorldSwitching) return;

		// Drop any hook anchored in the world we are leaving.
		this.vehicleGrapple?.release();

		const previous = this.currentWorld;
		const previousDef = this.activeWorldDef;
		// Claim the switch before awaiting the DB fetch so no second switch races in.
		this.isWorldSwitching = true;
		const targetDef = await this.resolveWorldDefinition(target).catch(() => null);
		if (!targetDef) {
			this.isWorldSwitching = false;
			this.settings.setWorld(previous);
			this.worldLoading.show(String(target));
			this.worldLoading.showError(
				"That world could not be loaded from your account."
			);
			throw new Error(`World "${target}" not found.`);
		}
		this.worldLoading.show(targetDef.name);

		try {
			this.worldLoading.setProgress(15, "Generating terrain and physics...");
			await this.nextFrame();

			if (target === "island") {
				await this.buildIslandWorld();
			} else if (target === "valley") {
				this.createValleyTerrain(0, 0, 0);
			} else {
				await this.buildCustomWorld(targetDef);
			}

			this.worldLoading.setProgress(65, "Compiling world graphics...");
			await this.renderer.compileAsync(this.scene, this.camera);
			await this.nextFrame();

			this.activeWorldDef = targetDef;
			this.currentWorld = target;
			this.worldGroup.visible = target === "island";
			this.newWorldGroup.visible = target === "valley";
			this.customWorldGroup.visible = targetDef.kind === "custom";
			this.applyWorldEnvironment(target);

			// Unload BEFORE replaying edits: the dispose paths clear editor ponds,
			// so ponds spawned by the replay would be destroyed right after birth.
			this.worldLoading.setProgress(74, "Unloading previous world...");
			await this.nextFrame();
			if (previous === "island") this.disposeIslandWorld();
			else if (previous === "valley") this.disposeValleyWorld();
			else if (previousDef.kind === "custom" && targetDef.kind !== "custom") {
				this.disposeCustomWorld();
			}
			this.renderer.renderLists.dispose();

			this.worldLoading.setProgress(82, "Restoring world edits...");
			this.editMode?.onGameActiveChanged(this.isGameActive);
			// Saved sculpt edits MUST land before the spawn height is sampled —
			// otherwise the player is placed on the pristine procedural surface and
			// the replayed hill closes over them.
			try {
				await this.editMode?.onActiveWorldChanged();
			} catch (error) {
				// A failed replay must not roll back an otherwise loaded world.
				console.warn("[world] Failed to restore saved edits", error);
			}

			this.worldLoading.setProgress(92, "Placing player safely...");
			this.teleportPlayerToCurrentTerrain(target);

			this.settings.setWorld(target);

			this.worldLoading.setProgress(100, "Ready");
			await this.nextFrame();
			this.worldLoading.hide();
		} catch (error) {
			if (target === "island") this.disposeIslandWorld();
			else if (target === "valley") this.disposeValleyWorld();
			else this.disposeCustomWorld();

			this.currentWorld = previous;
			this.activeWorldDef = previousDef;
			this.worldGroup.visible = previous === "island";
			this.newWorldGroup.visible = previous === "valley";
			this.customWorldGroup.visible = previousDef.kind === "custom";
			this.settings.setWorld(previous);
			const message = error instanceof Error ? error.message : "Unable to load world.";
			this.worldLoading.showError(message);
			throw error;
		} finally {
			this.isWorldSwitching = false;
		}
	}

	/**
	 * Terrain changed under the players — sculpting a hill, or replaying a saved
	 * world's edits, can close the surface over a body. Only bodies whose origin
	 * is below the surface are moved, so normal driving / walking is untouched.
	 */
	private liftPlayersAboveTerrain() {
		const lift = (body: RAPIER.RigidBody, clearance: number) => {
			const at = body.translation();
			const groundY = getWorldTerrainY(at.x, at.z);
			if (at.y >= groundY) return;
			body.setTranslation({ x: at.x, y: groundY + clearance, z: at.z }, true);
			body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			body.setAngvel({ x: 0, y: 0, z: 0 }, true);
		};

		if (this.car) lift(this.car.body, CAR_CONFIG.spawn.clearance);
		// Human sits deep underground while riding — never yank it out then.
		if (this.human && this.activePlayer === "human" && this.sitState === "none") {
			lift(this.human.body, 2);
		}
	}

	private teleportPlayerToCurrentTerrain(target: GameWorldId) {
		const x = 0;
		const z = target === "valley" ? this.valleySpawn.z : 0;
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
			// Sample at the human's own spot — 3 m away the hill may be metres higher.
			const humanX = x + 3;
			const humanGroundY = getWorldTerrainY(humanX, z);
			this.human.body.setTranslation(
				{ x: humanX, y: humanGroundY + 3, z },
				true
			);
			this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
		}
	}

	private applyWorldEnvironment(world: GameWorldId) {
		const sky = this.scene.getObjectByName("sky-dome");
		const def = this.knownWorldDefinition(world);
		this.currentFogRadius = fogRadiusForWorld(def);
		this.volumetricFogDensity = fogDensityForWorld(def);
		this.fogFollowPlayer = fogFollowsPlayer(def);

		if (world === "island" || def.kind === "custom") {
			this.grassMaterial.setTerrainSize(def.size);
			if (this.dayNight) {
				this.dayNight.overrideColors = false;
				this.dayNight.setHour(this.dayNightGui.hour);
			}
			if (sky) sky.visible = true;
			this.grassMaterial.uniforms.baseColor.value.set("#313f1b");
			this.grassMaterial.uniforms.tipColor1.value.set("#5e875e");
			this.grassMaterial.uniforms.tipColor2.value.set("#1f352a");
			this.scene.background = new THREE.Color(
				def.kind === "custom" ? "#87a4c0" : this.sceneProps.fogColor
			);
			this.atmosphereFogDensity =
				def.kind === "custom" ? 0.0035 : this.sceneProps.fogDensity;
			if (this.scene.fog instanceof THREE.FogExp2) {
				this.scene.fog.color.copy(this.scene.background as THREE.Color);
				this.scene.fog.density = this.volumetricFogPass?.enabled
					? this.residualFogDensity
					: this.atmosphereFogDensity;
			}
		} else {
			this.grassMaterial.setTerrainSize(200);
			if (this.dayNight) this.dayNight.overrideColors = true;
			if (sky) sky.visible = false;
			const color = new THREE.Color(0x1e2b2f);
			this.scene.background = color.clone();
			this.atmosphereFogDensity = 0.005;
			if (this.scene.fog instanceof THREE.FogExp2) {
				this.scene.fog.color.copy(color);
				this.scene.fog.density = this.volumetricFogPass?.enabled
					? this.residualFogDensity
					: this.atmosphereFogDensity;
			}
			this.grassMaterial.uniforms.baseColor.value.set(0x3e524e);
			this.grassMaterial.uniforms.tipColor1.value.set(0x799894);
			this.grassMaterial.uniforms.tipColor2.value.set(0x56726e);
		}
		if (this.sceneProps.mapMode) this.suppressFogForEditMode();
		else this.syncVolumetricFogQuality();
	}

	/** Ortho top cam sits hundreds of units up — FogExp2 turns the map pure white. */
	private suppressFogForEditMode() {
		if (this.scene.fog instanceof THREE.FogExp2) {
			this.scene.fog.density = 0;
			this.scene.fog.color.setHex(0x3d3d3d);
		}
		if (this.scene.background instanceof THREE.Color) {
			this.scene.background.setHex(0x3d3d3d);
		}
		if (this.volumetricFog) this.volumetricFog.group.visible = false;
		if (this.volumetricFogPass) this.volumetricFogPass.enabled = false;
	}

	private applyEditMapAtmosphere(enabled: boolean) {
		if (enabled) {
			const bg =
				this.scene.background instanceof THREE.Color
					? this.scene.background.clone()
					: new THREE.Color(this.sceneProps.fogColor);
			const density =
				this.scene.fog instanceof THREE.FogExp2
					? this.atmosphereFogDensity
					: this.sceneProps.fogDensity;
			this.editFogBackup = {
				density,
				bg,
				volVisible: this.volumetricFog?.group.visible ?? false,
				passEnabled: this.volumetricFogPass?.enabled ?? false,
			};
			// Local editor only: lock noon lighting. Other clients keep their own day/night.
			if (this.dayNight && !this.editDayNightBackup) {
				this.editDayNightBackup = {
					auto: this.dayNight.auto,
					hour: this.dayNight.hour,
				};
				this.dayNight.setPeriod("noon");
				this.dayNight.auto = false;
				this.dayNightGui.auto = false;
				this.dayNightGui.period = "noon";
				this.dayNightGui.hour = this.dayNight.hour;
			}
			this.suppressFogForEditMode();
			return;
		}

		if (this.editDayNightBackup && this.dayNight) {
			const { auto, hour } = this.editDayNightBackup;
			this.editDayNightBackup = null;
			this.dayNight.setHour(hour);
			this.dayNight.auto = auto;
			this.dayNightGui.auto = auto;
			this.dayNightGui.hour = hour;
			this.dayNightGui.period = this.dayNight.period;
		}

		const backup = this.editFogBackup;
		this.editFogBackup = null;
		if (!backup) {
			this.applyWorldEnvironment(this.currentWorld);
			return;
		}
		if (this.scene.background instanceof THREE.Color) {
			this.scene.background.copy(backup.bg);
		}
		if (this.scene.fog instanceof THREE.FogExp2) {
			this.scene.fog.color.copy(backup.bg);
			this.scene.fog.density = backup.density;
		}
		this.atmosphereFogDensity = backup.density;
		this.syncVolumetricFogQuality();
	}

	private disposeIslandWorld() {
		this.pond?.mesh.removeFromParent();
		this.pond?.dispose();
		this.pond = undefined;

		this.disposeEditorPondsIn(this.worldGroup);

		for (const stone of this.editorStones) stone.dispose();
		this.editorStones = [];

		this.pondStones?.dispose();
		this.pondStones = null;
		this.islandGrassField?.dispose();
		this.islandGrassField = null;

		for (const tree of this.trees) tree.dispose();
		this.trees = [];
		for (const prop of this.islandScenicProps) prop.dispose();
		this.islandScenicProps = [];
		this.benchInteract = null;
		this.sitState = "none";
		this.sitTimer = 0;
		this.sitSeatIndex = null;
		this.lampFireflyGlow?.dispose();
		this.lampFireflyGlow = null;
		this.fireflies?.dispose();
		this.fireflies = null;
		this.disposeBombs();

		this.islandTerrainHandle?.dispose();
		this.islandTerrainHandle = null;
		this.islandTerrainMesh = null;
		this.islandHeights = null;
		this.proceduralBridge?.dispose();
		this.proceduralBridge?.group.removeFromParent();
		this.proceduralBridge = null;

		this.disposeWorldGroup(this.worldGroup);
	}

	/**
	 * Dispose only the editor ponds living under `group`.
	 *
	 * editorPonds is one flat list across every world, so disposing it wholesale
	 * destroys the incoming world's water when unloading the outgoing one.
	 */
	private disposeEditorPondsIn(group: THREE.Object3D) {
		const kept: Pond[] = [];
		for (const pond of this.editorPonds) {
			let node: THREE.Object3D | null = pond.mesh;
			let owned = false;
			while (node) {
				if (node === group) {
					owned = true;
					break;
				}
				node = node.parent;
			}
			if (!owned) {
				kept.push(pond);
				continue;
			}
			pond.mesh.removeFromParent();
			pond.dispose();
		}
		this.editorPonds = kept;
		this.resizePondTargets();
	}

	private disposeValleyWorld() {
		this.disposeEditorPondsIn(this.newWorldGroup);
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
		this.valleyTerrainMesh = newTerrain;
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
		this.valleyHeights = heights;

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
		const pr = this.renderer.getPixelRatio();
		this.volumetricFogPass?.setSize(
			window.innerWidth * pr,
			window.innerHeight * pr
		);
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
