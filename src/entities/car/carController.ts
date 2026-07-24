import type { DynamicRayCastVehicleController } from "@dimforge/rapier3d-compat";
import type RAPIER from "@dimforge/rapier3d-compat";
import { CAR_CONFIG } from "./carConfig";

export type DriveInput = {
	throttle: number;
	steer: number;
	braking: boolean;
};

export class CarController {
	private steerAngle = 0;
	private targetSteer = 0;
	private throttle = 0;
	private braking = false;

	constructor(
		private body: RAPIER.RigidBody,
		private vehicle: DynamicRayCastVehicleController,
		private driveFrontAxleIndices: number[],
		private driveRearAxleIndices: number[],
		private steeringWheelIndices: number[]
	) {}

	isBraking(): boolean {
		return this.braking;
	}

	applyInput(dt: number, input: DriveInput) {
		this.braking = input.braking;

		const { drive } = CAR_CONFIG;
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

		this.targetSteer = input.steer * drive.maxSteerAngle;
		this.steerAngle += (this.targetSteer - this.steerAngle) * steerSmooth;

		for (let i = 0; i < this.vehicle.numWheels(); i++) {
			this.vehicle.setWheelSteering(i, 0);
		}
		for (const i of this.steeringWheelIndices) {
			this.vehicle.setWheelSteering(i, this.steerAngle);
		}

		const engine = this.computeEngineForce();

		for (const i of this.driveRearAxleIndices) {
			this.vehicle.setWheelEngineForce(i, engine);
		}

		for (const i of this.driveFrontAxleIndices) {
			this.vehicle.setWheelEngineForce(i, engine * drive.frontDriveRatio);
		}

		const brake = this.braking ? drive.brakeForce : 0;
		for (let i = 0; i < this.vehicle.numWheels(); i++) {
			this.vehicle.setWheelBrake(i, brake);
		}
	}

	afterPhysics(dt: number) {
		this.vehicle.updateVehicle(dt);
		this.applyAntiRollStabilization();
		this.clampSpeed(CAR_CONFIG.drive.maxSpeed);
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

		for (let i = 0; i < this.vehicle.numWheels(); i++) {
			this.vehicle.setWheelSteering(i, 0);
			this.vehicle.setWheelEngineForce(i, 0);
			this.vehicle.setWheelBrake(i, 0);
		}
	}

	private computeEngineForce(): number {
		if (Math.abs(this.throttle) < 0.02) return 0;

		const { engineForce, reverseForce } = CAR_CONFIG.drive;
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
