/**
 * Tiny on-screen log for problems that only reproduce in-game.
 *
 * Mirrors to the console, but keeps the last few lines visible so a screenshot
 * carries the numbers — no devtools needed. Temporary by nature: delete the
 * debugLine() calls once an issue is understood.
 */

const MAX_LINES = 8;
const lines: string[] = [];
let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
	if (host?.isConnected) return host;
	const el = document.createElement("pre");
	el.id = "debug-overlay";
	el.style.position = "fixed";
	el.style.top = "72px";
	el.style.left = "12px";
	el.style.zIndex = "10000";
	el.style.margin = "0";
	el.style.padding = "8px 10px";
	el.style.maxWidth = "min(620px, 60vw)";
	el.style.background = "rgba(0, 0, 0, 0.66)";
	el.style.color = "#8fdceb";
	el.style.font = "11px/1.45 ui-monospace, Menlo, monospace";
	el.style.whiteSpace = "pre-wrap";
	el.style.borderRadius = "6px";
	el.style.pointerEvents = "none";
	document.body.appendChild(el);
	host = el;
	return el;
}

/** Log a line to the console and the on-screen overlay. */
export function debugLine(message: string) {
	console.warn(message);
}
