export const HUMMER_CONFIG = {
	/**
	 * Hummer-only nitro flame locations in chassis-local coordinates.
	 * Edit these values to place each flame on the Hummer's exhaust pipes.
	 */
	nitroMounts: {
		left: { x: -0.6, y: 0.65, z: -2.15 },
		right: { x: 0.6, y: 0.65, z: -2.15 },
	},

	/**
	 * Hummer-only placement for the small exhaust-tip meshes.  These are kept
	 * separate from nitroMounts so moving the visual tip does not move flames.
	 */
	exhaustMeshMounts: {
		left: { x: -0.6, y: 0.65, z: -2.15 },
		right: { x: 0.6, y: 0.65, z: -2.15 },
	},

	lights: [
		{
			// Front white headlights
			color: 0xffffff,
			lensColor: "#ffffff",
			markerColor: "#ffffff",
			lensSize: 0.1, // smaller than Kenney's big yellow lamps
			spotIntensity: 18,
			distance: 26,
			angle: Math.PI / 3.0,
			forwardBias: 0.05,
			mounts: {
				left: { x: -0.7, y: 1.25, z: 2.0 },
				right: { x: 0.7, y: 1.25, z: 2.0 },
			},
			hideLens: true,
		},
		{
			// Rear red taillights (always on at night for now)
			color: 0xff0000,
			lensColor: "#ff0000",
			markerColor: "#ff0000",
			lensSize: 0.12,
			spotIntensity: 4,
			distance: 8,
			angle: Math.PI / 2.0,
			forwardBias: -0.05, // point slightly backward from the lens
			mounts: {
				left: { x: -0.8, y: 1.3, z: -2.301 },
				right: { x: 0.8, y: 1.3, z: -2.301 },
			},
			isTaillight: true,
			hideLens: true,
		},
	],

	/** Uniform scale for mesh + Rapier collider / wheels. */
	scale: 2.0, // slightly larger overall presence
	mass: 280, // much heavier than the 180 SUV
	wheelWidth: 0.85,

	/** Main engine torque (Kenney back axle, hood / -Z). */
	driveFrontAxleIndices: [0, 1],
	driveRearAxleIndices: [2, 3],
	/** Kenney front axle (+Z) — visual front wheels. */
	steeringWheelIndices: [2, 3],

	colliderYOffset: -0.05,
	colliderRoundness: 0.22,
	colliderHeightScale: 0.5,
	// Keep the chassis collider fully above the tire contact plane.  When its
	// lower edge reached below the tires, it hit the terrain first and held the
	// whole Hummer visibly above the ground.
	colliderLocalYFactor: 0.8,
	// Mass sits above the contact plane so braking transfers load toward the
	// front axle (nose dives) and acceleration squats the rear, as in a real car.
	centerOfMassY: 0.6,
	angularDamping: 2.2, // heavier, less prone to spinning easily

	spawn: { x: 0, z: 0, clearance: 1.6 },

	suspension: {
		restLength: 0.65,
		maxTravel: 0.8,
		stiffness: 35, // much softer for pronounced squat
		compression: 2.5, // compresses easily under torque
		relaxation: 4.0, // relaxes reasonably
		maxForce: 35000,
	},

	drive: {
		engineForce: 3500, // much more powerful engine
		reverseForce: 1200,
		/** 0 = RWD (needed for rear-spin drift). */
		frontDriveRatio: 0,
		brakeForce: 40, // stronger brakes needed for the mass
		maxSteerAngle: 0.38,
		steerSmoothing: 8,
		throttleAccelSmoothing: 15, // near instant torque to jerk the suspension
		throttleDecelSmoothing: 6,
		targetSpeed: 16,
		maxSpeed: 25,
		moveImpulse: 0.4,
		climbBoost: 6,
		hillAssistY: 0.55,
	},

	/**
	 * W + Space burnout drift: all-wheel braking with rear-drive slip,
	 * A/D steers a slow slide + tire smoke on BOTH rear tires.
	 */
	drift: {
		blendSpeed: 9,
		steerBoost: 1.4,
		frontBrakeForce: 90,
		maxDriftSpeed: 7.0,
		normalFriction: 14,
		normalSideStiffness: 0.9,
		driftFriction: 1.3,
		driftSideStiffness: 0.15,
		frontDriftFriction: 13,
		frontDriftSideStiffness: 0.95,
		yawTorque: 70,
		spinDriveScale: 0.85,
		smokeRate: 14, // more smoke for the heavy tires
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
		mountYFactor: -0.15,
		mountZFactor: -0.5,
		mountYNudge: -0.2,
		mountZNudge: -0.1,
		ropeColor: 0x2a241c,
		hookColor: 0x6a6e74,
	},

	/** Explicit grapple hook mount point relative to physics center */
	grappleMount: { x: 0, y: 1, z: 2.3 },
};
