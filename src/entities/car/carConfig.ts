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
		engineForce: 800,
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

	/**
	 * Front winch / grappling hook (T while driving).
	 * Mount sits on the front number-plate / bumper for any chassis size.
	 */
	grapple: {
		maxRange: 30,
		/** Steady reel-in speed while holding T (~5 mph). */
		reelSpeed: 2.235,
		/** Kill sideways bounce while winching. */
		lateralDamp: 6.0,
		/** Soften spinning / hopping while reeled. */
		angularDampBoost: 3.0,
		/** Release when this close to the anchor. */
		arriveDistance: 2.5,
		/** Only ease speed inside this distance from the anchor. */
		arriveSlowRadius: 3.5,
		/** Aim pitches for the attach fan (negative = down, positive = up steep faces). */
		aimPitches: [-0.4, -0.2, 0, 0.25, 0.5, 0.85, 1.2, 1.7, 2.2],
		/** Slight left/right yaw so we still catch offset cliff faces. */
		aimYaws: [0, -0.18, 0.18],
		/** On steep / near-vertical hills, prefer a latch up to this many meters above the bumper. */
		steepAttachHeight: 5,
		/** Minimum useful attach distance. */
		minAttachDist: 1.0,
		/**
		 * Bumper number-plate local offset from chassis size.
		 * Y low on the bumper; Z at the front face.
		 */
		mountYFactor: 0.12,
		mountZFactor: 0.5,
		/** Extra world nudge so the winch sits on the plate, not inside the bumper. */
		mountYNudge: 0.08,
		mountZNudge: 0.12,
		ropeColor: 0x2a241c,
		hookColor: 0x6a6e74,
	},
};
