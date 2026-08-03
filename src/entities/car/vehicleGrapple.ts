import * as THREE from "three";
import type { CarEntity } from "./createCar";
import { CAR_CONFIG } from "./carConfig";
import { getCarForward3D } from "./cameraDrive";
import { raycastTerrainHit } from "../../terrain/islandHeight";

const _mountWorld = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _pull = new THREE.Vector3();
const _lateral = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _invQuat = new THREE.Quaternion();
const _localAnchor = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _bestPoint = new THREE.Vector3();

export type VehicleGrappleState = "idle" | "attached" | "pulling";

/**
 * Front bumper winch that works on any CarEntity.
 * Press T to latch / hold T to reel; press H to detach. Releasing T keeps the hook.
 */
export class VehicleGrapple {
	readonly group: THREE.Group;
	private readonly winch: THREE.Group;
	private readonly hook: THREE.Mesh;
	private readonly rope: THREE.Line;
	private readonly ropePositions: Float32Array;

	private attached = false;
	private reeling = false;
	private ropeLength = 0;
	private readonly anchor = new THREE.Vector3();
	private state: VehicleGrappleState = "idle";
	private savedAngularDamping: number | null = null;

	constructor(private car: CarEntity) {
		const { grapple } = CAR_CONFIG;

		this.group = new THREE.Group();
		this.group.name = "vehicle-grapple";

		this.winch = this.buildWinch();
		this.winch.position.copy(car.grappleMountLocal);
		this.group.add(this.winch);

		const hookGeo = new THREE.ConeGeometry(0.06, 0.2, 6);
		hookGeo.rotateX(Math.PI / 2);
		this.hook = new THREE.Mesh(
			hookGeo,
			new THREE.MeshStandardMaterial({
				color: grapple.hookColor,
				metalness: 0.7,
				roughness: 0.35,
			})
		);
		this.hook.castShadow = true;
		this.hook.visible = false;
		this.group.add(this.hook);

		this.ropePositions = new Float32Array(6);
		const ropeGeo = new THREE.BufferGeometry();
		ropeGeo.setAttribute(
			"position",
			new THREE.BufferAttribute(this.ropePositions, 3)
		);
		this.rope = new THREE.Line(
			ropeGeo,
			new THREE.LineBasicMaterial({
				color: grapple.ropeColor,
			})
		);
		this.rope.frustumCulled = false;
		this.rope.visible = false;
		this.group.add(this.rope);

		car.mesh.add(this.group);
	}

	getState(): VehicleGrappleState {
		return this.state;
	}

	isAttached(): boolean {
		return this.attached;
	}

	/**
	 * Call every frame while driving, before physics step.
	 * @param held true while T is held (reel in)
	 * @param justPressed true on the frame T went down (try latch if free)
	 * @param detachPressed true on the frame H went down (remove hook)
	 */
	update(
		dt: number,
		held: boolean,
		justPressed: boolean,
		detachPressed: boolean
	) {
		if (detachPressed) {
			this.release();
			return;
		}

		if (justPressed && !this.attached) {
			this.tryAttach();
		}

		this.reeling = this.attached && held;

		if (this.attached && this.reeling) {
			this.applyReelVelocity(dt);
			if (this.attached) this.state = "pulling";
		} else if (this.attached) {
			this.applyCableLock(dt);
			this.state = "attached";
		}

		this.updateVisuals();
	}

	/**
	 * Enforce reel or cable lock after physics (gravity can't pull you back).
	 * Call after world.step() whenever the hook is attached.
	 */
	afterPhysics(dt: number) {
		if (!this.attached) return;
		if (this.reeling) this.applyReelVelocity(dt);
		else this.applyCableLock(dt);
		this.updateVisuals();
	}

	release() {
		if (!this.attached && this.state === "idle") return;
		this.attached = false;
		this.reeling = false;
		this.ropeLength = 0;
		this.state = "idle";
		this.hook.visible = false;
		this.rope.visible = false;
		this.restoreAngularDamping();
	}

	dispose() {
		this.release();
		this.car.mesh.remove(this.group);
		this.group.traverse((obj) => {
			if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
				obj.geometry.dispose();
				const mat = obj.material;
				if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
				else mat.dispose();
			}
		});
	}

	private tryAttach() {
		if (this.attached) return;

		const { grapple } = CAR_CONFIG;
		this.getMountWorld(_mountWorld);

		_forward.copy(getCarForward3D(this.car.body));
		_right.crossVectors(_up, _forward);
		if (_right.lengthSq() < 1e-8) {
			_right.set(1, 0, 0);
		} else {
			_right.normalize();
		}

		let bestScore = -Infinity;
		let found = false;

		// Fan of rays: down for flats, hard-up for near-vertical cliffs (~5m latch).
		for (const yaw of grapple.aimYaws) {
			for (const pitch of grapple.aimPitches) {
				_aimDir
					.copy(_forward)
					.addScaledVector(_right, yaw)
					.addScaledVector(_up, pitch);
				if (_aimDir.lengthSq() < 1e-8) continue;
				_aimDir.normalize();

				const hit = raycastTerrainHit(
					_mountWorld,
					_aimDir,
					grapple.maxRange
				);
				if (!hit) continue;
				if (
					hit.distance < grapple.minAttachDist ||
					hit.distance > grapple.maxRange
				) {
					continue;
				}

				const heightGain = hit.point.y - _mountWorld.y;
				// Keep latch within ~5m up the face (steep climb target).
				if (heightGain > grapple.steepAttachHeight + 0.75) continue;

				// Steep face: normal is mostly horizontal.
				const steepness = 1 - Math.abs(hit.normal.y);
				const usefulClimb = THREE.MathUtils.clamp(
					heightGain,
					-1,
					grapple.steepAttachHeight
				);

				// Prefer elevated latch points on steep ground (up to 5m).
				// Still accept flat-ground hits so normal terrain keeps working.
				const score =
					usefulClimb * (1.5 + steepness * 3.0) +
					steepness * 2.0 +
					Math.min(hit.distance, 20) * 0.05;

				if (score > bestScore) {
					bestScore = score;
					_bestPoint.copy(hit.point);
					found = true;
				}
			}
		}

		// Extra probes aimed at ~5m up the face at several forward ranges —
		// catches 90% vertical walls the fan might skim past.
		for (const ahead of [3, 5, 8, 12, 18, 25]) {
			_aimDir
				.copy(_forward)
				.multiplyScalar(ahead)
				.addScaledVector(_up, grapple.steepAttachHeight);
			if (_aimDir.lengthSq() < 1e-8) continue;
			_aimDir.normalize();

			const hit = raycastTerrainHit(
				_mountWorld,
				_aimDir,
				grapple.maxRange
			);
			if (!hit) continue;
			if (
				hit.distance < grapple.minAttachDist ||
				hit.distance > grapple.maxRange
			) {
				continue;
			}

			const heightGain = hit.point.y - _mountWorld.y;
			if (heightGain < 0.4) continue;
			if (heightGain > grapple.steepAttachHeight + 0.75) continue;

			const steepness = 1 - Math.abs(hit.normal.y);
			const usefulClimb = THREE.MathUtils.clamp(
				heightGain,
				0,
				grapple.steepAttachHeight
			);
			const score =
				4 + usefulClimb * 3.0 + steepness * 4.0 + hit.distance * 0.02;

			if (score > bestScore) {
				bestScore = score;
				_bestPoint.copy(hit.point);
				found = true;
			}
		}

		if (!found) return;

		this.anchor.copy(_bestPoint);
		this.ropeLength = _mountWorld.distanceTo(this.anchor);
		if (
			this.ropeLength < grapple.minAttachDist ||
			this.ropeLength > grapple.maxRange
		) {
			return;
		}

		this.attached = true;
		this.reeling = false;
		this.state = "attached";
		this.boostAngularDamping();
	}

	/**
	 * Hard winch lock at ~5 mph along the rope.
	 * Strong enough for any hill: speed is forced, not spring-pulled.
	 */
	private applyReelVelocity(dt: number) {
		const { grapple } = CAR_CONFIG;
		this.getMountWorld(_mountWorld);

		_pull.copy(this.anchor).sub(_mountWorld);
		const dist = _pull.length();
		if (dist < grapple.arriveDistance) {
			this.release();
			return;
		}

		_pull.multiplyScalar(1 / dist);

		const vel = this.car.body.linvel();
		const along =
			vel.x * _pull.x + vel.y * _pull.y + vel.z * _pull.z;

		// Full 5 mph until very close, then ease only to stop cleanly.
		let desiredAlong = grapple.reelSpeed;
		if (dist < grapple.arriveSlowRadius) {
			const t =
				(dist - grapple.arriveDistance) /
				Math.max(1e-3, grapple.arriveSlowRadius - grapple.arriveDistance);
			desiredAlong = grapple.reelSpeed * Math.max(0, Math.min(1, t));
		}

		// Strip rope-axis component, damp the rest (no elastic bounce).
		_lateral.set(
			vel.x - _pull.x * along,
			vel.y - _pull.y * along,
			vel.z - _pull.z * along
		);
		_lateral.multiplyScalar(Math.exp(-grapple.lateralDamp * dt));

		// Force exact reel speed along the cable — hills cannot overcome this.
		this.car.body.setLinvel(
			{
				x: _lateral.x + _pull.x * desiredAlong,
				y: _lateral.y + _pull.y * desiredAlong,
				z: _lateral.z + _pull.z * desiredAlong,
			},
			true
		);
		this.car.body.wakeUp();

		// Shorten locked rope as we reel so releasing T holds the new spot.
		this.ropeLength = Math.max(
			grapple.arriveDistance,
			Math.min(this.ropeLength, dist - desiredAlong * dt)
		);
	}

	/**
	 * Locked winch: rope cannot extend. Holds the car on hills when T is released.
	 */
	private applyCableLock(dt: number) {
		this.getMountWorld(_mountWorld);

		_pull.copy(this.anchor).sub(_mountWorld);
		const dist = _pull.length();
		if (dist < 1e-4) return;

		_pull.multiplyScalar(1 / dist);

		const vel = this.car.body.linvel();
		const along =
			vel.x * _pull.x + vel.y * _pull.y + vel.z * _pull.z;

		// Keep current rope length in sync if somehow shorter (slack closed).
		if (dist < this.ropeLength) {
			this.ropeLength = dist;
		}

		// If gravity stretched past the lock, shove the body back onto the cable.
		const excess = dist - this.ropeLength;
		if (excess > 0.001) {
			const t = this.car.body.translation();
			this.car.body.setTranslation(
				{
					x: t.x + _pull.x * excess,
					y: t.y + _pull.y * excess,
					z: t.z + _pull.z * excess,
				},
				true
			);
		}

		// Kill motion along the rope so the car cannot roll back or creep forward.
		_lateral.set(
			vel.x - _pull.x * along,
			vel.y - _pull.y * along,
			vel.z - _pull.z * along
		);
		_lateral.multiplyScalar(Math.exp(-CAR_CONFIG.grapple.lateralDamp * dt));

		this.car.body.setLinvel(
			{
				x: _lateral.x,
				y: _lateral.y,
				z: _lateral.z,
			},
			true
		);
		this.car.body.wakeUp();
	}

	private boostAngularDamping() {
		if (this.savedAngularDamping != null) return;
		this.savedAngularDamping = this.car.body.angularDamping();
		this.car.body.setAngularDamping(
			this.savedAngularDamping + CAR_CONFIG.grapple.angularDampBoost
		);
	}

	private restoreAngularDamping() {
		if (this.savedAngularDamping == null) return;
		this.car.body.setAngularDamping(this.savedAngularDamping);
		this.savedAngularDamping = null;
	}

	private updateVisuals() {
		if (!this.attached) {
			this.hook.visible = false;
			this.rope.visible = false;
			return;
		}

		const t = this.car.body.translation();
		const r = this.car.body.rotation();
		_quat.set(r.x, r.y, r.z, r.w);
		_invQuat.copy(_quat).invert();

		_localAnchor.set(this.anchor.x - t.x, this.anchor.y - t.y, this.anchor.z - t.z);
		_localAnchor.applyQuaternion(_invQuat);

		this.hook.visible = true;
		this.hook.position.copy(_localAnchor);

		_aimDir.copy(this.car.grappleMountLocal).sub(_localAnchor);
		if (_aimDir.lengthSq() > 1e-8) {
			_aimDir.normalize();
			this.hook.quaternion.setFromUnitVectors(_zAxis, _aimDir);
		}

		this.ropePositions[0] = this.car.grappleMountLocal.x;
		this.ropePositions[1] = this.car.grappleMountLocal.y;
		this.ropePositions[2] = this.car.grappleMountLocal.z;
		this.ropePositions[3] = _localAnchor.x;
		this.ropePositions[4] = _localAnchor.y;
		this.ropePositions[5] = _localAnchor.z;
		(
			this.rope.geometry.getAttribute("position") as THREE.BufferAttribute
		).needsUpdate = true;
		this.rope.visible = true;
	}

	private getMountWorld(out: THREE.Vector3): THREE.Vector3 {
		const r = this.car.body.rotation();
		const t = this.car.body.translation();
		_quat.set(r.x, r.y, r.z, r.w);
		out.copy(this.car.grappleMountLocal).applyQuaternion(_quat);
		out.x += t.x;
		out.y += t.y;
		out.z += t.z;
		return out;
	}

	private buildWinch(): THREE.Group {
		const { grapple } = CAR_CONFIG;
		const root = new THREE.Group();
		root.name = "grapple-winch";

		// Compact housing sized for the bumper number plate.
		const base = new THREE.Mesh(
			new THREE.BoxGeometry(0.22, 0.12, 0.16),
			new THREE.MeshStandardMaterial({
				color: 0x3a3a3a,
				metalness: 0.55,
				roughness: 0.45,
			})
		);
		base.castShadow = true;
		root.add(base);

		const spool = new THREE.Mesh(
			new THREE.CylinderGeometry(0.05, 0.05, 0.16, 10),
			new THREE.MeshStandardMaterial({
				color: grapple.ropeColor,
				metalness: 0.2,
				roughness: 0.7,
			})
		);
		spool.rotation.z = Math.PI / 2;
		spool.position.set(0, 0.015, 0.04);
		spool.castShadow = true;
		root.add(spool);

		const arm = new THREE.Mesh(
			new THREE.BoxGeometry(0.04, 0.04, 0.12),
			new THREE.MeshStandardMaterial({
				color: grapple.hookColor,
				metalness: 0.65,
				roughness: 0.4,
			})
		);
		arm.position.set(0, 0.015, 0.12);
		arm.castShadow = true;
		root.add(arm);

		return root;
	}
}

/** Bumper / number-plate mount — prefers mesh detection, falls back to chassis size. */
export function computeGrappleMountLocal(
	chassisSize: { x: number; y: number; z: number },
	carRoot?: THREE.Object3D
): THREE.Vector3 {
	const detected = carRoot ? findFrontNumberPlateLocal(carRoot) : null;
	if (detected) return detected;

	const { grapple } = CAR_CONFIG;
	return new THREE.Vector3(
		0,
		chassisSize.y * grapple.mountYFactor + grapple.mountYNudge,
		chassisSize.z * grapple.mountZFactor + grapple.mountZNudge
	);
}

/**
 * Find the light front number-plate / bumper center in car-root local space.
 * Looks at the forward-most, low, centered body vertices (not wheels).
 */
function findFrontNumberPlateLocal(carRoot: THREE.Object3D): THREE.Vector3 | null {
	carRoot.updateMatrixWorld(true);
	const invRoot = new THREE.Matrix4().copy(carRoot.matrixWorld).invert();
	const worldBox = new THREE.Box3().setFromObject(carRoot);
	if (worldBox.isEmpty()) return null;

	const size = new THREE.Vector3();
	worldBox.getSize(size);

	const frontZ = worldBox.max.z;
	const zGate = frontZ - Math.max(0.35, size.z * 0.08);
	// Bumper band: low on the body, above the absolute undercarriage.
	const yMin = worldBox.min.y + size.y * 0.06;
	const yMax = worldBox.min.y + size.y * 0.28;
	const xGate = size.x * 0.12;

	const local = new THREE.Vector3();
	const samples: THREE.Vector3[] = [];

	carRoot.traverse((child) => {
		if (!(child instanceof THREE.Mesh)) return;
		if (child.name.toLowerCase().includes("wheel")) return;
		const pos = child.geometry?.attributes?.position;
		if (!pos) return;

		for (let i = 0; i < pos.count; i++) {
			local.fromBufferAttribute(pos, i);
			child.localToWorld(local);
			if (local.z < zGate) continue;
			if (local.y < yMin || local.y > yMax) continue;
			if (Math.abs(local.x - (worldBox.min.x + worldBox.max.x) * 0.5) > xGate) continue;
			samples.push(local.clone().applyMatrix4(invRoot));
		}
	});

	if (samples.length < 8) return null;

	// Prefer the forward-most cluster (plate sits on the bumper face).
	let maxZ = -Infinity;
	for (const p of samples) maxZ = Math.max(maxZ, p.z);
	const front = samples.filter((p) => p.z > maxZ - 0.15);
	const use = front.length >= 4 ? front : samples;

	const avg = new THREE.Vector3();
	for (const p of use) avg.add(p);
	avg.multiplyScalar(1 / use.length);
	// Sit just outside the bumper face.
	avg.z += 0.06;
	return avg;
}
