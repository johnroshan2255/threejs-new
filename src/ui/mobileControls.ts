export type MobileDriveState = {
	throttle: number;
	steer: number;
	braking: boolean;
};

export type MobileControls = {
	root: HTMLElement;
	getState: () => MobileDriveState;
	isActive: () => boolean;
	dispose: () => void;
};

/** True for phones/tablets — Android, iPhone, iPad (incl. iPadOS desktop UA). */
export function isMobileDevice(): boolean {
	if (typeof navigator === "undefined") return false;
	const ua = navigator.userAgent || "";
	const touchPoints = navigator.maxTouchPoints || 0;

	// iPadOS 13+ reports as MacIntel but is a tablet
	const iPadDesktopUa =
		navigator.platform === "MacIntel" && touchPoints > 1;

	return (
		iPadDesktopUa ||
		/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(
			ua
		) ||
		window.matchMedia("(pointer: coarse)").matches ||
		(touchPoints > 0 &&
			window.matchMedia("(hover: none)").matches &&
			Math.min(window.screen.width, window.screen.height) <= 1024)
	);
}

function softenAxis(v: number, deadzone = 0.14, power = 1.35): number {
	const a = Math.abs(v);
	if (a < deadzone) return 0;
	const t = (a - deadzone) / (1 - deadzone);
	return Math.sign(v) * Math.pow(Math.min(1, t), power);
}

type TouchKind = "steer" | "gas" | "reverse" | "brake" | "reset";

/**
 * On-screen drive pads for Android + iPhone/iPad.
 * Uses Touch Events as the primary path (best cross-mobile support).
 */
export function createMobileControls(onReset: () => void): MobileControls {
	const root = document.createElement("div");
	root.className = "mobile-controls";
	root.id = "mobile-controls";
	root.innerHTML = `
		<div class="mc-steer" id="mc-steer" data-mc="steer" aria-label="Steer">
			<div class="mc-steer-ring"></div>
			<div class="mc-steer-knob" id="mc-steer-knob"></div>
		</div>
		<div class="mc-actions">
			<div class="mc-btn mc-gas" id="mc-gas" data-mc="gas" role="button" tabindex="0" aria-label="Accelerate">▲</div>
			<div class="mc-btn mc-brake" id="mc-brake" data-mc="reverse" role="button" tabindex="0" aria-label="Reverse">▼</div>
			<div class="mc-btn mc-handbrake" id="mc-handbrake" data-mc="brake" role="button" tabindex="0" aria-label="Brake">BRAKE</div>
			<div class="mc-btn mc-reset" id="mc-reset" data-mc="reset" role="button" tabindex="0" aria-label="Reset">R</div>
		</div>
	`;
	document.body.appendChild(root);

	let gas = false;
	let reverse = false;
	let braking = false;
	let steer = 0;

	const steerPad = root.querySelector("#mc-steer") as HTMLElement;
	const knob = root.querySelector("#mc-steer-knob") as HTMLElement;

	const active = new Map<number, TouchKind>();
	let steerOriginX = 0;

	const syncVisibility = () => {
		const show = isMobileDevice();
		root.classList.toggle("is-visible", show);
		root.setAttribute("aria-hidden", show ? "false" : "true");
		document.body.classList.toggle("has-mobile-controls", show);
	};
	syncVisibility();

	const delayedSync = () => {
		syncVisibility();
		window.setTimeout(syncVisibility, 100);
		window.setTimeout(syncVisibility, 350);
	};
	window.addEventListener("resize", delayedSync);
	window.addEventListener("orientationchange", delayedSync);

	const setKnob = (visualX: number) => {
		const x = Math.max(-42, Math.min(42, visualX * 42));
		knob.style.transform = `translate(calc(-50% + ${x}px), -50%)`;
	};

	const updateSteer = (clientX: number) => {
		const rect = steerPad.getBoundingClientRect();
		const travel = Math.max(28, rect.width * 0.45);
		let raw = (clientX - steerOriginX) / travel;
		raw = Math.max(-1, Math.min(1, raw));
		const soft = softenAxis(raw);
		steer = -soft * 0.9;
		setKnob(soft);
	};

	const clearSteer = () => {
		steer = 0;
		setKnob(0);
		steerPad.classList.remove("is-active");
	};

	const applyKind = (kind: TouchKind, down: boolean) => {
		switch (kind) {
			case "gas":
				gas = down;
				break;
			case "reverse":
				reverse = down;
				break;
			case "brake":
				braking = down;
				break;
			case "steer":
				if (!down) clearSteer();
				break;
			case "reset":
				if (down) onReset();
				break;
		}
		const el = root.querySelector(`[data-mc="${kind}"]`);
		el?.classList.toggle("is-active", down && kind !== "reset");
	};

	const kindFromPoint = (clientX: number, clientY: number): TouchKind | null => {
		const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
		const el = hit?.closest?.("[data-mc]") as HTMLElement | null;
		if (!el || !root.contains(el)) return null;
		const v = el.dataset.mc;
		if (
			v === "steer" ||
			v === "gas" ||
			v === "reverse" ||
			v === "brake" ||
			v === "reset"
		) {
			return v;
		}
		return null;
	};

	const kindFromTarget = (target: EventTarget | null): TouchKind | null => {
		const el = (target as HTMLElement | null)?.closest?.("[data-mc]") as
			| HTMLElement
			| null
			| undefined;
		if (!el || !root.contains(el)) return null;
		const v = el.dataset.mc;
		if (
			v === "steer" ||
			v === "gas" ||
			v === "reverse" ||
			v === "brake" ||
			v === "reset"
		) {
			return v;
		}
		return null;
	};

	const startControl = (id: number, kind: TouchKind, clientX: number) => {
		active.set(id, kind);
		if (kind === "steer") {
			steerOriginX = clientX;
			steerPad.classList.add("is-active");
			updateSteer(clientX);
		} else {
			applyKind(kind, true);
		}
	};

	const endControl = (id: number) => {
		const kind = active.get(id);
		if (!kind) return;
		active.delete(id);
		if (kind === "steer") clearSteer();
		else if (kind !== "reset") applyKind(kind, false);
	};

	const onTouchStart = (e: TouchEvent) => {
		for (let i = 0; i < e.changedTouches.length; i++) {
			const t = e.changedTouches[i];
			const kind =
				kindFromTarget(t.target) || kindFromPoint(t.clientX, t.clientY);
			if (!kind) continue;
			e.preventDefault();
			startControl(t.identifier, kind, t.clientX);
		}
	};

	const onTouchMove = (e: TouchEvent) => {
		let used = false;
		for (let i = 0; i < e.touches.length; i++) {
			const t = e.touches[i];
			const kind = active.get(t.identifier);
			if (!kind) continue;
			used = true;
			if (kind === "steer") updateSteer(t.clientX);
		}
		if (used) e.preventDefault();
	};

	const onTouchEnd = (e: TouchEvent) => {
		for (let i = 0; i < e.changedTouches.length; i++) {
			endControl(e.changedTouches[i].identifier);
		}
	};

	// Touch path — Android Chrome + iOS Safari
	root.addEventListener("touchstart", onTouchStart, { passive: false });
	window.addEventListener("touchmove", onTouchMove, { passive: false });
	window.addEventListener("touchend", onTouchEnd, { passive: false });
	window.addEventListener("touchcancel", onTouchEnd, { passive: false });

	// Mouse / desktop DevTools fallback (ignore real touch pointers — already handled)
	const onPointerDown = (e: PointerEvent) => {
		if (e.pointerType === "touch") return;
		const kind =
			kindFromTarget(e.target) || kindFromPoint(e.clientX, e.clientY);
		if (!kind) return;
		e.preventDefault();
		e.stopPropagation();
		startControl(e.pointerId, kind, e.clientX);
	};
	const onPointerMove = (e: PointerEvent) => {
		if (e.pointerType === "touch") return;
		const kind = active.get(e.pointerId);
		if (kind === "steer") updateSteer(e.clientX);
	};
	const onPointerUp = (e: PointerEvent) => {
		if (e.pointerType === "touch") return;
		endControl(e.pointerId);
	};

	root.addEventListener("pointerdown", onPointerDown);
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", onPointerUp);
	window.addEventListener("pointercancel", onPointerUp);

	return {
		root,
		isActive: () =>
			isMobileDevice() &&
			!document.body.classList.contains("orientation-portrait-lock"),
		getState: () => ({
			throttle: gas ? 1 : reverse ? -1 : 0,
			steer,
			braking,
		}),
		dispose() {
			window.removeEventListener("resize", delayedSync);
			window.removeEventListener("orientationchange", delayedSync);
			window.removeEventListener("touchmove", onTouchMove);
			window.removeEventListener("touchend", onTouchEnd);
			window.removeEventListener("touchcancel", onTouchEnd);
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerUp);
			root.remove();
			document.body.classList.remove("has-mobile-controls");
		},
	};
}
