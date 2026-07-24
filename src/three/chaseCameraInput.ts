const MIN_PITCH = -0.35;
const MAX_PITCH = 1.05;
const MIN_DISTANCE = 5;
const MAX_DISTANCE = 16;

export class ChaseCameraInput {
	yaw = 0;
	pitch = 0.22;
	distance = 8;

	private dragging = false;
	private lastX = 0;
	private lastY = 0;
	private activePointerId: number | null = null;

	constructor(private domElement: HTMLElement) {
		domElement.addEventListener("pointerdown", this.onPointerDown);
		domElement.addEventListener("pointermove", this.onPointerMove);
		domElement.addEventListener("pointerup", this.onPointerUp);
		domElement.addEventListener("pointercancel", this.onPointerUp);
		domElement.addEventListener("wheel", this.onWheel, { passive: false });
		domElement.style.cursor = "grab";
		domElement.style.touchAction = "none";
	}

	/** When mobile pads are up, ignore single-finger orbit (it fights driving). */
	private mobilePadsActive(): boolean {
		return document.body.classList.contains("has-mobile-controls");
	}

	private onPointerDown = (e: PointerEvent) => {
		if (e.button !== 0 && e.pointerType !== "touch") return;

		const target = e.target as HTMLElement | null;
		if (target?.closest?.(".mobile-controls, .settings-toggle, .dg, .orientation-gate")) {
			return;
		}

		// Mobile: don't steal the drive thumbs — only allow orbit with 2+ touches later if needed
		if (this.mobilePadsActive() && e.pointerType === "touch") {
			return;
		}

		this.dragging = true;
		this.activePointerId = e.pointerId;
		this.lastX = e.clientX;
		this.lastY = e.clientY;
		this.domElement.style.cursor = "grabbing";
		try {
			this.domElement.setPointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
	};

	private onPointerMove = (e: PointerEvent) => {
		if (!this.dragging || this.activePointerId !== e.pointerId) return;

		const dx = e.clientX - this.lastX;
		const dy = e.clientY - this.lastY;
		this.lastX = e.clientX;
		this.lastY = e.clientY;

		const sens = e.pointerType === "touch" ? 0.0022 : 0.004;
		this.yaw -= dx * sens;
		this.pitch += dy * sens * 0.75;
		this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch));
	};

	private onPointerUp = (e: PointerEvent) => {
		if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
		this.dragging = false;
		this.activePointerId = null;
		this.domElement.style.cursor = "grab";
		if (this.domElement.hasPointerCapture(e.pointerId)) {
			this.domElement.releasePointerCapture(e.pointerId);
		}
	};

	private onWheel = (e: WheelEvent) => {
		e.preventDefault();
		this.distance += e.deltaY * 0.01;
		this.distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, this.distance));
	};
}
