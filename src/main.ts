import * as THREE from "three";
import Stats from "stats-gl";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as dat from "dat.gui";
import RAPIER from "@dimforge/rapier3d-compat";
import { io, Socket } from "socket.io-client";

import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import { GrassMaterial } from "./GrassMaterial";
import { initPhysics, getWorld } from "./physics/world";
import { createTerrainHeightfieldCollider } from "./physics/terrainCollider";
import { setIslandTerrain, getWorldTerrainY } from "./terrain/islandHeight";
import { createLargeTerrain, TERRAIN_CONFIG } from "./terrain/createLargeTerrain";
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
	createDayNightCycle,
	type DayNightCycle,
	type DayPeriod,
} from "./environment/dayNightCycle";
import { createFireflies, type Fireflies } from "./environment/fireflies";
import { createMobileControls, type MobileControls } from "./ui/mobileControls";
import { createOrientationGate, type OrientationGate } from "./ui/orientationGate";

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
	private gui: dat.GUI;
	private sceneGUI: dat.GUI;
	private sceneProps = {
		fogColor: "#eeeeee",
		terrainColor: "#5e875e",
		fogDensity: 0.012,
		humanScale: 0.01,
	};
	private textures: { [key: string]: THREE.Texture } = {};
	
	private bombs: { mesh: THREE.Group, body: RAPIER.RigidBody | null, id: number }[] = [];

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
	private outOfWorldTimer = 0;

	private activePlayer: "car" | "human" = "car";
	private human: HumanEntity | null = null;
	private humanInput: HumanInput | null = null;
	private interactionPrompt: HTMLElement | null = null;

	private socket: Socket | null = null;
	private roomCode: string | null = null;
	private userData: any = null;
	private mySlotIndex: number = 0;
	private lobbyModels: THREE.Group[] = [];
	private lobbyMixers: THREE.AnimationMixer[] = [];
	private remotePlayers: Map<string, any> = new Map();

	private trees: TreeHandle[] = [];
	private dayNight: DayNightCycle | null = null;
	private fireflies: Fireflies | null = null;
	private mobileControls: MobileControls | null = null;
	private orientationGate: OrientationGate | null = null;
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

		this.gui = new dat.GUI();
		this.gui.hide(); // Hide until login
		this.sceneGUI = new dat.GUI({ title: "Scene Details" });
		this.sceneGUI.hide(); // Hide until login

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
		this.setupInteractionUI();
		this.orientationGate = createOrientationGate();
		this.dayNight = createDayNightCycle(this.scene, { shadowExtent: 90 });
		this.dayNight.auto = this.dayNightGui.auto;
		
		this.createBombs();
		this.dayNight.speed = this.dayNightGui.speed;

		(async () => {
			await initPhysics();
			await this.loadModels();
			await this.setupTrees();
			await this.setupCar();
			await this.setupHuman();
			await this.createLobbyModels();
		})();
	}

	async start() {
		const mark = (stage: string) => {
			console.log(`[FluffyGrass] ${stage}`);
			(window as unknown as { __bootStage?: string }).__bootStage = stage;
		};

		try {
			mark("ready");
			this.render();

			const loadingText = document.getElementById("loading-text");
			const playButton = document.getElementById("play-button") as HTMLButtonElement;
			const hostButton = document.getElementById("host-button") as HTMLButtonElement;
			if (loadingText) loadingText.textContent = "Ready to play!";
			
			let loginAction: "play" | "host" | "join" = "play";
			let joinRoomCode = "";

			const proceed = (action: "play"|"host"|"join", user: any) => {
				this.userData = user;
				if (action === "play") {
					this.isGameActive = true;
					this.gui.show();
					this.sceneGUI.show();
					if (this.carInput) this.carInput.isEnabled = true;
					if (this.humanInput) this.humanInput.isEnabled = true;
					const gameTopNav = document.getElementById("game-top-nav");
					if (gameTopNav) gameTopNav.style.display = "flex";
					const settingsToggle = document.getElementById("settings-toggle");
					if (settingsToggle) settingsToggle.style.display = "flex";
					const loadingScreen = document.getElementById("loading-screen");
					loadingScreen!.style.opacity = "0";
					setTimeout(() => { loadingScreen!.style.display = "none"; }, 500);
					
					for (const model of this.lobbyModels) {
						model.visible = false;
					}

					// Spawn based on slot index to avoid overlapping cars
					const spawnX = this.mySlotIndex * 8; 
					if (this.car && this.car.body) {
						const currPos = this.car.body.translation();
						this.car.body.setTranslation({ x: spawnX, y: currPos.y, z: currPos.z }, true);
					}
					// Also shift human (even if they are at -100 underground, shift X)
					if (this.human && this.human.body) {
						const currPos = this.human.body.translation();
						this.human.body.setTranslation({ x: spawnX, y: currPos.y, z: currPos.z }, true);
					}
				} else if (action === "host") {
					this.connectSocket("host");
				} else if (action === "join") {
					this.connectSocket("join", joinRoomCode);
				}
			};
			(window as any).proceedPlayFn = proceed;

			const checkTokenAndProceed = async (action: "play"|"host"|"join") => {
				loginAction = action;
				const loadingScreen = document.getElementById("loading-screen");
				const token = localStorage.getItem("authToken");
				
				if (token) {
					if (loadingText) loadingText.textContent = "Authenticating...";
					try {
						const res = await fetch(`${SERVER_URL}/api/auth/validate`, {
							headers: { "Authorization": `Bearer ${token}` }
						});
						const data = await res.json();
						if (res.ok) {
							proceed(action, data.user);
							return;
						} else {
							localStorage.removeItem("authToken");
							if (loadingText) loadingText.textContent = "Session expired. Please login.";
						}
					} catch (e) {
						console.error(e);
						if (loadingText) loadingText.textContent = "Authentication failed. Please login.";
					}
				}
				loadingScreen?.classList.remove("show-account");
				loadingScreen?.classList.add("show-login");
			};

			if (playButton) {
				playButton.textContent = "Play";
				playButton.disabled = false;
				playButton.classList.add("ready");
				playButton.addEventListener("click", () => checkTokenAndProceed("play"));
			}

			if (hostButton) {
				hostButton.disabled = false;
				hostButton.classList.add("ready");
				hostButton.style.display = "block";
				hostButton.addEventListener("click", () => checkTokenAndProceed("host"));
			}

			const joinButton = document.getElementById("join-button") as HTMLButtonElement;
			if (joinButton) {
				joinButton.disabled = false;
				joinButton.classList.add("ready");
				joinButton.style.display = "block";
				joinButton.addEventListener("click", () => {
					this.fetchRooms();
				});
			}

			// Setup Join Room Panel
			const submitJoinBtn = document.getElementById("submit-join-btn");
			const closeJoinBtn = document.getElementById("close-join-btn");
			const joinRoomCodeInput = document.getElementById("join-room-code") as HTMLInputElement;

			if (submitJoinBtn) {
				submitJoinBtn.addEventListener("click", () => {
					joinRoomCode = joinRoomCodeInput.value.trim().toUpperCase();
					if (joinRoomCode.length > 0) {
						checkTokenAndProceed("join");
					}
				});
			}
			if (closeJoinBtn) {
				closeJoinBtn.addEventListener("click", () => {
					document.getElementById("loading-screen")?.classList.remove("show-join");
				});
			}

			// Setup Account Split Panel
			const createAccountBtn = document.getElementById("create-account-btn");
			const loadingScreen = document.getElementById("loading-screen");
			const closeAccountBtn = document.getElementById("close-account-btn");
			const submitAccountBtn = document.getElementById("submit-account-btn");
			const accountSuccessMsg = document.getElementById("account-success-msg");

			if (createAccountBtn && loadingScreen) {
				createAccountBtn.addEventListener("click", () => {
					loadingScreen.classList.remove("show-login");
					loadingScreen.classList.add("show-account");
				});
			}
			if (closeAccountBtn && loadingScreen) {
				closeAccountBtn.addEventListener("click", () => {
					loadingScreen.classList.remove("show-account");
				});
			}
			if (submitAccountBtn && accountSuccessMsg && loadingScreen) {
				submitAccountBtn.addEventListener("click", async () => {
					const usernameInput = document.getElementById("username") as HTMLInputElement;
					const emailInput = document.getElementById("email") as HTMLInputElement;
					const username = usernameInput?.value;
					const email = emailInput?.value;

					if (!username || !email) {
						accountSuccessMsg.textContent = "Please fill in all fields.";
						accountSuccessMsg.style.color = "#ff6b6b";
						accountSuccessMsg.style.display = "block";
						return;
					}

					try {
						const res = await fetch(`${SERVER_URL}/api/auth/register`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ username, email })
						});

						const data = await res.json();
						if (res.ok) {
							accountSuccessMsg.textContent = "Account created successfully!";
							accountSuccessMsg.style.color = "#a3d977";
							accountSuccessMsg.style.display = "block";
							setTimeout(() => {
								loadingScreen.classList.remove("show-account");
								accountSuccessMsg.style.display = "none";
								usernameInput.value = "";
								emailInput.value = "";
							}, 1500);
						} else {
							accountSuccessMsg.textContent = data.error || "Failed to create account.";
							accountSuccessMsg.style.color = "#ff6b6b";
							accountSuccessMsg.style.display = "block";
						}
					} catch (err) {
						accountSuccessMsg.textContent = "Error connecting to server. Is it running?";
						accountSuccessMsg.style.color = "#ff6b6b";
						accountSuccessMsg.style.display = "block";
					}
				});
			}

			// Setup Login Panel
			const closeLoginBtn = document.getElementById("close-login-btn");
			const submitLoginBtn = document.getElementById("submit-login-btn");
			const loginErrorMsg = document.getElementById("login-error-msg");

			if (closeLoginBtn && loadingScreen) {
				closeLoginBtn.addEventListener("click", () => {
					loadingScreen.classList.remove("show-login");
				});
			}

			if (submitLoginBtn && loginErrorMsg && loadingScreen) {
				submitLoginBtn.addEventListener("click", async () => {
					const emailInput = document.getElementById("login-email") as HTMLInputElement;
					const email = emailInput?.value;

					if (!email) {
						loginErrorMsg.textContent = "Please provide an email.";
						loginErrorMsg.style.display = "block";
						return;
					}

					try {
						const res = await fetch(`${SERVER_URL}/api/auth/login`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ email })
						});

						const data = await res.json();
						if (res.ok) {
							// Store token in local storage if backend provided it
							if (data.token) {
								localStorage.setItem("authToken", data.token);
							}

							// LOGIN SUCCESS: Route to the correct action (play, host, join)
							proceed(loginAction, data.user);
						} else {
							loginErrorMsg.textContent = data.error || "Login failed.";
							loginErrorMsg.style.display = "block";
						}
					} catch (err) {
						loginErrorMsg.textContent = "Server is not running!";
						loginErrorMsg.style.display = "block";
					}
				});
			}

			// Setup Logout Modal
			const logoutBtn = document.getElementById("logout-btn");
			const logoutModal = document.getElementById("logout-confirm-modal");
			const confirmLogoutBtn = document.getElementById("confirm-logout-btn");
			const cancelLogoutBtn = document.getElementById("cancel-logout-btn");
			
			if (logoutBtn && logoutModal && confirmLogoutBtn && cancelLogoutBtn) {
				logoutBtn.addEventListener("click", () => {
					logoutModal.style.display = "flex";
				});
				cancelLogoutBtn.addEventListener("click", () => {
					logoutModal.style.display = "none";
				});
				confirmLogoutBtn.addEventListener("click", () => {
					localStorage.removeItem("authToken");
					window.location.reload();
				});
			}

			// Setup In-Game Host
			const inGameHostBtn = document.getElementById("in-game-host-btn");
			const hostConfirmModal = document.getElementById("host-confirm-modal");
			const confirmHostBtn = document.getElementById("confirm-host-btn");
			const cancelHostBtn = document.getElementById("cancel-host-btn");

			if (inGameHostBtn && hostConfirmModal && confirmHostBtn && cancelHostBtn) {
				inGameHostBtn.addEventListener("click", () => {
					hostConfirmModal.style.display = "flex";
				});
				cancelHostBtn.addEventListener("click", () => {
					hostConfirmModal.style.display = "none";
				});
				confirmHostBtn.addEventListener("click", () => {
					hostConfirmModal.style.display = "none";
					this.connectSocket("host");
				});
			}

			// Setup In-Game Join
			const inGameJoinBtn = document.getElementById("in-game-join-btn");
			if (inGameJoinBtn) {
				inGameJoinBtn.addEventListener("click", () => {
					this.fetchRooms();
				});
			}

			// Setup Room List Panel Buttons
			const closeRoomListBtn = document.getElementById("close-room-list-btn");
			const refreshRoomsBtn = document.getElementById("refresh-rooms-btn");
			const roomListPanel = document.getElementById("room-list-panel");
			
			if (closeRoomListBtn && roomListPanel) {
				closeRoomListBtn.addEventListener("click", () => {
					roomListPanel.style.display = "none";
					
					// If they were in-game, bring back the top nav
					if (this.isGameActive) {
						const gameTopNav = document.getElementById("game-top-nav");
						if (gameTopNav) gameTopNav.style.display = "flex";
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
					if (this.socket) {
						this.socket.disconnect();
						this.socket = null; // Clear socket so we can reconnect later
					}
					
					if (this.userData || localStorage.getItem("authToken")) {
						document.getElementById("lobby-panel")!.style.display = "none";
						proceed("play", this.userData);
					} else {
						window.location.reload();
					}
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

	private ensureSocket() {
		if (!this.socket) {
			this.socket = io(SERVER_URL);
			
			this.socket.on("room-updated", (players: any[]) => {
				for (let i = 0; i < 4; i++) {
					const slot = document.querySelector(`#player-slot-${i} .slot-content`);
					if (slot) {
						if (i < players.length) {
							slot.textContent = players[i].user.username;
							slot.classList.remove("empty");
							slot.classList.add("filled");
							if (this.lobbyModels[i]) this.lobbyModels[i].visible = true;
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
					body.applyImpulse(velocity, true);
				}
			});

			this.socket.on("player-state-updated", async (data: any) => {
				const { socketId, state } = data;
				
				// Ensure remote player object exists
				let rp = this.remotePlayers.get(socketId);
				if (!rp) {
					// Async load the remote models
					rp = { loaded: false };
					this.remotePlayers.set(socketId, rp);

					const humanGltf = await this.loadGltfFull("/poutine.glb");
					const humanGroup = humanGltf.scene;
					humanGroup.scale.setScalar(this.sceneProps.humanScale);
					this.scene.add(humanGroup);
					
					const mixer = new THREE.AnimationMixer(humanGroup);
					const animations = new Map<string, THREE.AnimationAction>();
					humanGltf.animations.forEach((clip: any) => {
						animations.set(clip.name.toLowerCase(), mixer.clipAction(clip));
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

					rp = {
						loaded: true,
						humanGroup,
						carGroup,
						mixer,
						animations,
						currentAction: null,
						targetPosition: new THREE.Vector3(),
						targetQuaternion: new THREE.Quaternion()
					};
					
					// Avoid overwriting if they disconnected while loading
					if (this.remotePlayers.has(socketId)) {
						this.remotePlayers.set(socketId, rp);
					} else {
						// Disconnected while loading
						this.scene.remove(humanGroup);
						this.scene.remove(carGroup);
						return;
					}
				}

				if (!rp.loaded) return;

				// Apply State Target
				rp.targetPosition.set(state.position.x, state.position.y, state.position.z);
				rp.targetQuaternion.set(state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w);
				
				if (state.activeEntity === "human") {
					rp.humanGroup.visible = true;
					rp.carGroup.visible = false;
					
					// Handle Animation
					if (state.animation && rp.animations.has(state.animation)) {
						if (rp.currentAction !== rp.animations.get(state.animation)) {
							if (rp.currentAction) rp.currentAction.fadeOut(0.2);
							rp.currentAction = rp.animations.get(state.animation);
							rp.currentAction!.reset().fadeIn(0.2).play();
						}
					}
				} else if (state.activeEntity === "car") {
					rp.humanGroup.visible = false;
					rp.carGroup.visible = true;
				}
			});
			
			this.socket.on("user-disconnected", (socketId: string) => {
				const rp = this.remotePlayers.get(socketId);
				if (rp && rp.loaded) {
					this.scene.remove(rp.humanGroup);
					this.scene.remove(rp.carGroup);
				}
				this.remotePlayers.delete(socketId);
			});
		}
	}

	private connectSocket(action: "host" | "join", roomCodeToJoin?: string) {
		this.ensureSocket();

		const loadingScreen = document.getElementById("loading-screen");
		const lobbyPanel = document.getElementById("lobby-panel");
		const startBtn = document.getElementById("start-game-btn");
		const joinPanel = document.getElementById("join-panel");
		const settingsToggle = document.getElementById("settings-toggle");

		if (action === "host") {
			this.socket.emit("create-room", this.userData, (res: any) => {
				if (res.success) {
					this.roomCode = res.roomCode;
					this.isGameActive = false;
					if (lobbyPanel) lobbyPanel.style.display = "flex";
					if (startBtn) startBtn.style.display = "block";
					if (loadingScreen) loadingScreen.style.display = "none";
					if (settingsToggle) settingsToggle.style.display = "none";
					const gameTopNav = document.getElementById("game-top-nav");
					if (gameTopNav) gameTopNav.style.display = "none";
					this.gui.hide();
					this.sceneGUI.hide();
				}
			});
		} else if (action === "join" && roomCodeToJoin) {
			this.socket.emit("join-room", { roomCode: roomCodeToJoin, userData: this.userData }, (res: any) => {
				if (res.success) {
					this.roomCode = res.roomCode;
					this.isGameActive = false;
					if (lobbyPanel) lobbyPanel.style.display = "flex";
					if (startBtn) startBtn.style.display = "none";
					if (loadingScreen) loadingScreen.style.display = "none";
					if (joinPanel) joinPanel.parentElement!.classList.remove("show-join");
					if (settingsToggle) settingsToggle.style.display = "none";
					const gameTopNav = document.getElementById("game-top-nav");
					if (gameTopNav) gameTopNav.style.display = "none";
					const joinConfirmModal = document.getElementById("join-confirm-modal");
					if (joinConfirmModal) joinConfirmModal.style.display = "none";
					this.gui.hide();
					this.sceneGUI.hide();
				} else {
					const errorMsg = document.getElementById("join-error-msg");
					if (errorMsg && errorMsg.offsetParent !== null) {
						errorMsg.textContent = res.error || "Failed to join room";
						errorMsg.style.display = "block";
					}
					const inGameErrorMsg = document.getElementById("in-game-join-error");
					if (inGameErrorMsg) {
						inGameErrorMsg.textContent = res.error || "Failed to join room";
						inGameErrorMsg.style.display = "block";
					}
				}
			});
		}
	}

	private fetchRooms() {
		// Ensure socket is connected and listeners are attached
		this.ensureSocket();
		
		const roomListPanel = document.getElementById("room-list-panel");
		const roomListContainer = document.getElementById("room-list-container");
		const gameTopNav = document.getElementById("game-top-nav");
		const loadingScreen = document.getElementById("loading-screen");
		const joinConfirmModal = document.getElementById("join-confirm-modal");
		
		if (roomListPanel) roomListPanel.style.display = "flex";
		if (gameTopNav) gameTopNav.style.display = "none";
		if (joinConfirmModal) joinConfirmModal.style.display = "none";
		if (loadingScreen && loadingScreen.classList.contains("show-join")) {
			loadingScreen.classList.remove("show-join");
		}

		if (roomListContainer) {
			roomListContainer.innerHTML = `<div style="color: white; text-align: center; padding: 20px;">Fetching rooms...</div>`;
		}

		this.socket.emit("get-rooms", (res: any) => {
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
			this.scene.add(clone);
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

	private loadGltfFull(url: string): Promise<any> {
		return new Promise((resolve, reject) => {
			this.gltfLoader.load(url, resolve, undefined, reject);
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
				if (bomb.mesh.parent !== this.scene) holdingBomb = true;
			}
			if (holdingBomb) return null;

			let nearestBomb: THREE.Group | null = null;
			let minDst = Infinity;
			for (const bomb of this.bombs) {
				if (bomb.mesh.parent === this.scene) {
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
				if (bomb.mesh.parent !== this.scene) return bomb.mesh;
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

			this.scene.add(obj); // Parent is now scene again
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
			if (obj.parent !== this.scene) return; // already picked up

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

		this.Uniforms.uTime.value += this.clock.getDelta();
		this.grassMaterial.update(this.Uniforms.uTime.value);
		updateFoliageWind(dt);

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

		if (this.isGameActive && this.car && this.carInput && this.chaseCameraInput && this.human && this.humanInput) {
			const playAllowed = this.orientationGate?.isPlayAllowed() ?? true;
			const world = getWorld();
			world.timestep = dt;
			
			if (playAllowed) {
				if (this.activePlayer === "car") {
					this.carInput.applyInput(dt);
				} else {
					this.humanInput.update(dt, this.camera);
				}
			}
			
			world.step();
			
			if (playAllowed) {
				if (this.activePlayer === "car") {
					this.carInput.afterPhysics(dt);
				}
				this.human.update(dt);
			}
			syncCar(this.car);
			
			// Sync bomb physics
			for (const bomb of this.bombs) {
				if (bomb.body) {
					const t = bomb.body.translation();
					const r = bomb.body.rotation();
					bomb.mesh.position.set(t.x, t.y, t.z);
					bomb.mesh.quaternion.set(r.x, r.y, r.z, r.w);
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
						if (bomb.mesh.parent === this.scene) { // Still on ground
							const d = this.human.mesh.position.distanceTo(bomb.mesh.position);
							if (d < nearestBombDist) nearestBombDist = d;
						} else {
							holdingBomb = true;
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
					} else {
						this.interactionPrompt.style.display = "none";
					}
				}
			}

			// Leave the map → wait 2s → respawn at start
			let isOutside = false;
			if (this.activePlayer === "car" && this.car) {
				isOutside = isCarOutsideWorld(this.car);
			} else if (this.activePlayer === "human" && this.human) {
				const ht = this.human.body.translation();
				const half = TERRAIN_CONFIG.size * 0.5;
				isOutside = Math.abs(ht.x) > half || Math.abs(ht.z) > half || ht.y < -15 || ht.y > 90;
			}

			if (playAllowed && isOutside) {
				this.outOfWorldTimer += dt;
				if (this.outOfWorldTimer >= 2) {
					if (this.activePlayer === "car" && this.car && this.carController) {
						respawnCarAtStart(this.car, this.carController);
					} else if (this.activePlayer === "human" && this.human && this.car) {
						// Respawn human safely next to the car
						const spawnPos = this.car.mesh.position.clone();
						spawnPos.y += 3.0; // Drop from slightly above to avoid clipping
						this.human.body.setTranslation(spawnPos, true);
						this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
					}
					this.outOfWorldTimer = 0;
				}
			} else if (playAllowed) {
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
		
		// Multiplayer Synchronization Loop
		if (this.socket && this.socket.connected && this.roomCode && this.isGameActive) {
			const anyThis = this as any;
			if (!anyThis._lastNetTick || now - anyThis._lastNetTick > 50) { // ~20Hz
				anyThis._lastNetTick = now;
				const state: any = { activeEntity: this.activePlayer };
				
				if (this.activePlayer === "human" && this.human) {
					const p = this.human.mesh.position;
					const q = this.human.mesh.quaternion;
					state.position = { x: p.x, y: p.y, z: p.z };
					state.quaternion = { x: q.x, y: q.y, z: q.z, w: q.w };
					state.animation = this.human.activeAnimationName;
				} else if (this.activePlayer === "car" && this.car) {
					const p = this.car.mesh.position;
					const q = this.car.mesh.quaternion;
					state.position = { x: p.x, y: p.y, z: p.z };
					state.quaternion = { x: q.x, y: q.y, z: q.z, w: q.w };
				}
				
				this.socket.emit("player-state", { roomCode: this.roomCode, state });
			}
		}

		// Update remote player animations and interpolation
		for (const rp of this.remotePlayers.values()) {
			if (rp.loaded) {
				const lerpFactor = 10 * dt; // Smoothness factor
				
				if (rp.humanGroup.visible) {
					rp.humanGroup.position.lerp(rp.targetPosition, lerpFactor);
					rp.humanGroup.quaternion.slerp(rp.targetQuaternion, lerpFactor);
					if (rp.mixer) rp.mixer.update(dt);
				} else if (rp.carGroup.visible) {
					rp.carGroup.position.lerp(rp.targetPosition, lerpFactor);
					rp.carGroup.quaternion.slerp(rp.targetQuaternion, lerpFactor);
				}
			}
		}

		this.renderer.render(this.scene, this.camera);
		this.stats.update();
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
		this.gui.domElement.classList.add("fg-settings");
		const guiContainer = this.gui.domElement.parentElement as HTMLDivElement;
		guiContainer.style.zIndex = "9999";
		guiContainer.style.position = "fixed";
		guiContainer.style.top = "0";
		guiContainer.style.left = "0";
		guiContainer.style.right = "auto";
		guiContainer.style.display = "block";

		const toggle = document.getElementById("settings-toggle");
		const syncToggle = () => {
			const open = !this.gui.closed;
			this.gui.domElement.classList.toggle("fg-hidden", !open);
			toggle?.classList.toggle("is-open", open);
			toggle?.setAttribute(
				"aria-label",
				open ? "Close settings" : "Open settings"
			);
		};
		syncToggle();
		toggle?.addEventListener("click", () => {
			if (this.gui.closed) this.gui.open();
			else this.gui.close();
			syncToggle();
		});

		this.sceneGUI = this.gui.addFolder("Scene");
		this.sceneGUI
			.add(this.sceneProps, "fogDensity", 0, 0.05, 0.001)
			.name("Fog Density")
			.onChange((value) => {
				if (this.scene.fog instanceof THREE.FogExp2) {
					this.scene.fog.density = value;
				}
			});

		const humanFolder = this.gui.addFolder("Human");
		humanFolder
			.add(this.sceneProps, "humanScale", 0.001, 2.0, 0.001)
			.name("Model Scale")
			.onChange((value) => {
				if (this.human) {
					this.human.mesh.scale.setScalar(value);
				}
			});
		humanFolder.open();
		this.sceneGUI
			.addColor(this.sceneProps, "fogColor")
			.name("Fog color")
			.onChange((value) => {
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
			.name("Cycle speed")
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
