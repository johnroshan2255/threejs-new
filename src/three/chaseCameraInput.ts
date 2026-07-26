const MIN_PITCH = -0.35;
const MAX_PITCH = 1.05;
const MIN_DISTANCE = 5;
const MAX_DISTANCE = 16;

/**
 * Chase-cam orbit / zoom.
 * Desktop: drag + scroll.
 * Mobile: one-finger drag on empty canvas to orbit; pinch to zoom.
 * Drive pads stay separate (touches there never start orbit).
 */
export class ChaseCameraInput {
	yaw = 0;
	pitch = 0.22;
	distance = 8;
	
	public isDragging = false;
	private dragging = false;
	private lastX = 0;
	private lastY = 0;
	private activeId: number | null = null;
	private isTouchDrag = false;

	private pinchIds = new Set<number>();
	private pinchPoints = new Map<number, { x: number; y: number }>();
	private lastPinchDist = 0;

	constructor(private domElement: HTMLElement) {
		// Pointer path (desktop + most mobile browsers)
		domElement.addEventListener("pointerdown", this.onPointerDown);
		window.addEventListener("pointermove", this.onPointerMove);
		window.addEventListener("pointerup", this.onPointerUp);
		window.addEventListener("pointercancel", this.onPointerUp);

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
			".mobile-controls, .settings-toggle, .dg, .orientation-gate"
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
		this.isDragging = true;
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
		this.isDragging = false;
		this.activeId = null;
		this.domElement.style.cursor = "grab";
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

	// --- Pointer ---

	private onPointerDown = (e: PointerEvent) => {
		if (e.button !== 0 && e.pointerType !== "touch") return;
		if (this.isUiTarget(e.target)) return;
		if (!this.hitIsCanvas(e.clientX, e.clientY)) return;

		if (e.pointerType === "touch") {
			// Touch orbit handled by Touch Events to avoid double-apply with pointer
			return;
		}

		this.beginDrag(e.pointerId, e.clientX, e.clientY, false);
		try {
			this.domElement.setPointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
	};

	private onPointerMove = (e: PointerEvent) => {
		if (e.pointerType === "touch") return;
		this.moveDrag(e.pointerId, e.clientX, e.clientY);
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
