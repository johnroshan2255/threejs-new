/**
 * Procedural pixel-art bugs for the multiplayer lobby.
 *
 * Replaces the four `poutine.glb` clones the lobby used to park in front of the
 * camera — 5 MB each, skinned, with an idle mixer running per slot, all to fill
 * four avatar boxes.
 *
 * Sprites are drawn, not picked from a set: a seeded RNG decides body shape,
 * palette, eyes, legs and antennae, so a lobby of four reads as four different
 * creatures. The seed comes from the player's name, so the same player keeps the
 * same bug across sessions and everyone in the room sees them as that bug.
 *
 * Deliberately not emoji — these are real sprites at a real pixel grid, so they
 * scale crisply with `image-rendering: pixelated` and never depend on whatever
 * a platform's font decides 🐛 should look like.
 */

/** Sprite resolution. Kept small so the pixels stay legibly chunky. */
const GRID = 16;

/**
 * xorshift32 — small, fast, and stable across platforms.
 *
 * `Math.random()` would give a player a different bug on every reconnect, which
 * defeats the point of using it to recognise them.
 */
function makeRng(seed: number) {
	let s = seed >>> 0 || 0x9e3779b9;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 0x100000000;
	};
}

function hashString(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Hues that read as "bug" rather than "mud" — greens, ambers, teals, magentas. */
const HUES = [92, 140, 168, 196, 44, 24, 310, 268];

type Palette = {
	shell: string;
	shellDark: string;
	limb: string;
	eye: string;
	glint: string;
};

function buildPalette(rng: () => number): Palette {
	const hue = HUES[Math.floor(rng() * HUES.length)]!;
	const sat = 55 + Math.floor(rng() * 30);
	const light = 52 + Math.floor(rng() * 14);
	return {
		shell: `hsl(${hue} ${sat}% ${light}%)`,
		shellDark: `hsl(${hue} ${sat}% ${Math.max(14, light - 26)}%)`,
		limb: `hsl(${hue} ${Math.max(12, sat - 28)}% ${Math.max(20, light - 32)}%)`,
		eye: "#0a0d0a",
		glint: "#f2f7ef",
	};
}

/**
 * Paints one bug into a canvas at `GRID`x`GRID` logical pixels.
 *
 * The sprite is built on the left half and mirrored, which is what makes a pile
 * of random pixels read as a creature instead of noise.
 */
export function drawPixelBug(canvas: HTMLCanvasElement, seedText: string, scale = 6): void {
	const rng = makeRng(hashString(seedText));
	const palette = buildPalette(rng);

	canvas.width = GRID * scale;
	canvas.height = GRID * scale;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.imageSmoothingEnabled = false;
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	const half = GRID / 2;
	const px = (x: number, y: number, color: string) => {
		ctx.fillStyle = color;
		ctx.fillRect(x * scale, y * scale, scale, scale);
		// Mirror across the vertical axis.
		ctx.fillRect((GRID - 1 - x) * scale, y * scale, scale, scale);
	};

	// Body silhouette: a rounded blob whose width per row comes from the RNG,
	// clamped so it always tapers at head and tail.
	const top = 3;
	const bottom = GRID - 3;
	const widths: number[] = [];
	for (let y = top; y < bottom; y++) {
		const t = (y - top) / (bottom - top - 1);
		// Fat in the middle, narrow at both ends.
		const base = Math.sin(Math.PI * t) * (half - 2) + 1.4;
		widths.push(Math.max(1, Math.min(half - 1, Math.round(base + (rng() - 0.5)))));
	}

	// Legs first, so the shell overlaps them.
	const legRows = [top + 2, Math.floor((top + bottom) / 2), bottom - 3];
	for (const y of legRows) {
		const reach = widths[y - top]! + 1 + Math.floor(rng() * 2);
		for (let x = widths[y - top]!; x <= Math.min(half - 1, reach); x++) {
			px(half + x - 1, y, palette.limb);
		}
	}

	// Antennae.
	const antennaLen = 1 + Math.floor(rng() * 2);
	for (let i = 0; i < antennaLen; i++) {
		px(half - 2 - i, top - 1 - i, palette.limb);
	}

	// Shell.
	for (let y = top; y < bottom; y++) {
		const w = widths[y - top]!;
		for (let x = 0; x < w; x++) {
			// Outer column is the darker rim, which gives the sprite an edge.
			px(half + x - 1, y, x === w - 1 ? palette.shellDark : palette.shell);
		}
	}

	// Back markings — a stripe or a pair of spots, never both.
	if (rng() > 0.5) {
		const stripeY = top + 3 + Math.floor(rng() * Math.max(1, bottom - top - 6));
		for (let x = 0; x < Math.max(1, widths[stripeY - top]! - 1); x++) {
			px(half + x - 1, stripeY, palette.shellDark);
		}
	} else {
		const spotY = top + 3 + Math.floor(rng() * Math.max(1, bottom - top - 7));
		px(half, spotY, palette.shellDark);
		px(half, spotY + 2, palette.shellDark);
	}

	// Eyes, always on the head rows so the bug has a clear "up".
	const eyeY = top + 1;
	px(half - 1, eyeY, palette.eye);
	px(half - 1, eyeY - 0, palette.eye);
	ctx.fillStyle = palette.glint;
	ctx.fillRect((half - 1) * scale, (eyeY - 1) * scale, scale, scale);
	ctx.fillRect((GRID - half) * scale, (eyeY - 1) * scale, scale, scale);
}

/**
 * Builds a lobby avatar: the sprite plus the player's name underneath.
 *
 * Replaces the slot's contents wholesale, so it is safe to call on every
 * `room-updated` broadcast.
 */
export function renderLobbyAvatar(slot: Element, playerName: string): void {
	slot.textContent = "";

	const canvas = document.createElement("canvas");
	canvas.className = "bug-avatar";
	canvas.setAttribute("role", "img");
	canvas.setAttribute("aria-label", `${playerName}'s bug`);
	drawPixelBug(canvas, playerName);

	const name = document.createElement("span");
	name.className = "bug-name";
	name.textContent = playerName;

	slot.appendChild(canvas);
	slot.appendChild(name);
}
