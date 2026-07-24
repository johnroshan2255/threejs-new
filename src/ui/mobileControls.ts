export type MobileDriveState = {
	throttle: number;
	steer: number;
	braking: boolean;
};

export type MobileControls = {
	root: HTMLElement;
	getState: () => MobileDriveState;
	/** True when on-screen pads should be used (phones / tablets). */
	isActive: () => boolean;
	dispose: () => void;
};

function isMobileDevice(): boolean {
	return (
		window.matchMedia("(hover: none)").matches ||
		window.matchMedia("(pointer: coarse)").matches ||
		/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
	);
}

/** Soft curve so small finger moves don't snap to full lock. */
function softenAxis(v: number, deadzone = 0.18, power = 1.55): number {
	const a = Math.abs(v);
	if (a < deadzone) return 0;
	const t = (a - deadzone) / (1 - deadzone);
	return Math.sign(v) * Math.pow(Math.min(1, t), power);
}

/**
 * On-screen drive controls for phones/tablets.
 * Left: relative steer pad · Right: gas / reverse / brake / reset.
 */
export function createMobileControls(onReset: () => void): MobileControls {
	const root = document.createElement("div");
	root.className = "mobile-controls";
	root.id = "mobile-controls";
	root.innerHTML = `
		<div class="mc-steer" id="mc-steer" aria-label="Steer">
			<div class="mc-steer-ring"></div>
			<div class="mc-steer-knob" id="mc-steer-knob"></div>
		</div>
		<div class="mc-actions">
			<button type="button" class="mc-btn mc-gas" id="mc-gas" aria-label="Accelerate">▲</button>
			<button type="button" class="mc-btn mc-brake" id="mc-brake" aria-label="Reverse">▼</button>
			<button type="button" class="mc-btn mc-handbrake" id="mc-handbrake" aria-label="Brake">BRAKE</button>
			<button type="button" class="mc-btn mc-reset" id="mc-reset" aria-label="Reset">R</button>
		</div>
	`;
	document.body.appendChild(root);

	let gas = false;
	let reverse = false;
	let braking = false;
	let steer = 0;

	const steerPad = root.querySelector("#mc-steer") as HTMLElement;
	const knob = root.querySelector("#mc-steer-knob") as HTMLElement;
	const gasBtn = root.querySelector("#mc-gas") as HTMLButtonElement;
	const brakeBtn = root.querySelector("#mc-brake") as HTMLButtonElement;
	const handbrakeBtn = root.querySelector("#mc-handbrake") as HTMLButtonElement;
	const resetBtn = root.querySelector("#mc-reset") as HTMLButtonElement;

	let steerPointerId: number | null = null;
	let steerOriginX = 0;

	const syncVisibility = () => {
		const show = isMobileDevice();
		root.classList.toggle("is-visible", show);
		root.setAttribute("aria-hidden", show ? "false" : "true");
		document.body.classList.toggle("has-mobile-controls", show);
	};
	syncVisibility();

	const onOrient = () => syncVisibility();
	window.addEventListener("resize", onOrient);
	window.addEventListener("orientationchange", onOrient);
	const mq = window.matchMedia("(pointer: coarse)");
	mq.addEventListener("change", syncVisibility);

	const setKnob = (visualX: number) => {
		const x = Math.max(-40, Math.min(40, visualX * 40));
		knob.style.transform = `translate(calc(-50% + ${x}px), -50%)`;
	};

	const updateSteer = (clientX: number) => {
		const rect = steerPad.getBoundingClientRect();
		// Relative drag from press point — less twitchy than absolute-from-center
		const travel = rect.width * 0.42;
		let raw = (clientX - steerOriginX) / Math.max(24, travel);
		raw = Math.max(-1, Math.min(1, raw));
		const soft = softenAxis(raw, 0.16, 1.45);
		// Slightly reduced max lock on touch
		steer = -soft * 0.82;
		setKnob(soft);
	};

	const endSteer = (pointerId: number) => {
		if (steerPointerId !== pointerId) return;
		steerPointerId = null;
		steer = 0;
		setKnob(0);
		steerPad.classList.remove("is-active");
	};

	const onSteerDown = (e: PointerEvent) => {
		if (steerPointerId !== null) return;
		e.preventDefault();
		e.stopPropagation();
		steerPointerId = e.pointerId;
		steerOriginX = e.clientX;
		steerPad.classList.add("is-active");
		try {
			steerPad.setPointerCapture(e.pointerId);
		} catch {
			/* iOS can throw if already released */
		}
		updateSteer(e.clientX);
	};

	const onSteerMove = (e: PointerEvent) => {
		if (steerPointerId !== e.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		updateSteer(e.clientX);
	};

	const onSteerUp = (e: PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		endSteer(e.pointerId);
	};

	steerPad.addEventListener("pointerdown", onSteerDown);
	steerPad.addEventListener("pointermove", onSteerMove);
	steerPad.addEventListener("pointerup", onSteerUp);
	steerPad.addEventListener("pointercancel", onSteerUp);

	const held = new Map<number, HTMLButtonElement>();

	const bindHold = (
		btn: HTMLButtonElement,
		on: () => void,
		off: () => void
	) => {
		const down = (e: PointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			held.set(e.pointerId, btn);
			btn.classList.add("is-active");
			try {
				btn.setPointerCapture(e.pointerId);
			} catch {
				/* ignore */
			}
			on();
		};
		const up = (e: PointerEvent) => {
			if (!held.has(e.pointerId)) return;
			held.delete(e.pointerId);
			e.preventDefault();
			e.stopPropagation();
			btn.classList.remove("is-active");
			off();
		};
		btn.addEventListener("pointerdown", down);
		btn.addEventListener("pointerup", up);
		btn.addEventListener("pointercancel", up);
		// Do NOT clear on lostpointercapture — iOS fires it spuriously and killed input
	};

	bindHold(
		gasBtn,
		() => {
			gas = true;
		},
		() => {
			gas = false;
		}
	);
	bindHold(
		brakeBtn,
		() => {
			reverse = true;
		},
		() => {
			reverse = false;
		}
	);
	bindHold(
		handbrakeBtn,
		() => {
			braking = true;
		},
		() => {
			braking = false;
		}
	);

	resetBtn.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		e.stopPropagation();
		onReset();
	});

	// Keep page from scrolling under the pads
	root.addEventListener(
		"touchmove",
		(e) => {
			e.preventDefault();
		},
		{ passive: false }
	);

	root.addEventListener(
		"pointerdown",
		(e) => {
			e.stopPropagation();
		},
		true
	);

	return {
		root,
		isActive: () => isMobileDevice(),
		getState: () => ({
			throttle: gas ? 1 : reverse ? -1 : 0,
			steer,
			braking,
		}),
		dispose() {
			window.removeEventListener("resize", onOrient);
			window.removeEventListener("orientationchange", onOrient);
			mq.removeEventListener("change", syncVisibility);
			root.remove();
			document.body.classList.remove("has-mobile-controls");
		},
	};
}
