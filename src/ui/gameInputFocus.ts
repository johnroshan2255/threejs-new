/**
 * Keyboard / mouse arbitration between the game and the UI.
 *
 * The game binds WASD, U, E, R … on `window`, so a focused login form would
 * otherwise both drive the car and lose the typed characters (the game handlers
 * call preventDefault). Every game input handler asks here first.
 */

const TEXT_ENTRY_SELECTOR =
	'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** Panels that own the keyboard while open (login, logout, host, room list). */
const KEYBOARD_CAPTURE_SELECTOR = ".logout-modal, #room-list-panel";

/** Result cache — keydown repeats fire fast and layout reads are not free. */
const CAPTURE_CACHE_MS = 100;
let cachedCapture = false;
let cachedCaptureAt = -Infinity;
let captureNodes: HTMLElement[] | null = null;

/** True when the event targets a field the player is typing into. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el?.closest) return false;
	return Boolean(el.closest(TEXT_ENTRY_SELECTOR));
}

/** True when the focused element is a text field, whatever the event target is. */
export function isTextEntryFocused(): boolean {
	return isTextEntryTarget(document.activeElement);
}

function isRendered(el: HTMLElement): boolean {
	// Modals are position: fixed, so offsetParent is null even when visible.
	return el.getClientRects().length > 0;
}

/** True while a form / modal is on screen and should own the keyboard. */
export function isKeyboardCapturedByUi(): boolean {
	const now = performance.now();
	if (now - cachedCaptureAt < CAPTURE_CACHE_MS) return cachedCapture;
	cachedCaptureAt = now;

	if (!captureNodes?.length) {
		captureNodes = [
			...document.querySelectorAll<HTMLElement>(KEYBOARD_CAPTURE_SELECTOR),
		];
	}
	cachedCapture = captureNodes.some(isRendered);
	return cachedCapture;
}

/**
 * True when the game must ignore this key press: the player is typing, or a
 * form owns the keyboard. Call BEFORE preventDefault so typing still works.
 *
 * Key *releases* should not be gated on this — a key held when a form opens
 * must still clear, or it stays stuck down. Use this for keydown only.
 */
export function isGameKeyBlocked(event: KeyboardEvent): boolean {
	return (
		isTextEntryTarget(event.target) ||
		isTextEntryFocused() ||
		isKeyboardCapturedByUi()
	);
}

/** True when a click belongs to the UI (form, modal, nav) and not the world. */
export function isUiPointerTarget(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el?.closest) return false;
	return Boolean(
		el.closest(
			".logout-modal, #room-list-panel, #game-top-nav, .loading-screen, .mobile-controls, .settings-toggle, .dg, .orientation-gate"
		)
	);
}
