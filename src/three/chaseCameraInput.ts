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

	constructor(private domElement: HTMLElement) {
		domElement.addEventListener("pointerdown", this.onPointerDown);
		domElement.addEventListener("pointermove", this.onPointerMove);
		domElement.addEventListener("pointerup", this.onPointerUp);
		domElement.addEventListener("pointercancel", this.onPointerUp);
		domElement.addEventListener("wheel", this.onWheel, { passive: false });
		domElement.style.cursor = "grab";
	}

	private onPointerDown = (e: PointerEvent) => {
		if (e.button !== 0) return;
		this.dragging = true;
		this.lastX = e.clientX;
		this.lastY = e.clientY;
		this.domElement.style.cursor = "grabbing";
		this.domElement.setPointerCapture(e.pointerId);
	};

	private onPointerMove = (e: PointerEvent) => {
		if (!this.dragging) return;

		const dx = e.clientX - this.lastX;
		const dy = e.clientY - this.lastY;
		this.lastX = e.clientX;
		this.lastY = e.clientY;

		this.yaw -= dx * 0.004;
		this.pitch += dy * 0.003;
		this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch));
	};

	private onPointerUp = (e: PointerEvent) => {
		this.dragging = false;
		this.domElement.style.cursor = "grab";
		if (this.domElement.hasPointerCapture(e.pointerId)) {
			this.domElement.releasePointerCapture(e.pointerId);
		}
	};

	private onWheel = (e: WheelEvent) => {
		e.preventDefault();
		this.distance += e.deltaY * 0.01;
		this.distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, this.distance));
	}
}
