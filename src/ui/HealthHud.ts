import { PLAYER_MAX_HP } from "../entities/human/playerCombat";

/**
 * GTA V–style bottom health bar with live percentage.
 */
export class HealthHud {
	private root: HTMLElement;
	private fill: HTMLElement;
	private label: HTMLElement;
	private visible = false;

	constructor() {
		this.root = document.createElement("div");
		this.root.className = "health-hud";
		this.root.id = "health-hud";
		this.root.setAttribute("aria-hidden", "true");
		this.root.innerHTML = `
			<div class="health-hud-bar">
				<div class="health-hud-fill"></div>
			</div>
			<div class="health-hud-label">100%</div>
		`;
		document.body.appendChild(this.root);
		this.fill = this.root.querySelector(".health-hud-fill") as HTMLElement;
		this.label = this.root.querySelector(".health-hud-label") as HTMLElement;
		this.setHp(PLAYER_MAX_HP);
		this.setVisible(false);
	}

	public setVisible(show: boolean) {
		this.visible = show;
		this.root.classList.toggle("is-visible", show);
		this.root.setAttribute("aria-hidden", show ? "false" : "true");
	}

	public setHp(hp: number, maxHp: number = PLAYER_MAX_HP) {
		const clamped = Math.max(0, Math.min(maxHp, hp));
		const pct = maxHp > 0 ? (clamped / maxHp) * 100 : 0;
		this.fill.style.width = `${pct}%`;
		this.label.textContent = `${Math.round(pct)}%`;

		this.root.classList.toggle("is-low", pct > 0 && pct <= 25);
		this.root.classList.toggle("is-mid", pct > 25 && pct <= 50);
		this.root.classList.toggle("is-empty", pct <= 0);
	}

	public dispose() {
		this.root.remove();
	}
}
