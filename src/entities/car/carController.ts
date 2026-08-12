import type { DynamicRayCastVehicleController } from "@dimforge/rapier3d-compat";
import type RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { CAR_CONFIG } from "./carConfig";

export type DriveInput = {
	throttle: number;
	steer: number;
	braking: boolean;
	nitro?: boolean;
};

export class CarController {
	private steerAngle = 0;
	private targetSteer = 0;
	private throttle = 0;
	private braking = false;
	private steerInput = 0;

	/** 0 = gripped, 1 = full W+Space rear-spin drift. */
	private driftFactor = 0;
	private drifting = false;
	private smokeAccum = 0;
	private nitroActive = false;

	/**
	 * Chassis velocity as of the last `syncVelocityCache()` call.
	 *
	 * `body.linvel()` is not a getter — it crosses into wasm and builds a fresh
	 * `{x,y,z}` every call. Three consumers want the same velocity in the same
	 * frame (the engine-sound speedo, the chase camera's auto-centre check, and
	 * the network state packet), so the caller reads it once per frame via
	 * `syncVelocityCache()` and those three read out of here.
	 *
	 * This is deliberately *not* refreshed from inside `clampSpeed`, even though
	 * that is the last thing `afterPhysics` does. Velocity is still mutated after
	 * `afterPhysics` returns — the grapple reels the chassis in, explosion
	 * impulses land on it, and a destroyed car gets zeroed — and Rapier's
	 * `applyImpulse` moves `linvel` immediately rather than at the next step. A
	 * cache filled during `afterPhysics` would therefore be stale by the time the
	 * three readers run. The refresh has to sit after the last writer.
	 */
	private velX = 0;
	private velY = 0;
	private velZ = 0;
	private speedXZ = 0;

	/** Reusable out-param for `getVelocity` — never handed out by reference. */
	private readonly velOut = { x: 0, y: 0, z: 0 };

	constructor(
		private body: RAPIER.RigidBody,
		private vehicle: DynamicRayCastVehicleController,
		private driveFrontAxleIndices: number[],
		private driveRearAxleIndices: number[],
		private steeringWheelIndices: number[],
		private config: typeof CAR_CONFIG
	) {}

	isBraking(): boolean {
		return this.braking;
	}

	isDrifting(): boolean {
		return this.drifting;
	}

	getDriftFactor(): number {
		return this.driftFactor;
	}

	getThrottle(): number {
		return this.throttle;
	}

	/**
	 * Take the frame's single `linvel()` reading.
	 *
	 * Call once per frame, after everything that can change chassis velocity and
	 * before anything that reads it. See the `velX` comment for why this cannot
	 * live inside `afterPhysics`.
	 */
	syncVelocityCache() {
		const v = this.body.linvel();
		this.velX = v.x;
		this.velY = v.y;
		this.velZ = v.z;
		this.speedXZ = Math.hypot(v.x, v.z);
	}

	/** Horizontal speed as of the last `syncVelocityCache()`. No wasm crossing. */
	getSpeed(): number {
		return this.speedXZ;
	}

	/**
	 * Cached chassis velocity. The returned object is reused between calls, so
	 * copy out of it rather than holding on to it.
	 */
	getVelocity(): Readonly<{ x: number; y: number; z: number }> {
		this.velOut.x = this.velX;
		this.velOut.y = this.velY;
		this.velOut.z = this.velZ;
		return this.velOut;
	}

	/** Driven rear axle (non-steering) — engine tires. */
	getDriveWheelIndices(): number[] {
		return this.rearWheelIndices();
	}

	/** True when both rear tires should puff smoke this frame. */
	consumeTireSmokeBurst(dt: number): boolean {
		if (this.driftFactor < 0.2 || this.throttle < 0.1) {
			this.smokeAccum = 0;
			return false;
		}
		this.smokeAccum +=
			dt *
			this.config.drift.smokeRate *
			this.driftFactor *
			Math.min(1, this.throttle);
		if (this.smokeAccum < 1) return false;
		this.smokeAccum -= 1;
		return true;
	}

	/** Non-steering wheels = rear / drive axle. */
	private rearWheelIndices(): number[] {
		const steer = new Set(this.steeringWheelIndices);
		const rear: number[] = [];
		for (let i = 0; i < this.vehicle.numWheels(); i++) {
			if (!steer.has(i)) rear.push(i);
		}
		return rear.length ? rear : this.driveFrontAxleIndices;
	}

	applyInput(dt: number, input: DriveInput) {
		this.braking = input.braking;
		this.steerInput = input.steer;
		this.nitroActive = input.nitro ?? false;

		const { drive, drift } = this.config;

		// W + Space = all-wheel service braking with rear-drive drift grip.
		const wantDrift = input.braking && input.throttle > 0.12;
		const driftTarget = wantDrift ? 1 : 0;
		const driftBlend = 1 - Math.exp(-drift.blendSpeed * dt);
		this.driftFactor += (driftTarget - this.driftFactor) * driftBlend;
		if (this.driftFactor < 0.02) this.driftFactor = 0;
		this.drifting = this.driftFactor > 0.2;

		const steerSmooth = 1 - Math.exp(-drive.steerSmoothing * dt);
		const throttleTarget = input.throttle;
		const rampingUp =
			Math.abs(throttleTarget) > Math.abs(this.throttle) + 1e-4 &&
			Math.sign(throttleTarget || this.throttle) === Math.sign(throttleTarget);
		const throttleRate = rampingUp
			? drive.throttleAccelSmoothing
			: drive.throttleDecelSmoothing;
		const throttleSmooth = 1 - Math.exp(-throttleRate * dt);
		this.throttle += (throttleTarget - this.throttle) * throttleSmooth;

		const steerLimit =
			drive.maxSteerAngle *
			(1 + (drift.steerBoost - 1) * this.driftFactor);
		this.targetSteer = input.steer * steerLimit;
		this.steerAngle += (this.targetSteer - this.steerAngle) * steerSmooth;

		for (let i = 0; i < this.vehicle.numWheels(); i++) {
			this.vehicle.setWheelSteering(i, 0);
		}
		for (const i of this.steeringWheelIndices) {
			this.vehicle.setWheelSteering(i, this.steerAngle);
		}

		this.applyDriftGrip();

		const engine = this.computeEngineForce();
		const rear = this.rearWheelIndices();
		const rearSet = new Set(rear);

		// RWD: engine only on back tires.
		let rearForce = engine;
		if (this.drifting && this.throttle > 0.1) {
			rearForce =
				-Math.sign(this.throttle || 1) *
				drive.engineForce *
				drift.spinDriveScale *
				Math.abs(this.throttle) *
				this.driftFactor;
			rearForce = rearForce * 0.65 + engine * drift.spinDriveScale * 0.35;
		}

		for (let i = 0; i < this.vehicle.numWheels(); i++) {
			if (rearSet.has(i)) {
				this.vehicle.setWheelEngineForce(i, rearForce);
			} else {
				this.vehicle.setWheelEngineForce(i, 0);
			}
		}

		this.applyAllWheelBrakes();
		this.applyDriftYaw(dt);

		if (this.nitroActive) {
			const rot = this.body.rotation();
			const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
			const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
			// Apply a strong forward impulse
			const force = 1500 * dt; 
			this.body.applyImpulse({ x: forward.x * force, y: forward.y * force, z: forward.z * force }, true);
		}
	}

	private applyDriftGrip() {
		const { drift } = this.config;
		const f = this.driftFactor;
		const rear = new Set(this.rearWheelIndices());

		for (let i = 0; i < this.vehicle.numWheels(); i++) {
			if (rear.has(i)) {
				const friction =
					drift.normalFriction +
					(drift.driftFriction - drift.normalFriction) * f;
				const side =
					drift.normalSideStiffness +
					(drift.driftSideStiffness - drift.normalSideStiffness) * f;
				this.vehicle.setWheelFrictionSlip(i, friction);
				this.vehicle.setWheelSideFrictionStiffness(i, side);
			} else {
				const friction =
					drift.normalFriction +
					(drift.frontDriftFriction - drift.normalFriction) * f;
				const side =
					drift.normalSideStiffness +
					(drift.frontDriftSideStiffness - drift.normalSideStiffness) * f;
				this.vehicle.setWheelFrictionSlip(i, friction);
				this.vehicle.setWheelSideFrictionStiffness(i, side);
			}
		}
	}

	/** Service brake acts on every tire. */
	private applyAllWheelBrakes() {
		const { drive, drift } = this.config;

		for (let i = 0; i < this.vehicle.numWheels(); i++) {
			if (!this.braking) {
				this.vehicle.setWheelBrake(i, 0);
				continue;
			}
			const force = this.drifting ? drift.frontBrakeForce : drive.brakeForce;
			this.vehicle.setWheelBrake(i, force);
		}
	}

	private applyDriftYaw(dt: number) {
		if (this.driftFactor < 0.15 || Math.abs(this.steerInput) < 0.12) return;

		const { drift } = this.config;
		const yaw =
			this.steerInput * drift.yawTorque * this.driftFactor * dt;
		this.body.applyTorqueImpulse({ x: 0, y: yaw, z: 0 }, true);
	}

		afterPhysics(dt: number) {
		this.vehicle.updateVehicle(dt);
		this.applyAntiRollStabilization();
		
		let maxSpeed = this.drifting ? this.config.drift.maxDriftSpeed : this.config.drive.maxSpeed;
		if (this.nitroActive) {
			maxSpeed *= 2.5; // 150% speed boost limit during nitro
		}
		this.clampSpeed(maxSpeed);
	}

	private applyAntiRollStabilization() {
		const rot = this.body.rotation();

		const upX = 2 * (rot.x * rot.y - rot.w * rot.z);
		const upY = 1 - 2 * (rot.x * rot.x + rot.z * rot.z);
		const upZ = 2 * (rot.y * rot.z + rot.w * rot.x);

		if (upY < 0.96) {
			const tiltSeverity = (1.0 - upY) * 220.0;
			this.body.applyTorqueImpulse(
				{ x: -upZ * tiltSeverity, y: 0, z: upX * tiltSeverity },
				true
			);
		}
	}

	resetDriveState() {
		this.steerAngle = 0;
		this.targetSteer = 0;
		this.throttle = 0;
		this.braking = false;
		this.steerInput = 0;
		this.driftFactor = 0;
		this.drifting = false;
		this.smokeAccum = 0;
		this.velX = 0;
		this.velY = 0;
		this.velZ = 0;
		this.speedXZ = 0;

		const { drift } = this.config;
		for (let i = 0; i < this.vehicle.numWheels(); i++) {
			this.vehicle.setWheelSteering(i, 0);
			this.vehicle.setWheelEngineForce(i, 0);
			this.vehicle.setWheelBrake(i, 0);
			this.vehicle.setWheelFrictionSlip(i, drift.normalFriction);
			this.vehicle.setWheelSideFrictionStiffness(i, drift.normalSideStiffness);
		}
	}

	private computeEngineForce(): number {
		if (Math.abs(this.throttle) < 0.02) return 0;

		const { engineForce, reverseForce } = this.config.drive;
		const t = this.throttle;
		const mag = t > 0 ? engineForce * t : reverseForce * Math.abs(t);
		return -Math.sign(t) * mag;
	}

	private clampSpeed(max: number) {
		const v = this.body.linvel();
		const horizontal = Math.hypot(v.x, v.z);
		if (horizontal <= max) return;

		const scale = max / horizontal;
		this.body.setLinvel({ x: v.x * scale, y: v.y, z: v.z * scale }, true);
	}
}
