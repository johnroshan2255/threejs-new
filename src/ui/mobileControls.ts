export type MobileDriveState = {
	throttle: number;
	steer: number;
	braking: boolean;
};

export type MobileControls = {
	root: HTMLElement;
	getState: () => MobileDriveState;
	isActive: () => boolean;
	setButtonVisible: (key: string, visible: boolean) => void;
	setButtonText: (key: string, text: string) => void;
	setMode: (mode: "car" | "human") => void;
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

type TouchKind = "steer" | "gas" | "reverse" | "brake" | "reset" | string;

/**
 * On-screen drive pads for Android + iPhone/iPad.
 * Uses Touch Events as the primary path (best cross-mobile support).
 */
export function createMobileControls(onReset: () => void): MobileControls {
	const root = document.createElement("div");
	root.className = "mobile-controls";
	root.id = "mobile-controls";
	root.innerHTML = `
		<div class="mc-steer-arrows">
			<div class="mc-btn mc-steer-btn mc-left-arrow" data-mc="steer-left" role="button" tabindex="0">◀</div>
			<div class="mc-btn mc-steer-btn mc-right-arrow" data-mc="steer-right" role="button" tabindex="0">▶</div>
		</div>
		<div class="mc-actions">
			<div class="mc-btn mc-gas" id="mc-gas" data-mc="gas" role="button" tabindex="0">▲</div>
			<div class="mc-btn mc-brake" id="mc-brake" data-mc="reverse" role="button" tabindex="0">▼</div>
			<div class="mc-btn mc-handbrake mc-car-only" id="mc-handbrake" data-mc="brake" role="button" tabindex="0">BRK</div>
			<div class="mc-btn mc-jump mc-human-only" data-mc="key-Space" role="button" tabindex="0">JMP</div>
			<div class="mc-btn mc-attack mc-human-only" data-mc="mouse-0" role="button" tabindex="0">ATK</div>
			<div class="mc-btn mc-aim mc-human-only" data-mc="mouse-2" role="button" tabindex="0">KICK</div>
			<div class="mc-btn mc-key mc-car-only" data-mc="key-ShiftLeft" role="button" tabindex="0">NIT</div>
			<div class="mc-btn mc-key" data-mc="key-KeyT" role="button" tabindex="0">T</div>
			<div class="mc-btn mc-key" data-mc="key-KeyH" role="button" tabindex="0">H</div>
			<div class="mc-btn mc-key mc-human-only" data-mc="key-KeyQ" role="button" tabindex="0">Q</div>
			<div class="mc-btn mc-key mc-car-only" data-mc="key-KeyE" role="button" tabindex="0">E</div>
			<div class="mc-btn mc-key" data-mc="key-KeyF" role="button" tabindex="0">F</div>
			<div class="mc-btn mc-key" data-mc="key-KeyU" role="button" tabindex="0">U</div>
		</div>
	`;
	document.body.appendChild(root);

	let gas = false;
	let reverse = false;
	let braking = false;
	let steerLeft = false;
	let steerRight = false;

	const active = new Map<number, TouchKind>();

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



	const applyKind = (kind: TouchKind, down: boolean) => {
		if (kind.startsWith("key-")) {
			const code = kind.replace("key-", "");
			let key = code.replace("Key", "");
			if (code === "Space") key = " ";
			const evt = new KeyboardEvent(down ? "keydown" : "keyup", { code, key });
			window.dispatchEvent(evt);
		} else if (kind.startsWith("mouse-")) {
			const button = parseInt(kind.replace("mouse-", ""), 10);
			const evt = new MouseEvent(down ? "mousedown" : "mouseup", { button });
			window.dispatchEvent(evt);
		} else {
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
				case "steer-left":
					steerLeft = down;
					break;
				case "steer-right":
					steerRight = down;
					break;
				case "reset":
					if (down) onReset();
					break;
			}
		}
		const el = root.querySelector(`[data-mc="${kind}"]`);
		el?.classList.toggle("is-active", down && kind !== "reset");
	};

	const kindFromPoint = (clientX: number, clientY: number): TouchKind | null => {
		const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
		const el = hit?.closest?.("[data-mc]") as HTMLElement | null;
		if (!el || !root.contains(el)) return null;
		const v = el.dataset.mc;
		if (v) return v;
		return null;
	};

	const kindFromTarget = (target: EventTarget | null): TouchKind | null => {
		const el = (target as HTMLElement | null)?.closest?.("[data-mc]") as
			| HTMLElement
			| null
			| undefined;
		if (!el || !root.contains(el)) return null;
		const v = el.dataset.mc;
		if (v) return v;
		return null;
	};

	const startControl = (id: number, kind: TouchKind, clientX: number) => {
		active.set(id, kind);
		applyKind(kind, true);
	};

	const endControl = (id: number) => {
		const kind = active.get(id);
		if (!kind) return;
		active.delete(id);
		if (kind !== "reset") applyKind(kind, false);
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
		// Arrows don't need continuous clientX updates like the joystick did.
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
		// No pointer move updates needed for simple buttons
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
			steer: (steerLeft ? 1 : 0) + (steerRight ? -1 : 0),
			braking,
		}),
		setButtonVisible: (key: string, visible: boolean) => {
			const btn = root.querySelector(`[data-mc="key-${key}"]`) as HTMLElement;
			if (btn) {
				btn.style.display = visible ? "flex" : "none";
			}
		},
		setButtonText: (key: string, text: string) => {
			const btn = root.querySelector(`[data-mc="${key}"]`) as HTMLElement;
			if (btn) btn.textContent = text;
		},
		setMode: (mode: "car" | "human") => {
			const isCar = mode === "car";
			root.classList.toggle("mode-car", isCar);
			root.classList.toggle("mode-human", !isCar);
		},
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
