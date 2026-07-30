import { CarController } from "./carController";
import type { DriveInput } from "./carController";
import type { MobileControls } from "../../ui/mobileControls";
import { HornSound } from "../../audio/HornSound";

const GAME_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyR", "KeyE"]);

export class CarInput {
	public isEnabled = false;
	private mobile: MobileControls | null = null;
	private horn: HornSound;

	constructor(
		private controller: CarController,
		private onReset: () => void
	) {
		this.horn = new HornSound();
		window.addEventListener("keydown", this.onKeyDown);
		window.addEventListener("keyup", this.onKeyUp);
		window.addEventListener("blur", this.clearKeys);
	}

	public get isHonking() {
		return this.horn.isPlaying;
	}

	/** Call when leaving the car so the horn can't keep blaring. */
	public releaseControls() {
		this.clearKeys();
	}

	setMobileControls(mobile: MobileControls | null) {
		this.mobile = mobile;
	}

	private keys = {
		w: false,
		s: false,
		a: false,
		d: false,
		space: false,
	};

	private onKeyDown = (e: KeyboardEvent) => {
		if (!this.isEnabled) return;
		if (e.code === "KeyR") {
			e.preventDefault();
			if (e.repeat) return;
			this.clearKeys();
			this.onReset();
			return;
		}

		if (!GAME_KEYS.has(e.code)) return;
		e.preventDefault();
		if (e.repeat) return;

		if (e.code === "KeyE") {
			this.horn.play();
			return;
		}

		this.set(e, true);
	};

	private onKeyUp = (e: KeyboardEvent) => {
		if (!GAME_KEYS.has(e.code)) return;
		e.preventDefault();

		if (e.code === "KeyE") {
			if (this.isEnabled) this.horn.stop();
			return;
		}

		if (!this.isEnabled) return;
		this.set(e, false);
	};

	private clearKeys = () => {
		this.horn.stop();
		this.keys.w = false;
		this.keys.s = false;
		this.keys.a = false;
		this.keys.d = false;
		this.keys.space = false;
	};

	private set(e: KeyboardEvent, val: boolean) {
		switch (e.code) {
			case "KeyW":
				this.keys.w = val;
				break;
			case "KeyS":
				this.keys.s = val;
				break;
			case "KeyA":
				this.keys.a = val;
				break;
			case "KeyD":
				this.keys.d = val;
				break;
			case "Space":
				this.keys.space = val;
				break;
		}
	}

	applyInput(dt: number) {
		let throttle = 0;
		if (this.keys.w) throttle += 1;
		if (this.keys.s) throttle -= 1;

		let steer = 0;
		if (this.keys.a) steer += 1;
		if (this.keys.d) steer -= 1;

		let braking = this.keys.space;

		// Always merge mobile pad state when controls exist (Android touch)
		const touch = this.mobile?.getState();
		if (touch) {
			if (touch.throttle !== 0) throttle = touch.throttle;
			if (Math.abs(touch.steer) > 0.001) steer = touch.steer;
			if (touch.braking) braking = true;
		}

		const input: DriveInput = { throttle, steer, braking };
		this.controller.applyInput(dt, input);
	}

	afterPhysics(dt: number) {
		this.controller.afterPhysics(dt);
	}
}
