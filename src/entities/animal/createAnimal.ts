import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { getPropSeatY } from "../../terrain/islandHeight";

/**
 * Animated wildlife: ground walkers and sky flyers.
 *
 * These are *not* placeScenicProp with a clip bolted on. A prop is placed once
 * and never moves; these steer themselves every frame, leave the map, die when
 * shot and come back somewhere else, so they own a small amount of state each and
 * are driven from the render loop.
 *
 * Movement is deliberately kinematic — no rigid bodies. A chicken pushed around
 * by Rapier would need a character controller to stay on a sculpted hill, and
 * bullets already hit them through the sphere target below, so physics would buy
 * nothing but a way to fall through the terrain.
 */

export type AnimalKind = "ground" | "air";

export type AnimalHandle = {
	group: THREE.Group;
	kind: AnimalKind;
	/** Advance animation + steering. */
	update: (dt: number) => void;
	/** Sphere the bullet system tests against. */
	targetPosition: THREE.Vector3;
	targetRadius: number;
	/** True while the death puff plays and the model is hidden. */
	isDead: boolean;
	/** Shot: hide, report the death point, respawn shortly after. */
	kill: () => void;
	dispose: () => void;
};

export type AnimalOptions = {
	assetUrl: string;
	kind: AnimalKind;
	position: THREE.Vector3;
	/** Multiplier on `targetHeight`, for per-instance size jitter. */
	scale?: number;
	/**
	 * Real-world height in metres.
	 *
	 * These GLBs arrive at wildly different native scales — the chicken is ~1570
	 * units tall, the soldier close to 1 — so a raw scale factor produces either a
	 * speck or a creature the size of the map. Normalising to metres also makes the
	 * bullet radius meaningful.
	 */
	targetHeight?: number;
	rotationY?: number;
	/** Extent of the world on X/Z; leaving it triggers a respawn. */
	worldSize: number;
	/** Metres per second. */
	speed?: number;
	manager?: THREE.LoadingManager;
	/** Called with the death position so the caller can puff smoke there. */
	onDeath?: (position: THREE.Vector3) => void;
};

/** Seconds a corpse stays hidden before it reappears elsewhere. */
const RESPAWN_DELAY = 1.1;

/**
 * Flight band for air animals, metres above the ground.
 *
 * Was 18–42 m. At that altitude a bird is a speck you cannot find from the ground
 * — placing one looked like nothing had happened. Low enough to read against the
 * sky, high enough to still be clearly flying rather than hovering.
 */
const AIR_MIN_HEIGHT = 9;
const AIR_MAX_HEIGHT = 20;

type Template = { root: THREE.Group; clips: THREE.AnimationClip[]; height: number };

/**
 * Bounds of the *drawn* geometry only.
 *
 * `Box3.setFromObject` also folds in bones and empty nodes, and these rigs park
 * their armature root far from the body: the flamingo's box came out ~4.7× its
 * actual mesh, so scaling to it produced a 0.5 m bird where 2.5 m was asked for,
 * and offset the feet enough that a chicken hovered 24 cm off the ground.
 *
 * Skinning happens on the GPU, so this is the bind pose — the only measurable
 * silhouette. Good enough: what matters is a stable reference, not the exact pose.
 */
function measureMeshBounds(root: THREE.Object3D): THREE.Box3 {
	const box = new THREE.Box3();
	const vertex = new THREE.Vector3();
	root.updateMatrixWorld(true);
	root.traverse((child) => {
		const mesh = child as THREE.Mesh;
		if (!mesh.isMesh || !mesh.geometry) return;
		const attr = mesh.geometry.attributes.position;
		if (!attr) return;
		// Vertices, not `geometry.boundingBox`. On these rigs the cached box disagrees
		// with the actual positions by nearly 5×, which is what kept the flamingo at a
		// fifth of its requested size. A few thousand vertices once per template load
		// costs nothing.
		for (let i = 0; i < attr.count; i++) {
			vertex.fromBufferAttribute(attr, i).applyMatrix4(mesh.matrixWorld);
			box.expandByPoint(vertex);
		}
	});
	return box;
}

/**
 * Wrap a GLB so its feet sit at y=0 and it is centred on XZ.
 *
 * Same reason `placeScenicProp` does it: exported models bake arbitrary offsets
 * into their node matrices, so without this an animal floats or sinks by whatever
 * its author happened to leave in the file.
 */
function normalizeRoot(source: THREE.Object3D): {
	root: THREE.Group;
	nativeSize: THREE.Vector3;
} {
	const box = measureMeshBounds(source);
	const root = new THREE.Group();
	const size = new THREE.Vector3(1, 1, 1);
	if (box.isEmpty()) {
		root.add(source);
		return { root, nativeSize: size };
	}
	const center = new THREE.Vector3();
	box.getSize(size);
	box.getCenter(center);
	source.position.x -= center.x;
	source.position.y -= box.min.y;
	source.position.z -= center.z;
	root.add(source);
	root.updateMatrixWorld(true);
	return { root, nativeSize: size };
}

const templateCache = new Map<string, Promise<Template>>();

function loadTemplate(url: string, manager?: THREE.LoadingManager): Promise<Template> {
	let pending = templateCache.get(url);
	if (!pending) {
		pending = new Promise<Template>((resolve, reject) => {
			new GLTFLoader(manager).load(
				url,
				(gltf) => {
					const root = gltf.scene;
					root.traverse((child) => {
						if (!(child instanceof THREE.Mesh)) return;
						child.castShadow = true;
						child.receiveShadow = true;
						// Skinned meshes animate outside their bind-pose bounds, so three's
						// own culling drops them at the wrong moment.
						child.frustumCulled = false;
					});
					const box = new THREE.Box3().setFromObject(root);
					const size = new THREE.Vector3();
					box.getSize(size);
					resolve({
						root,
						clips: gltf.animations ?? [],
						height: Math.max(0.001, size.y),
					});
				},
				undefined,
				reject
			);
		});
		templateCache.set(url, pending);
	}
	return pending;
}

/**
 * Pick the clip that reads as locomotion.
 *
 * These GLBs ship a single cycle, but they are named inconsistently ("walkcycle",
 * "Flying", "mixamo.com"), so a name match is tried first and the longest clip is
 * the fallback rather than clip 0 — a one-frame T-pose is often first.
 */
function pickLocomotionClip(
	clips: THREE.AnimationClip[],
	kind: AnimalKind
): THREE.AnimationClip | null {
	if (!clips.length) return null;
	const wanted = kind === "air" ? /fly|flap|glide|wing/i : /walk|run|step|idle/i;
	const named = clips.find((c) => wanted.test(c.name));
	if (named) return named;
	return clips.reduce((longest, c) => (c.duration > longest.duration ? c : longest));
}

export async function createAnimal(options: AnimalOptions): Promise<AnimalHandle> {
	const template = await loadTemplate(options.assetUrl, options.manager);
	// SkeletonUtils, not Object3D.clone: a plain clone shares the skeleton, so every
	// chicken in the world would animate as one.
	const model = cloneSkinned(template.root) as THREE.Object3D;
	const { root, nativeSize } = normalizeRoot(model);
	const group = new THREE.Group();
	group.add(root);
	group.name = options.kind === "air" ? "AnimalAir" : "AnimalGround";

	// Metres, then jitter — see `targetHeight`.
	const worldHeight = (options.targetHeight ?? 1) * (options.scale ?? 1);
	// Flyers are matched on their largest dimension, because a bird's silhouette is
	// its wingspan and these rigs bind them wings-out. Walkers on height, which is
	// what "tall as a chicken" means.
	const reference =
		options.kind === "air"
			? Math.max(nativeSize.x, nativeSize.y, nativeSize.z)
			: nativeSize.y;
	group.scale.setScalar(worldHeight / Math.max(0.001, reference));

	const half = options.worldSize * 0.5;
	const speed = options.speed ?? (options.kind === "air" ? 9 : 1.5);
	// Bullet sphere from the *final* size, so a flamingo is not as easy to hit as a
	// chicken and neither is a barn door.
	const targetRadius = Math.max(0.45, worldHeight * 0.55);

	const mixer = new THREE.AnimationMixer(root);
	const clip = pickLocomotionClip(template.clips, options.kind);
	if (clip) {
		const action = mixer.clipAction(clip);
		action.setLoop(THREE.LoopRepeat, Infinity);
		action.play();
	}

	let heading = options.rotationY ?? Math.random() * Math.PI * 2;
	/** Seconds until the next course change; keeps them from marching in a line. */
	let turnIn = 1 + Math.random() * 3;
	let flightHeight =
		AIR_MIN_HEIGHT + Math.random() * (AIR_MAX_HEIGHT - AIR_MIN_HEIGHT);
	let bobPhase = Math.random() * Math.PI * 2;
	/**
	 * Wall-clock timestamp the respawn is due, or -1 when alive.
	 *
	 * Not accumulated `dt`: the render loop clamps dt to 33 ms a frame, so on a slow
	 * machine an accumulated timer stretches — at 5 fps a 1.1 s delay became nearly
	 * 7 s of real time. A deadline is the same length of time for everyone.
	 */
	let respawnAt = -1;

	const targetPosition = new THREE.Vector3();

	const placeAt = (x: number, z: number) => {
		if (options.kind === "air") {
			flightHeight =
				AIR_MIN_HEIGHT + Math.random() * (AIR_MAX_HEIGHT - AIR_MIN_HEIGHT);
			group.position.set(x, getPropSeatY(x, z) + flightHeight, z);
		} else {
			group.position.set(x, getPropSeatY(x, z), z);
		}
		heading = Math.random() * Math.PI * 2;
		group.rotation.y = heading;
	};

	/** Somewhere else on the map — the "random place" a kill or an escape sends it. */
	const respawn = () => {
		const margin = Math.min(20, half * 0.1);
		placeAt(
			(Math.random() * 2 - 1) * (half - margin),
			(Math.random() * 2 - 1) * (half - margin)
		);
	};

	placeAt(options.position.x, options.position.z);
	if (options.kind === "ground") group.rotation.y = heading;

	const update = (dt: number) => {
		if (respawnAt >= 0) {
			if (performance.now() >= respawnAt) {
				respawnAt = -1;
				group.visible = true;
				respawn();
			}
			// A hidden corpse still needs its target parked away from the crosshair.
			targetPosition.set(0, -1000, 0);
			return;
		}

		mixer.update(dt);

		turnIn -= dt;
		if (turnIn <= 0) {
			// Air animals bank in wide arcs; ground ones can turn sharply.
			const swing = options.kind === "air" ? 0.9 : 1.8;
			heading += (Math.random() * 2 - 1) * swing;
			turnIn = options.kind === "air" ? 2 + Math.random() * 4 : 1 + Math.random() * 3;
		}

		const step = speed * dt;
		group.position.x += Math.sin(heading) * step;
		group.position.z += Math.cos(heading) * step;

		if (options.kind === "air") {
			bobPhase += dt * 1.4;
			const groundY = getPropSeatY(group.position.x, group.position.z);
			// Ease toward the band rather than snapping, so crossing a hill reads as a
			// climb instead of a teleport.
			const wanted = groundY + flightHeight + Math.sin(bobPhase) * 1.2;
			group.position.y += (wanted - group.position.y) * Math.min(1, dt * 1.5);
		} else {
			group.position.y = getPropSeatY(group.position.x, group.position.z);
		}

		// Model faces +Z; heading is measured the same way so this stays a straight
		// assignment rather than an offset nobody can explain later.
		group.rotation.y = heading;

		// Left the map: respawn instead of wandering off into nothing.
		if (
			Math.abs(group.position.x) > half ||
			Math.abs(group.position.z) > half
		) {
			respawn();
		}

		targetPosition.copy(group.position);
		// Aim at the middle of the body, not its feet.
		targetPosition.y += targetRadius * 0.8;
	};

	return {
		group,
		kind: options.kind,
		update,
		targetPosition,
		targetRadius,
		get isDead() {
			return respawnAt >= 0;
		},
		kill: () => {
			if (respawnAt >= 0) return;
			options.onDeath?.(targetPosition.clone());
			group.visible = false;
			respawnAt = performance.now() + RESPAWN_DELAY * 1000;
		},
		dispose: () => {
			mixer.stopAllAction();
			group.removeFromParent();
			group.traverse((obj) => {
				if (!(obj instanceof THREE.Mesh)) return;
				obj.geometry?.dispose();
				const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
				for (const mat of mats) mat?.dispose();
			});
		},
	};
}
