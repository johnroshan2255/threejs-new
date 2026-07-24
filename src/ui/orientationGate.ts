import { isMobileDevice } from "./mobileControls";

export type OrientationGate = {
	/** False on phones/tablets held in portrait. */
	isPlayAllowed: () => boolean;
	dispose: () => void;
};

function isPortrait(): boolean {
	// Prefer geometry — more reliable than CSS orientation on some Androids
	if (window.innerHeight > 0 && window.innerWidth > 0) {
		return window.innerHeight > window.innerWidth;
	}
	return window.matchMedia("(orientation: portrait)").matches;
}

/**
 * On mobile, require landscape before gameplay.
 */
export function createOrientationGate(): OrientationGate {
	const overlay = document.createElement("div");
	overlay.className = "orientation-gate";
	overlay.id = "orientation-gate";
	overlay.setAttribute("role", "dialog");
	overlay.setAttribute("aria-modal", "true");
	overlay.setAttribute("aria-live", "polite");
	overlay.innerHTML = `
		<div class="orientation-gate-card">
			<div class="orientation-gate-icon" aria-hidden="true">
				<svg viewBox="0 0 64 64" width="72" height="72" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
					<rect x="18" y="8" width="28" height="48" rx="4"></rect>
					<circle cx="32" cy="48" r="1.5" fill="currentColor" stroke="none"></circle>
					<path d="M46 28c6 2 10 8 10 14M46 28l4-5M46 28l5 3"></path>
				</svg>
			</div>
			<p class="orientation-gate-title">Rotate your phone</p>
			<p class="orientation-gate-text">Turn sideways (landscape) to drive on iPhone &amp; Android</p>
		</div>
	`;
	document.body.appendChild(overlay);

	const sync = () => {
		const lock = isMobileDevice() && isPortrait();
		overlay.classList.toggle("is-visible", lock);
		document.body.classList.toggle("orientation-portrait-lock", lock);
		overlay.setAttribute("aria-hidden", lock ? "false" : "true");
	};

	const delayedSync = () => {
		sync();
		// Android often reports old size during orientationchange
		window.setTimeout(sync, 100);
		window.setTimeout(sync, 350);
	};

	sync();
	window.addEventListener("resize", delayedSync);
	window.addEventListener("orientationchange", delayedSync);
	const mq = window.matchMedia("(orientation: portrait)");
	mq.addEventListener("change", delayedSync);

	return {
		isPlayAllowed: () => !(isMobileDevice() && isPortrait()),
		dispose() {
			window.removeEventListener("resize", delayedSync);
			window.removeEventListener("orientationchange", delayedSync);
			mq.removeEventListener("change", delayedSync);
			overlay.remove();
			document.body.classList.remove("orientation-portrait-lock");
		},
	};
}
