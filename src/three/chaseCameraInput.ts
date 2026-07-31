const MIN_PITCH = -0.35;
const MAX_PITCH = 1.05;
const MIN_DISTANCE = 5;
const MAX_DISTANCE = 16;
/** Mouse-look sensitivity (radians per pixel of movement). */
const LOOK_SENSITIVITY = 0.0025;
/**
 * How long after the last mouse-look movement the camera still counts as
 * user-steered, so auto-recenter does not fight the mouse mid-look.
 */
const LOOK_HOLD_MS = 450;
/** Ignore absurd jumps (window re-entry, alt-tab) in unlocked mouse look. */
const MAX_UNLOCKED_STEP_PX = 180;

export type ChaseCameraInputOptions = {
	/**
	 * True while the player is driving / walking and free mouse-look should
	 * steer the camera (false in the lobby, in edit mode, on touch devices).
	 */
	isFreeLookAllowed?: () => boolean;
};

/**
 * Chase-cam orbit / zoom.
 * Desktop: free mouse-look — moving the mouse turns the camera, no button held.
 *   Clicking the canvas grabs pointer lock so the look never stops at a screen
 *   edge; Esc releases it and plain mouse movement takes over again.
 *   Hold Alt to park the camera and get the cursor back for UI; release Alt and
 *   the camera follows the mouse again.
 * Mobile: one-finger drag on empty canvas to orbit; pinch to zoom.
 * Drive pads stay separate (touches there never start orbit).
 */
export class ChaseCameraInput {
	yaw = 0;
	pitch = 0.22;
	distance = 8;

	private dragging = false;
	private lastX = 0;
	private lastY = 0;
	private activeId: number | null = null;
	private isTouchDrag = false;

	private pinchIds = new Set<number>();
	private pinchPoints = new Map<number, { x: number; y: number }>();
	private lastPinchDist = 0;

	/** Pointer lock is held by the canvas — deltas come from movementX/Y. */
	private locked = false;
	private lookActiveUntil = 0;
	private hasFreeSample = false;
	private freeX = 0;
	private freeY = 0;
	/** Alt held → cursor mode: the camera ignores the mouse until Alt is up. */
	private altHeld = false;
	/** Was the pointer locked when Alt went down? Restore it on release. */
	private relockAfterAlt = false;

	/** True while the player is steering the camera (drag, or recent mouse-look). */
	get isDragging(): boolean {
		return this.dragging || performance.now() < this.lookActiveUntil;
	}

	constructor(
		private domElement: HTMLElement,
		private options: ChaseCameraInputOptions = {}
	) {
		// Pointer path (desktop + most mobile browsers)
		domElement.addEventListener("pointerdown", this.onPointerDown);
		window.addEventListener("pointermove", this.onPointerMove);
		window.addEventListener("pointerup", this.onPointerUp);
		window.addEventListener("pointercancel", this.onPointerUp);
		window.addEventListener("pointerout", this.onPointerOut);
		window.addEventListener("blur", this.onWindowBlur);
		window.addEventListener("keydown", this.onKeyDown);
		window.addEventListener("keyup", this.onKeyUp);
		document.addEventListener("visibilitychange", this.onWindowBlur);
		document.addEventListener("pointerlockchange", this.onPointerLockChange);
		document.addEventListener("pointerlockerror", this.onPointerLockChange);

		// Touch path — more reliable on some Android / iOS builds
		domElement.addEventListener("touchstart", this.onTouchStart, { passive: false });
		window.addEventListener("touchmove", this.onTouchMove, { passive: false });
		window.addEventListener("touchend", this.onTouchEnd, { passive: false });
		window.addEventListener("touchcancel", this.onTouchEnd, { passive: false });

		domElement.addEventListener("wheel", this.onWheel, { passive: false });
		domElement.style.cursor = "grab";
		domElement.style.touchAction = "none";
	}

	private isUiTarget(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		return !!el?.closest?.(
			".mobile-controls, .settings-toggle, .dg, .orientation-gate, .logout-modal, #room-list-panel, #game-top-nav, .loading-screen"
		);
	}

	private hitIsCanvas(clientX: number, clientY: number): boolean {
		const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
		if (!el) return false;
		if (this.isUiTarget(el)) return false;
		return el === this.domElement || this.domElement.contains(el);
	}

	private beginDrag(id: number, x: number, y: number, touch: boolean) {
		this.dragging = true;
		this.activeId = id;
		this.lastX = x;
		this.lastY = y;
		this.isTouchDrag = touch;
		this.domElement.style.cursor = "grabbing";
	}

	private moveDrag(id: number, x: number, y: number) {
		if (!this.dragging || this.activeId !== id) return;
		const dx = x - this.lastX;
		const dy = y - this.lastY;
		this.lastX = x;
		this.lastY = y;
		const sens = this.isTouchDrag ? 0.0035 : 0.004;
		this.yaw -= dx * sens;
		this.pitch += dy * sens * 0.75;
		this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch));
	}

	private endDrag(id: number) {
		if (this.activeId !== null && id !== this.activeId) return;
		this.dragging = false;
		this.activeId = null;
		this.domElement.style.cursor = this.locked ? "none" : "grab";
	}

	private updatePinch() {
		if (this.pinchIds.size < 2) return;
		const pts = [...this.pinchIds]
			.map((id) => this.pinchPoints.get(id))
			.filter(Boolean) as { x: number; y: number }[];
		if (pts.length < 2) return;
		const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
		if (this.lastPinchDist > 0) {
			this.distance -= (dist - this.lastPinchDist) * 0.02;
			this.distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, this.distance));
		}
		this.lastPinchDist = dist;
	}

	// --- Alt = temporary cursor mode ---

	private setAltHeld(held: boolean) {
		if (this.altHeld === held) return;
		this.altHeld = held;
		// Re-baseline so resuming look does not jump by however far the cursor
		// travelled while it was free.
		this.hasFreeSample = false;
		if (held) {
			this.lookActiveUntil = 0;
			this.relockAfterAlt = this.locked;
			this.exitPointerLock();
			this.domElement.style.cursor = "default";
			return;
		}

		this.domElement.style.cursor = this.dragging ? "grabbing" : "grab";
		// Hand the mouse back to the camera exactly as it was. The key release
		// usually counts as user activation; if the browser refuses, cursor-based
		// look takes over until the next canvas click.
		if (this.relockAfterAlt && this.options.isFreeLookAllowed?.()) {
			this.requestPointerLock();
		}
		this.relockAfterAlt = false;
	}

	/**
	 * Alt+Tab / Alt+click away swallows the keyup, which would leave the camera
	 * stuck in cursor mode — any later event without altKey clears it.
	 */
	private syncAltFromEvent(e: KeyboardEvent | PointerEvent) {
		if (this.altHeld && !e.altKey) this.setAltHeld(false);
	}

	private isAltKey(e: KeyboardEvent) {
		return e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight";
	}

	private onKeyDown = (e: KeyboardEvent) => {
		if (!this.isAltKey(e)) {
			this.syncAltFromEvent(e);
			return;
		}
		this.setAltHeld(true);
		// Keep Alt from handing focus to the browser menu bar mid-game.
		if (this.options.isFreeLookAllowed?.()) e.preventDefault();
	};

	private onKeyUp = (e: KeyboardEvent) => {
		if (this.isAltKey(e)) {
			this.setAltHeld(false);
			return;
		}
		this.syncAltFromEvent(e);
	};

	// --- Mouse look (no button held) ---

	/** Apply a raw mouse delta to yaw / pitch. */
	private applyLook(dx: number, dy: number) {
		if (dx === 0 && dy === 0) return;
		this.yaw -= dx * LOOK_SENSITIVITY;
		this.pitch += dy * LOOK_SENSITIVITY * 0.75;
		this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch));
		this.lookActiveUntil = performance.now() + LOOK_HOLD_MS;
	}

	/**
	 * Cursor-position based look, used until the canvas takes pointer lock.
	 * Works with zero clicks; stalls at the screen edge, which the lock fixes.
	 */
	private freeLookFromPosition(e: PointerEvent) {
		if (this.isUiTarget(e.target)) {
			this.hasFreeSample = false;
			return;
		}
		const el = e.target as Node | null;
		const overCanvas = el === this.domElement || this.domElement.contains(el);
		if (!overCanvas) {
			this.hasFreeSample = false;
			return;
		}
		if (!this.hasFreeSample) {
			this.freeX = e.clientX;
			this.freeY = e.clientY;
			this.hasFreeSample = true;
			return;
		}
		const dx = e.clientX - this.freeX;
		const dy = e.clientY - this.freeY;
		this.freeX = e.clientX;
		this.freeY = e.clientY;
		if (
			Math.abs(dx) > MAX_UNLOCKED_STEP_PX ||
			Math.abs(dy) > MAX_UNLOCKED_STEP_PX
		) {
			return;
		}
		this.applyLook(dx, dy);
	}

	/** Pointer lock removes the screen-edge limit; needs a user gesture. */
	private requestPointerLock() {
		const el = this.domElement as HTMLElement & {
			requestPointerLock?: (options?: {
				unadjustedMovement?: boolean;
			}) => Promise<void> | void;
		};
		if (!el.requestPointerLock) return;
		try {
			const result = el.requestPointerLock({ unadjustedMovement: true });
			// Chrome rejects unadjustedMovement on some platforms — retry plain.
			void Promise.resolve(result).catch(() => {
				try {
					el.requestPointerLock?.();
				} catch {
					/* lock unavailable — cursor-position look still works */
				}
			});
		} catch {
			try {
				el.requestPointerLock();
			} catch {
				/* lock unavailable */
			}
		}
	}

	/** Per-frame: give the cursor back as soon as free look stops being allowed. */
	syncFreeLook() {
		if (!this.locked) return;
		if (this.altHeld || !this.options.isFreeLookAllowed?.()) this.exitFreeLook();
	}

	/** Release mouse-look (edit mode, lobby, UI that needs the cursor). */
	exitFreeLook() {
		this.hasFreeSample = false;
		this.lookActiveUntil = 0;
		this.exitPointerLock();
	}

	private exitPointerLock() {
		if (document.pointerLockElement === this.domElement) {
			document.exitPointerLock();
		}
	}

	private onPointerLockChange = () => {
		this.locked = document.pointerLockElement === this.domElement;
		this.hasFreeSample = false;
		this.domElement.style.cursor = this.locked
			? "none"
			: this.altHeld
				? "default"
				: this.dragging
					? "grabbing"
					: "grab";
	};

	private onPointerOut = (e: PointerEvent) => {
		if (e.pointerType === "touch") return;
		this.hasFreeSample = false;
	};

	private onWindowBlur = () => {
		this.hasFreeSample = false;
		// Alt+Tab leaves no keyup behind — do not come back stuck in cursor mode.
		// No re-lock here: the window is losing focus, so the request would fail.
		this.relockAfterAlt = false;
		this.setAltHeld(false);
	};

	// --- Pointer ---

	private onPointerDown = (e: PointerEvent) => {
		if (e.button !== 0 && e.pointerType !== "touch") return;
		if (this.isUiTarget(e.target)) return;
		if (!this.hitIsCanvas(e.clientX, e.clientY)) return;

		if (e.pointerType === "touch") {
			// Touch orbit handled by Touch Events to avoid double-apply with pointer
			return;
		}

		// Alt held: the click belongs to the UI — no lock, no orbit drag.
		if (this.altHeld) return;
		// Clicking the world upgrades cursor look to pointer lock (edge-free).
		if (!this.locked && this.options.isFreeLookAllowed?.()) {
			this.requestPointerLock();
			return;
		}
		if (this.locked) return;

		this.beginDrag(e.pointerId, e.clientX, e.clientY, false);
		try {
			this.domElement.setPointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
	};

	private onPointerMove = (e: PointerEvent) => {
		if (e.pointerType === "touch") return;
		this.syncAltFromEvent(e);
		// Alt held: the mouse belongs to the cursor, not the camera. Checked
		// before the locked branch — the lock exit is a frame behind the keydown.
		if (this.altHeld) return;
		if (this.locked) {
			this.applyLook(e.movementX, e.movementY);
			return;
		}
		if (this.dragging) {
			this.moveDrag(e.pointerId, e.clientX, e.clientY);
			return;
		}
		if (this.options.isFreeLookAllowed?.()) this.freeLookFromPosition(e);
	};

	private onPointerUp = (e: PointerEvent) => {
		if (e.pointerType === "touch") return;
		this.endDrag(e.pointerId);
		try {
			if (this.domElement.hasPointerCapture(e.pointerId)) {
				this.domElement.releasePointerCapture(e.pointerId);
			}
		} catch {
			/* ignore */
		}
	};

	// --- Touch (mobile camera) ---

	private onTouchStart = (e: TouchEvent) => {
		for (let i = 0; i < e.changedTouches.length; i++) {
			const t = e.changedTouches[i];
			if (!this.hitIsCanvas(t.clientX, t.clientY)) continue;
			e.preventDefault();

			this.pinchIds.add(t.identifier);
			this.pinchPoints.set(t.identifier, { x: t.clientX, y: t.clientY });

			if (this.pinchIds.size >= 2) {
				this.dragging = false;
				this.activeId = null;
				this.lastPinchDist = 0;
				this.updatePinch();
			} else {
				this.beginDrag(t.identifier, t.clientX, t.clientY, true);
			}
		}
	};

	private onTouchMove = (e: TouchEvent) => {
		let used = false;
		for (let i = 0; i < e.touches.length; i++) {
			const t = e.touches[i];
			if (!this.pinchIds.has(t.identifier) && this.activeId !== t.identifier) continue;
			used = true;
			this.pinchPoints.set(t.identifier, { x: t.clientX, y: t.clientY });

			if (this.pinchIds.size >= 2 && this.pinchIds.has(t.identifier)) {
				this.updatePinch();
			} else {
				this.moveDrag(t.identifier, t.clientX, t.clientY);
			}
		}
		if (used) e.preventDefault();
	};

	private onTouchEnd = (e: TouchEvent) => {
		for (let i = 0; i < e.changedTouches.length; i++) {
			const t = e.changedTouches[i];
			this.pinchIds.delete(t.identifier);
			this.pinchPoints.delete(t.identifier);
			this.endDrag(t.identifier);
		}
		if (this.pinchIds.size < 2) this.lastPinchDist = 0;
	};

	private onWheel = (e: WheelEvent) => {
		e.preventDefault();
		this.distance += e.deltaY * 0.01;
		this.distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, this.distance));
	};
}
