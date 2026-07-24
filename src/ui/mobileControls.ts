export type MobileDriveState = {
	throttle: number;
	steer: number;
	braking: boolean;
};

export type MobileControls = {
	root: HTMLElement;
	getState: () => MobileDriveState;
	dispose: () => void;
};

function isTouchUi(): boolean {
	return (
		window.matchMedia("(hover: none)").matches ||
		window.matchMedia("(pointer: coarse)").matches ||
		window.matchMedia("(max-width: 900px)").matches
	);
}

/**
 * On-screen drive controls for phones/tablets.
 * Left: steer pad · Right: gas / reverse · Brake + reset.
 */
export function createMobileControls(onReset: () => void): MobileControls {
	const root = document.createElement("div");
	root.className = "mobile-controls";
	root.id = "mobile-controls";
	root.innerHTML = `
		<div class="mc-steer" id="mc-steer" aria-label="Steer">
			<div class="mc-steer-ring"></div>
			<div class="mc-steer-knob" id="mc-steer-knob"></div>
			<span class="mc-label mc-label-left">L</span>
			<span class="mc-label mc-label-right">R</span>
		</div>
		<div class="mc-actions">
			<button type="button" class="mc-btn mc-gas" id="mc-gas" aria-label="Accelerate">▲</button>
			<button type="button" class="mc-btn mc-brake" id="mc-brake" aria-label="Reverse">▼</button>
			<button type="button" class="mc-btn mc-handbrake" id="mc-handbrake" aria-label="Brake">BRAKE</button>
			<button type="button" class="mc-btn mc-reset" id="mc-reset" aria-label="Reset">R</button>
		</div>
	`;
	document.body.appendChild(root);

	const state: MobileDriveState = {
		throttle: 0,
		steer: 0,
		braking: false,
	};

	const steerPad = root.querySelector("#mc-steer") as HTMLElement;
	const knob = root.querySelector("#mc-steer-knob") as HTMLElement;
	const gasBtn = root.querySelector("#mc-gas") as HTMLButtonElement;
	const brakeBtn = root.querySelector("#mc-brake") as HTMLButtonElement;
	const handbrakeBtn = root.querySelector("#mc-handbrake") as HTMLButtonElement;
	const resetBtn = root.querySelector("#mc-reset") as HTMLButtonElement;

	let steerPointerId: number | null = null;

	const syncVisibility = () => {
		const show = isTouchUi();
		root.classList.toggle("is-visible", show);
		root.setAttribute("aria-hidden", show ? "false" : "true");
		document.body.classList.toggle("has-mobile-controls", show);
	};
	syncVisibility();
	const mq = window.matchMedia("(max-width: 900px)");
	const mq2 = window.matchMedia("(pointer: coarse)");
	mq.addEventListener("change", syncVisibility);
	mq2.addEventListener("change", syncVisibility);

	const updateSteerFromClientX = (clientX: number) => {
		const rect = steerPad.getBoundingClientRect();
		const cx = rect.left + rect.width * 0.5;
		const half = rect.width * 0.5;
		let t = (clientX - cx) / half;
		t = Math.max(-1, Math.min(1, t));
		const dead = 0.12;
		if (Math.abs(t) < dead) t = 0;
		else t = Math.sign(t) * ((Math.abs(t) - dead) / (1 - dead));
		// CarInput: +steer = left (A), -steer = right (D)
		state.steer = -t;
		knob.style.transform = `translate(calc(-50% + ${t * 36}px), -50%)`;
	};

	const endSteer = (pointerId: number) => {
		if (steerPointerId !== pointerId) return;
		steerPointerId = null;
		state.steer = 0;
		knob.style.transform = "translate(-50%, -50%)";
		steerPad.classList.remove("is-active");
	};

	steerPad.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		e.stopPropagation();
		steerPointerId = e.pointerId;
		steerPad.setPointerCapture(e.pointerId);
		steerPad.classList.add("is-active");
		updateSteerFromClientX(e.clientX);
	});
	steerPad.addEventListener("pointermove", (e) => {
		if (steerPointerId !== e.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		updateSteerFromClientX(e.clientX);
	});
	steerPad.addEventListener("pointerup", (e) => {
		e.stopPropagation();
		endSteer(e.pointerId);
	});
	steerPad.addEventListener("pointercancel", (e) => {
		e.stopPropagation();
		endSteer(e.pointerId);
	});

	const bindHold = (
		btn: HTMLButtonElement,
		on: () => void,
		off: () => void
	) => {
		const down = (e: PointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			btn.setPointerCapture(e.pointerId);
			btn.classList.add("is-active");
			on();
		};
		const up = (e: PointerEvent) => {
			e.stopPropagation();
			btn.classList.remove("is-active");
			off();
		};
		btn.addEventListener("pointerdown", down);
		btn.addEventListener("pointerup", up);
		btn.addEventListener("pointercancel", up);
		btn.addEventListener("lostpointercapture", () => {
			btn.classList.remove("is-active");
			off();
		});
	};

	bindHold(
		gasBtn,
		() => {
			state.throttle = 1;
		},
		() => {
			if (state.throttle > 0) state.throttle = 0;
		}
	);
	bindHold(
		brakeBtn,
		() => {
			state.throttle = -1;
		},
		() => {
			if (state.throttle < 0) state.throttle = 0;
		}
	);
	bindHold(
		handbrakeBtn,
		() => {
			state.braking = true;
		},
		() => {
			state.braking = false;
		}
	);

	resetBtn.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		e.stopPropagation();
		onReset();
	});

	// Block camera orbit when interacting with HUD
	root.addEventListener(
		"pointerdown",
		(e) => {
			e.stopPropagation();
		},
		true
	);

	return {
		root,
		getState: () => ({ ...state }),
		dispose() {
			mq.removeEventListener("change", syncVisibility);
			mq2.removeEventListener("change", syncVisibility);
			root.remove();
			document.body.classList.remove("has-mobile-controls");
		},
	};
}
