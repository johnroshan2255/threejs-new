import {
	WEAPON_SLOTS,
	type WeaponId,
	type WeaponSlot,
} from "../entities/human/WeaponInventory";

export type WeaponWheelCallbacks = {
	onSelect: (id: WeaponId) => void;
	getEquipped: () => WeaponId;
};

/**
 * GTA-style hold-to-open radial weapon wheel (fists + gun).
 * Open while Q is held; highlight follows mouse angle; release Q to equip.
 */
export class WeaponWheel {
	private root: HTMLElement;
	private ring: HTMLElement;
	private slots: { el: HTMLElement; slot: WeaponSlot; angle: number }[] = [];
	private open = false;
	private highlighted: WeaponId | null = null;
	private readonly cbs: WeaponWheelCallbacks;
	private readonly onMouseMove = (e: MouseEvent) => this.handleMouseMove(e);

	constructor(cbs: WeaponWheelCallbacks) {
		this.cbs = cbs;
		this.root = document.createElement("div");
		this.root.className = "weapon-wheel";
		this.root.id = "weapon-wheel";
		this.root.setAttribute("aria-hidden", "true");
		this.root.innerHTML = `
			<div class="ww-backdrop"></div>
			<div class="ww-ring">
				<div class="ww-center"><span class="ww-center-label"></span></div>
			</div>
		`;
		document.body.appendChild(this.root);
		this.ring = this.root.querySelector(".ww-ring") as HTMLElement;

		const n = WEAPON_SLOTS.length;
		WEAPON_SLOTS.forEach((slot, i) => {
			// Spread slots around the top half / full circle evenly
			const angle = -Math.PI / 2 + (i * (Math.PI * 2)) / n;
			const el = document.createElement("button");
			el.type = "button";
			el.className = "ww-slot";
			el.dataset.weapon = slot.id;
			el.innerHTML = `<span class="ww-icon">${slot.short}</span><span class="ww-label">${slot.label}</span>`;
			const radius = 110;
			el.style.setProperty("--ww-x", `${Math.cos(angle) * radius}px`);
			el.style.setProperty("--ww-y", `${Math.sin(angle) * radius}px`);
			this.ring.appendChild(el);
			this.slots.push({ el, slot, angle });

			el.addEventListener("pointerdown", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				this.highlight(slot.id);
			});
			el.addEventListener("click", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				this.highlight(slot.id);
				// Click commits immediately (still holding Q is fine)
				this.cbs.onSelect(slot.id);
				this.syncHighlightUi();
			});
		});
	}

	public isOpen(): boolean {
		return this.open;
	}

	public show() {
		if (this.open) return;
		this.open = true;
		this.highlighted = this.cbs.getEquipped();
		this.root.classList.add("is-open");
		this.root.setAttribute("aria-hidden", "false");
		this.syncHighlightUi();
		window.addEventListener("mousemove", this.onMouseMove);
	}

	public hide(commit: boolean) {
		if (!this.open) return;
		this.open = false;
		this.root.classList.remove("is-open");
		this.root.setAttribute("aria-hidden", "true");
		window.removeEventListener("mousemove", this.onMouseMove);

		if (commit && this.highlighted) {
			this.cbs.onSelect(this.highlighted);
		}
		this.highlighted = null;
	}

	public dispose() {
		window.removeEventListener("mousemove", this.onMouseMove);
		this.root.remove();
	}

	private handleMouseMove(e: MouseEvent) {
		if (!this.open) return;
		const rect = this.ring.getBoundingClientRect();
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const dx = e.clientX - cx;
		const dy = e.clientY - cy;
		const dist = Math.hypot(dx, dy);
		if (dist < 28) {
			// Dead zone — keep current equipped highlight
			this.highlighted = this.cbs.getEquipped();
			this.syncHighlightUi();
			return;
		}
		const mouseAngle = Math.atan2(dy, dx);
		let best: WeaponId = this.slots[0].slot.id;
		let bestDelta = Infinity;
		for (const s of this.slots) {
			let d = Math.abs(mouseAngle - s.angle);
			if (d > Math.PI) d = Math.PI * 2 - d;
			if (d < bestDelta) {
				bestDelta = d;
				best = s.slot.id;
			}
		}
		this.highlight(best);
	}

	private highlight(id: WeaponId) {
		if (this.highlighted === id) return;
		this.highlighted = id;
		this.syncHighlightUi();
	}

	private syncHighlightUi() {
		const label = this.root.querySelector(".ww-center-label") as HTMLElement | null;
		const equipped = this.cbs.getEquipped();
		for (const s of this.slots) {
			const on = s.slot.id === this.highlighted;
			s.el.classList.toggle("is-highlighted", on);
			s.el.classList.toggle("is-equipped", s.slot.id === equipped);
			if (on && label) label.textContent = s.slot.label;
		}
	}
}
