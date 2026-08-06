import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

export type CombatBones = {
	head?: THREE.Object3D;
	spine?: THREE.Object3D;
	hips?: THREE.Object3D;
	rightHand?: THREE.Object3D;
};

/** Resolve Mixamo-style combat bones from a skinned character root. */
export function findCombatBones(root: THREE.Object3D): CombatBones {
	const result: CombatBones = {};
	let headScore = -1;
	let spineScore = -1;
	let hipsScore = -1;
	let handScore = -1;

	root.traverse((child) => {
		const n = child.name.toLowerCase().replace(/[^a-z0-9]/g, "");

		if (n.includes("righthand") && !n.includes("thumb") && !n.includes("index") && !n.includes("middle") && !n.includes("ring") && !n.includes("pinky")) {
			const score = n.endsWith("righthand") ? 2 : 1;
			if (score > handScore) {
				handScore = score;
				result.rightHand = child;
			}
		}

		if (n.includes("head") && !n.includes("headtop")) {
			const score = n.endsWith("head") ? 2 : 1;
			if (score > headScore) {
				headScore = score;
				result.head = child;
			}
		}

		if (n.includes("spine")) {
			const score = n.includes("spine2") ? 3 : n.includes("spine1") ? 2 : 1;
			if (score > spineScore) {
				spineScore = score;
				result.spine = child;
			}
		}

		if (n.includes("hips") || n === "hip") {
			const score = n.endsWith("hips") || n === "hips" ? 2 : 1;
			if (score > hipsScore) {
				hipsScore = score;
				result.hips = child;
			}
		}
	});

	return result;
}

/** Freeze horizontal root translation so loco clips play in-place. */
export function stripRootMotion(clip: THREE.AnimationClip) {
	clip.tracks.forEach((track) => {
		if (!track.name.toLowerCase().includes(".position")) return;
		const values = track.values;
		const startX = values[0];
		const startZ = values[2];
		for (let i = 0; i < values.length; i += 3) {
			values[i] = startX;
			values[i + 2] = startZ;
		}
	});
}

export type HitReaction = "uppercut" | "side" | "sweep";

export function hitReactionAnimName(reaction: HitReaction): string {
	switch (reaction) {
		case "uppercut":
			return "receiving an uppercut";
		case "sweep":
			return "sweep fall";
		default:
			return "hit on side of body";
	}
}

export class HumanEntity {
	public mesh: THREE.Group;
	public body: RAPIER.RigidBody;
	public collider: RAPIER.Collider;
	public mixer: THREE.AnimationMixer;
	public animations: Map<string, THREE.AnimationAction> = new Map();
	private activeAction: THREE.AnimationAction | null = null;
	public activeAnimationName: string | null = null;

	// Procedural Pickup State
	public pickupProgress: number = 0.0; // 0 to 1
	public throwProgress: number = 0.0; // 0 to 1

	public headBone: THREE.Object3D | undefined;
	public spineBone: THREE.Object3D | undefined;
	public hipsBone: THREE.Object3D | undefined;
	public rightHandBone: THREE.Object3D | undefined;

	/** Capsule radius / half-height — mesh feet align to capsule bottom. */
	static readonly CAPSULE_RADIUS = 0.45;
	static readonly CAPSULE_HALF_HEIGHT = 1.5;
	/** Body center → feet (must match capsule bottom). */
	static readonly MESH_Y_OFFSET =
		HumanEntity.CAPSULE_HALF_HEIGHT + HumanEntity.CAPSULE_RADIUS;

	/**
	 * The capsule is ~3.9 m tall (~2x human scale), so world gravity of 9.81
	 * reads as Moon-slow against a body that size. Scale it per-body instead of
	 * touching world gravity, which the car's mass / suspension is tuned to.
	 */
	static readonly GRAVITY_SCALE = 2.0;
	/**
	 * Near-zero, NOT the old 4.0. Damping is isotropic in Rapier, so 4.0 capped
	 * fall speed at g/4 ≈ 2.45 m/s. Horizontal braking is done explicitly in
	 * HumanInput (which overwrites x/z every frame anyway).
	 */
	static readonly LINEAR_DAMPING = 0.05;

	private isBuoyant = false;

	private static readonly ONE_SHOT_ANIMS = [
		"being carried",
		"fall down",
		"sit to stand",
		"sweep fall",
		"stand to sit",
		"jumbing",
		"running jumb",
		"receiving an uppercut",
		"hit on side of body",
		"punch one",
		"drop kick",
		"gunplay",
		"dying",
	];

	constructor(
		gltfScene: THREE.Group,
		gltfAnimations: THREE.AnimationClip[],
		world: RAPIER.World,
		initialPosition: THREE.Vector3
	) {
		this.mesh = gltfScene;

		// Traverse to enable shadows + resolve combat bones
		this.mesh.traverse((child) => {
			if (child instanceof THREE.Mesh) {
				child.castShadow = true;
				child.receiveShadow = true;
			}
		});

		const bones = findCombatBones(this.mesh);
		this.headBone = bones.head;
		this.spineBone = bones.spine;
		this.hipsBone = bones.hips;
		this.rightHandBone = bones.rightHand;
		console.log("[HumanEntity] Combat bones:", {
			head: this.headBone?.name ?? null,
			spine: this.spineBone?.name ?? null,
			hips: this.hipsBone?.name ?? null,
			rightHand: this.rightHandBone?.name ?? null,
		});

		// Animations
		this.mixer = new THREE.AnimationMixer(this.mesh);
		console.log("[HumanEntity] Available animations:");
		gltfAnimations.forEach((clip) => {
			console.log(` - ${clip.name}`);
			const nameLower = clip.name.toLowerCase();

			// Strip horizontal root motion for locomotion only — hit reactions keep theirs
			if (nameLower.includes("walk") || nameLower.includes("run")) {
				stripRootMotion(clip);
			}

			const action = this.mixer.clipAction(clip);
			this.animations.set(nameLower, action);
		});

		// Physics Setup (Capsule)
		const radius = HumanEntity.CAPSULE_RADIUS;
		const halfHeight = HumanEntity.CAPSULE_HALF_HEIGHT;
		const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
			.setTranslation(
				initialPosition.x,
				initialPosition.y + halfHeight + radius + 0.15,
				initialPosition.z
			)
			.setLinearDamping(HumanEntity.LINEAR_DAMPING)
			.setAngularDamping(1.0)
			.setGravityScale(HumanEntity.GRAVITY_SCALE)
			.lockRotations(); // Keep character upright

		this.body = world.createRigidBody(rigidBodyDesc);

		const colliderDesc = RAPIER.ColliderDesc.capsule(halfHeight, radius)
			.setFriction(0) // No friction so we don't stick to walls
			.setMass(70);

		this.collider = world.createCollider(colliderDesc, this.body);

		this.playAnimation("idle");
	}

	/**
	 * Swimming drives Y explicitly, so gravity is switched off while submerged —
	 * otherwise the scripted buoyancy lerp fights it and the body settles low.
	 */
	public setBuoyant(buoyant: boolean) {
		if (this.isBuoyant === buoyant) return;
		this.isBuoyant = buoyant;
		this.body.setGravityScale(buoyant ? 0 : HumanEntity.GRAVITY_SCALE, true);
	}

	public update(dt: number) {
		this.mixer.update(dt);

		// Sync visual mesh to physics body
		const translation = this.body.translation();
		// Feet at capsule bottom (was -2.4 → buried ~0.45 m under terrain).
		this.mesh.position.set(
			translation.x,
			translation.y - HumanEntity.MESH_Y_OFFSET,
			translation.z
		);
	}

	public getRightHandWorldPosition(out: THREE.Vector3): boolean {
		if (!this.rightHandBone) return false;
		this.rightHandBone.getWorldPosition(out);
		return true;
	}

	/** World position of the animated root (hips), after mixer has updated. */
	public getRootWorldPosition(out: THREE.Vector3): boolean {
		const root = this.hipsBone ?? this.spineBone;
		if (!root) return false;
		this.mesh.updateMatrixWorld(true);
		root.getWorldPosition(out);
		return true;
	}

	/**
	 * Apply root-motion delta (startHips → current hips) onto the physics body,
	 * plus an extra buffer along the travel direction so idle lines up better.
	 */
	public applyRootMotionDelta(
		startHipsWorld: THREE.Vector3,
		buffer: number = 1.5
	) {
		const end = new THREE.Vector3();
		if (!this.getRootWorldPosition(end)) return;
		const t = this.body.translation();
		let dx = end.x - startHipsWorld.x;
		let dz = end.z - startHipsWorld.z;
		const len = Math.hypot(dx, dz);
		if (len > 1e-4 && buffer !== 0) {
			dx += (dx / len) * buffer;
			dz += (dz / len) * buffer;
		} else if (len <= 1e-4 && buffer !== 0) {
			// Tiny / zero root motion — nudge along facing
			const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion);
			fwd.y = 0;
			if (fwd.lengthSq() > 1e-6) {
				fwd.normalize();
				dx += fwd.x * buffer;
				dz += fwd.z * buffer;
			}
		}
		this.body.setTranslation({ x: t.x + dx, y: t.y, z: t.z + dz }, true);
		this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
		// Keep mesh in sync immediately so the next network tick sends the new spot
		this.mesh.position.set(
			t.x + dx,
			t.y - HumanEntity.MESH_Y_OFFSET,
			t.z + dz
		);
	}

	public playAnimation(
		name: string,
		fadeDuration: number = 0.2,
		forceRestart: boolean = false,
		loopMode: "auto" | "once" | "repeat" = "auto"
	): number {
		const lowerName = name.toLowerCase();
		let targetAction: THREE.AnimationAction | undefined;

		// Exact match first
		for (const [clipName, action] of this.animations.entries()) {
			if (clipName === lowerName) {
				targetAction = action;
				break;
			}
		}

		// Partial match fallback
		if (!targetAction) {
			for (const [clipName, action] of this.animations.entries()) {
				if (clipName.includes(lowerName)) {
					targetAction = action;
					break;
				}
			}
		}

		if (!targetAction) return 0;

		if (forceRestart || targetAction !== this.activeAction) {
			if (this.activeAction && this.activeAction !== targetAction) {
				this.activeAction.fadeOut(fadeDuration);
			}

			targetAction.reset().fadeIn(fadeDuration);

			const clipLower = targetAction.getClip().name.toLowerCase();
			const isOneShot =
				loopMode === "once" ||
				(loopMode === "auto" &&
					HumanEntity.ONE_SHOT_ANIMS.some(
						(a) =>
							lowerName === a ||
							clipLower === a ||
							clipLower.includes(a)
					));

			if (loopMode === "repeat") {
				targetAction.setLoop(THREE.LoopRepeat, Infinity);
				targetAction.clampWhenFinished = false;
			} else if (isOneShot) {
				targetAction.setLoop(THREE.LoopOnce, 1);
				targetAction.clampWhenFinished = true;
			} else if (
				lowerName === "sitting" ||
				lowerName.includes("sitting") ||
				clipLower.includes("sitting")
			) {
				targetAction.setLoop(THREE.LoopRepeat, Infinity);
				targetAction.clampWhenFinished = false;
			} else {
				targetAction.setLoop(THREE.LoopRepeat, Infinity);
				targetAction.clampWhenFinished = false;
			}

			targetAction.play();
			this.activeAction = targetAction;
			this.activeAnimationName = clipLower;
		}

		return targetAction.getClip().duration;
	}
}
