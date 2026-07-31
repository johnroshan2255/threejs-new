export const CAR_CONFIG = {
	/** Uniform scale for Kenney mesh + Rapier collider / wheels. */
	scale: 1.6,
	mass: 180,
	wheelWidth: 0.7,

	/** Main engine torque (Kenney back axle, hood / -Z). */
	driveFrontAxleIndices: [0, 1],
	driveRearAxleIndices: [2, 3],
	/** Kenney front axle (+Z) — visual front wheels. */
	steeringWheelIndices: [2, 3],

	colliderYOffset: -0.02,
	colliderRoundness: 0.22,
	colliderHeightScale: 0.48,
	colliderLocalYFactor: -0.45,
	centerOfMassY: -1.9,
	angularDamping: 1.8,

	spawn: { x: 0, z: 0, clearance: 1.4 },

	suspension: {
		restLength: 0.55,
		maxTravel: 0.65,
		stiffness: 48,
		compression: 4.0,
		relaxation: 4.5,
		maxForce: 22000,
	},

	drive: {
		engineForce: 520,
		reverseForce: 260,
		/** 0 = RWD (needed for rear-spin drift). */
		frontDriveRatio: 0,
		brakeForce: 28,
		maxSteerAngle: 0.42,
		steerSmoothing: 10,
		throttleAccelSmoothing: 5,
		throttleDecelSmoothing: 8,
		targetSpeed: 14,
		maxSpeed: 22,
		moveImpulse: 0.35,
		climbBoost: 4,
		hillAssistY: 0.55,
	},

	/**
	 * W + Space burnout drift: front brakes lock, rear drive spins,
	 * A/D steers a slow slide + tire smoke on BOTH rear tires.
	 */
	drift: {
		blendSpeed: 8,
		steerBoost: 1.55,
		frontBrakeForce: 70,
		maxDriftSpeed: 6.5,
		normalFriction: 12,
		normalSideStiffness: 0.8,
		driftFriction: 1.2,
		driftSideStiffness: 0.12,
		frontDriftFriction: 11,
		frontDriftSideStiffness: 0.85,
		yawTorque: 55,
		spinDriveScale: 0.85,
		smokeRate: 12,
	},
};
