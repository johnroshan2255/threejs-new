import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import RAPIER from "@dimforge/rapier3d-compat";
import { getWorld } from "../../physics/world";
import { findSafeTerrainSpawn, getWorldTerrainY } from "../../terrain/islandHeight";
import { setCharacterAlbedo } from "../human/toonCharacter";

/**
 * What a bot needs from the game to act. Kept as a narrow interface so the
 * manager does not reach into FluffyGrass.
 */
export type BotWorldHooks = {
	scene: THREE.Scene;
	/** Positions a bot may target — the local player plus any remote players. */
	getTargets: () => THREE.Vector3[];
	/** Fire a tracer. Bots deal no damage until the host says otherwise. */
	fire: (origin: THREE.Vector3, direction: THREE.Vector3, ownerId: string) => void;
	/** Character scale, matched to the player so bots are not giants. */
	characterScale: number;
};

type BotState = "wander" | "engage";

type Bot = {
	id: string;
	mesh: THREE.Group;
	body: RAPIER.RigidBody;
	mixer: THREE.AnimationMixer;
	actions: Map<string, THREE.AnimationAction>;
	/** Current intent ('idle' | 'walk' | 'run' | 'shoot'). */
	current: string | null;
	/** Resolved clip actually playing, so it can be faded out. */
	currentAction: THREE.AnimationAction | null;
	state: BotState;
	/** Where the bot is walking to while wandering. */
	goal: THREE.Vector3;
	/** Seconds until the next re-think, so 100 bots do not all decide at once. */
	thinkIn: number;
	fireCooldown: number;
	/** Seconds the firing clip is protected from being overridden. */
	shootHold: number;
	/** Staggered animation budget: index into the round-robin update group. */
	slot: number;
};

const WANDER_SPEED = 2.2;
const ENGAGE_SPEED = 3.6;
const ENGAGE_RANGE = 55;
const FIRE_RANGE = 42;
const FIRE_INTERVAL = 1.4;
const GOAL_RADIUS = 2.5;
const WANDER_RADIUS = 70;
/** Spawn ring: wide enough that not every bot starts already in contact. */
const SPAWN_MIN = 25;
const SPAWN_SPREAD = 120;

/**
 * Spawns and drives AI characters.
 *
 * Each bot is a full skinned character: `SkeletonUtils.clone` so every one has an
 * independent skeleton (a plain `clone()` shares it, which makes the whole crowd
 * animate in lockstep), its own `AnimationMixer`, and a kinematic Rapier body.
 *
 * The per-frame cost that scales worst is skeleton evaluation, so mixers are
 * updated round-robin in `MIXER_GROUPS` groups rather than all every frame — at
 * 100 bots that is the difference between one animation bill and a hundred. The
 * AI think step is staggered the same way.
 */
export class BotManager {
	private bots: Bot[] = [];
	private template: { scene: THREE.Group; animations: THREE.AnimationClip[] } | null = null;
	private frame = 0;
	/** Total shots fired by all bots. Read by tests to confirm they engage. */
	public shotsFired = 0;
	/** Bots whose mixer updates on a given frame. Higher = cheaper, choppier. */
	private static readonly MIXER_GROUPS = 3;

	private readonly _dir = new THREE.Vector3();
	private readonly _flat = new THREE.Vector3();
	private readonly _muzzle = new THREE.Vector3();
	private readonly _targetQuat = new THREE.Quaternion();
	private readonly _up = new THREE.Vector3(0, 1, 0);

	constructor(private readonly hooks: BotWorldHooks) {}

	get count(): number {
		return this.bots.length;
	}

	/** Hand in the character GLTF once; every bot is cloned from it. */
	setTemplate(scene: THREE.Group, animations: THREE.AnimationClip[]): void {
		this.template = { scene, animations };
	}

	get hasTemplate(): boolean {
		return this.template !== null;
	}

	/**
	 * Bring the population to `target`, spawning around `center`.
	 *
	 * Additive and idempotent, so the settings slider can be dragged without
	 * rebuilding the crowd: it only ever adds or removes the difference.
	 */
	setCount(target: number, center: THREE.Vector3): void {
		const want = Math.max(0, Math.floor(target));
		while (this.bots.length > want) this.despawnOne();
		if (!this.template) return;
		while (this.bots.length < want) this.spawnOne(center);
	}

	private spawnOne(center: THREE.Vector3): void {
		const template = this.template;
		if (!template) return;

		const angle = Math.random() * Math.PI * 2;
		const radius = SPAWN_MIN + Math.random() * SPAWN_SPREAD;
		const spawn = findSafeTerrainSpawn(
			center.x + Math.cos(angle) * radius,
			center.z + Math.sin(angle) * radius,
			1.2
		);

		const mesh = cloneSkinned(template.scene) as THREE.Group;
		mesh.scale.setScalar(this.hooks.characterScale);
		setCharacterAlbedo(mesh, 0xffffff);
		mesh.traverse((child) => {
			if ((child as THREE.Mesh).isMesh) {
				child.castShadow = true;
				child.receiveShadow = true;
			}
		});
		mesh.position.copy(spawn);
		this.hooks.scene.add(mesh);

		const mixer = new THREE.AnimationMixer(mesh);
		const actions = new Map<string, THREE.AnimationAction>();
		for (const clip of template.animations) {
			// The sheet ships each clip twice, once prefixed "armature|". Strip it so
			// "rifle idle" and "armature|rifle idle" collapse to one key and an exact
			// lookup is possible — substring matching picked whichever came first,
			// which is how asking for "idle" silently landed on "rifle idle".
			const key = clip.name.toLowerCase().replace(/^armature\|/, "");
			if (actions.has(key)) continue;
			const action = mixer.clipAction(clip);
			action.setLoop(THREE.LoopRepeat, Infinity);
			actions.set(key, action);
		}

		// Kinematic, not dynamic: bots are driven by the AI, and a hundred dynamic
		// capsules solving against each other is both expensive and twitchy.
		const world = getWorld();
		const body = world.createRigidBody(
			RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
				spawn.x,
				spawn.y,
				spawn.z
			)
		);
		world.createCollider(RAPIER.ColliderDesc.capsule(0.9, 0.4), body);

		const bot: Bot = {
			id: `bot-${this.bots.length}-${Math.floor(Math.random() * 1e6).toString(36)}`,
			mesh,
			body,
			mixer,
			actions,
			current: null,
			currentAction: null,
			state: "wander",
			goal: spawn.clone(),
			thinkIn: Math.random() * 1.5,
			fireCooldown: Math.random() * FIRE_INTERVAL,
			shootHold: 0,
			slot: this.bots.length % BotManager.MIXER_GROUPS,
		};
		this.play(bot, "idle");
		this.bots.push(bot);
	}

	private despawnOne(): void {
		const bot = this.bots.pop();
		if (!bot) return;
		bot.mixer.stopAllAction();
		this.hooks.scene.remove(bot.mesh);
		try {
			getWorld().removeRigidBody(bot.body);
		} catch {
			/* world already torn down */
		}
	}

	/** Remove every bot and release its physics body. */
	clear(): void {
		while (this.bots.length) this.despawnOne();
	}

	/**
	 * Clips to try per intent, best first.
	 *
	 * Bots are armed, so the rifle variants are preferred and the unarmed ones are
	 * the fallback. `gunplay` is this sheet's firing clip — there is no "shoot".
	 */
	private static readonly CLIPS: Record<string, string[]> = {
		idle: ["rifle idle", "idle"],
		walk: ["rifle walk", "walk"],
		run: ["run", "rifle walk", "walk"],
		shoot: ["gunplay", "rifle idle", "idle"],
	};

	private play(bot: Bot, wanted: string): void {
		// The firing clip owns the body for its hold window; otherwise the very next
		// frame's idle/walk decision overwrote it and `gunplay` never showed.
		if (bot.shootHold > 0 && wanted !== "shoot") return;
		if (bot.current === wanted) return;
		let action: THREE.AnimationAction | undefined;
		for (const name of BotManager.CLIPS[wanted] ?? [wanted]) {
			action = bot.actions.get(name);
			if (action) break;
		}
		if (!action) return;
		// Fade the clip that is actually playing. Looking it up from `bot.current`
		// failed because that holds the intent name, not a clip key, so the old
		// action was left running and the two blended forever.
		const previous = bot.currentAction;
		if (previous !== action) {
			action.reset().fadeIn(0.2).play();
			if (previous) previous.fadeOut(0.2);
		}
		bot.current = wanted;
		bot.currentAction = action;
	}

	private pickGoal(bot: Bot, center: THREE.Vector3): void {
		const angle = Math.random() * Math.PI * 2;
		const radius = 8 + Math.random() * WANDER_RADIUS;
		const x = center.x + Math.cos(angle) * radius;
		const z = center.z + Math.sin(angle) * radius;
		bot.goal.set(x, getWorldTerrainY(x, z), z);
	}

	/** Nearest target within `range`, or null. */
	private nearestTarget(from: THREE.Vector3, range: number): THREE.Vector3 | null {
		let best: THREE.Vector3 | null = null;
		let bestSq = range * range;
		for (const t of this.hooks.getTargets()) {
			const dSq = from.distanceToSquared(t);
			if (dSq < bestSq) {
				bestSq = dSq;
				best = t;
			}
		}
		return best;
	}

	update(dt: number, center: THREE.Vector3): void {
		if (this.bots.length === 0) return;
		this.frame++;
		const group = this.frame % BotManager.MIXER_GROUPS;
		// A mixer stepped every Nth frame must advance by N frames' worth of time.
		const mixerDt = dt * BotManager.MIXER_GROUPS;

		for (const bot of this.bots) {
			const pos = bot.mesh.position;

			bot.thinkIn -= dt;
			if (bot.thinkIn <= 0) {
				bot.thinkIn = 0.4 + Math.random() * 0.6;
				const target = this.nearestTarget(pos, ENGAGE_RANGE);
				bot.state = target ? "engage" : "wander";
				if (target) bot.goal.copy(target);
				else if (pos.distanceTo(bot.goal) < GOAL_RADIUS) this.pickGoal(bot, center);
			}

			// Steer flat along the ground; height comes from the terrain.
			this._flat.set(bot.goal.x - pos.x, 0, bot.goal.z - pos.z);
			const planarDist = this._flat.length();
			const engaging = bot.state === "engage";
			const speed = engaging ? ENGAGE_SPEED : WANDER_SPEED;

			// Engaging bots hold at firing distance instead of walking into the player.
			const wantsToClose = !engaging || planarDist > FIRE_RANGE * 0.6;
			if (planarDist > 0.35 && wantsToClose) {
				this._flat.multiplyScalar(1 / planarDist);
				pos.x += this._flat.x * speed * dt;
				pos.z += this._flat.z * speed * dt;
				this.play(bot, speed > WANDER_SPEED ? "run" : "walk");
			} else if (engaging) {
				// Holding at firing distance: keep the rifle up rather than dropping to
				// a neutral idle, and drift sideways so the crowd is not a statue line.
				this.play(bot, "idle");
				const strafe = Math.sin((this.frame + bot.slot * 37) * 0.02) * 0.6;
				pos.x += -this._flat.z * strafe * dt;
				pos.z += this._flat.x * strafe * dt;
			} else {
				this.play(bot, "idle");
			}

			// Sit on the surface. Cheap probe, and the only ground truth a kinematic
			// body gets since it is not solving against the terrain collider.
			pos.y = getWorldTerrainY(pos.x, pos.z) + 1.0;

			// Face the goal (target while engaging, walk direction otherwise).
			if (planarDist > 0.2) {
				const yaw = Math.atan2(bot.goal.x - pos.x, bot.goal.z - pos.z);
				this._targetQuat.setFromAxisAngle(this._up, yaw);
				bot.mesh.quaternion.slerp(this._targetQuat, Math.min(1, dt * 6));
			}

			bot.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });

			// Shoot when engaged and in range.
			bot.shootHold -= dt;
			bot.fireCooldown -= dt;
			if (engaging && bot.fireCooldown <= 0 && planarDist <= FIRE_RANGE) {
				bot.fireCooldown = FIRE_INTERVAL * (0.7 + Math.random() * 0.6);
				this._muzzle.set(pos.x, pos.y + 1.35, pos.z);
				this._dir.set(bot.goal.x - pos.x, bot.goal.y + 1.1 - this._muzzle.y, bot.goal.z - pos.z);
				if (this._dir.lengthSq() > 1e-6) {
					// Deliberate inaccuracy, or a hundred bots are a firing squad.
					this._dir.normalize();
					this._dir.x += (Math.random() - 0.5) * 0.08;
					this._dir.y += (Math.random() - 0.5) * 0.05;
					this._dir.z += (Math.random() - 0.5) * 0.08;
					this.hooks.fire(this._muzzle, this._dir, bot.id);
					this.shotsFired++;
					bot.shootHold = 0.45;
					this.play(bot, "shoot");
				}
			}

			if (bot.slot === group) bot.mixer.update(mixerDt);
		}
	}
}
