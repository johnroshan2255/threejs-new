export type QualityLevel = "Low" | "Medium" | "High";
export type GameWorldId = string;
export type VehicleId = "none" | "hummer" | "jeep";

/**
 * Edge-antialiasing technique.
 *
 * There is no 2x or 8x here because WebGPU cannot express them: the spec only
 * requires sample counts 1 and 4, and three's `WebGPUUtils.getSampleCount` is
 * literally `sampleCount >= 4 ? 4 : 1`. Asking for 2 builds pipelines at one
 * sample while the canvas still attaches a resolve target, and every frame dies
 * as "cannot set as a resolve target" with nothing drawn. Sample density beyond
 * 4x is reached with `supersample` instead, which is a real ladder.
 */
export type AaMode = "off" | "fxaa" | "msaa" | "msaa+fxaa";

/**
 * Supersample factor as a multiple of *pixel count*, not of an axis.
 *
 * 2x means twice the pixels (1.41x per axis), 4x means four times (2x per axis).
 */
export type SupersampleLevel = 1 | 2 | 4;

export const AA_MODES: AaMode[] = ["off", "fxaa", "msaa", "msaa+fxaa"];

/**
 * Shipping default.
 *
 * MSAA keeps grass in the opaque, depth-sorted queue (alpha-to-coverage needs real
 * samples), and FXAA does the edge work the 1.25x supersample floor used to do —
 * cheaper, and measurably steadier. Because this mode includes FXAA, the floor is
 * released and the renderer draws 1:1 with the display: measured 167 -> 211 fps in
 * fullscreen at 1080p, with isolated flicker 0.09 -> 0.07 per 1000 px.
 */
export const DEFAULT_AA_MODE: AaMode = "msaa+fxaa";
export const AA_MODE_LABELS = ["Off", "FXAA", "MSAA 4x", "MSAA+FXAA"];
export const SUPERSAMPLE_LEVELS: SupersampleLevel[] = [1, 2, 4];
export const SUPERSAMPLE_LABELS = ["1x", "2x", "4x"];

/** Per-axis pixel ratio that yields the requested pixel-count multiple. */
export function supersampleAxisScale(level: SupersampleLevel): number {
	return Math.sqrt(level);
}

/** True when the mode wants the renderer built with MSAA. Fixed per session. */
export function aaModeUsesMsaa(mode: AaMode): boolean {
	return mode === "msaa" || mode === "msaa+fxaa";
}

/** True when the mode wants the FXAA node in the composite. Fixed per session. */
export function aaModeUsesFxaa(mode: AaMode): boolean {
	return mode === "fxaa" || mode === "msaa+fxaa";
}

type DayPeriod = "morning" | "noon" | "evening" | /* "sunset" | */ "night";

/** Describes a single tunable car parameter shown in the UI. */
export type CarTuningDef = {
	key: string;       // dot-path into the config, e.g. "suspension.restLength"
	label: string;     // human-readable label
	min: number;
	max: number;
	step: number;
	defaultValue: number;
	currentValue: number;
};

type GameSettingsOptions = {
	shadowQuality: QualityLevel;
	resolutionQuality: QualityLevel;
	/** Multiplier on the resolution tier's pixel ratio, 0.5–2. */
	renderScale: number;
	/** Edge AA technique. Takes effect on the next load — see `AaMode`. */
	aaMode: AaMode;
	/** Supersample pixel-count multiple. Applies immediately. */
	supersample: SupersampleLevel;
	/** Room capacity the host asks for. Used at create-room time. */
	roomMaxPlayers: number;
	/** AI bots to spawn on match start. */
	botCount: number;
	waterQuality: QualityLevel;
	postFx: boolean;
	showStats: boolean;
	period: DayPeriod;
	autoDayNight: boolean;
	hour: number;
	grassDensity: number;
	grassCullDistance: number;
	carPower: number;
	vehicle: VehicleId;
	world: GameWorldId;
	worldOptions?: Record<string, string>;
	onShadowQualityChange: (quality: QualityLevel) => void;
	onResolutionQualityChange: (quality: QualityLevel) => void;
	onRenderScaleChange: (scale: number) => void;
	/** Persisted now, honoured on the next load. */
	onAaModeChange: (mode: AaMode) => void;
	onSupersampleChange: (level: SupersampleLevel) => void;
	onRoomMaxPlayersChange: (count: number) => void;
	onBotCountChange: (count: number) => void;
	onWaterQualityChange: (quality: QualityLevel) => void;
	onPostFxChange: (enabled: boolean) => void;
	onShowStatsChange: (enabled: boolean) => void;
	onPeriodChange: (period: DayPeriod) => void;
	onAutoDayNightChange: (enabled: boolean) => void;
	onHourChange: (hour: number) => void;
	onGrassDensityChange: (percent: number) => void;
	onGrassCullDistanceChange: (meters: number) => void;
	onCarPowerChange: (power: number) => void;
	onVehicleChange: (vehicle: VehicleId) => void;
	onGodRayIntensityChange: (intensity: number) => void;
	onSunGlowMultiplierChange: (multiplier: number) => void;
	onWorldChange: (world: GameWorldId) => Promise<void>;
	/** Called when the user adjusts a per-vehicle tuning slider. */
	onCarTuningChange?: (vehicleId: VehicleId, key: string, value: number) => void;
	/** Called when the user clicks "Revert to Defaults" for the current vehicle. */
	onCarTuningRevert?: (vehicleId: VehicleId) => void;
	/** Called when the user clicks "Save & Apply" for the current vehicle. */
	onCarTuningSave?: (vehicleId: VehicleId) => void;
	/** Returns the tuning definitions for a given vehicle (current + default values). */
	getCarTuningDefs?: (vehicleId: VehicleId) => CarTuningDef[];
};

/** Ordinal tiers, in gauge order. Index + 1 is the notch value. */
const QUALITY_TIERS: QualityLevel[] = ["Low", "Medium", "High"];
const PERIODS: DayPeriod[] = ["morning", "noon", "evening", "night"];
const PERIOD_LABELS = ["Morning", "Noon", "Evening", "Night"];
const VEHICLES: VehicleId[] = ["jeep", "hummer"];
const VEHICLE_LABELS = ["Patrol", "Hummer"];

/**
 * Graphics presets. Each entry is a notch value (1-based) for the three ordinal
 * tiers, plus a render scale percentage.
 */
const PRESETS: Record<string, { tier: number; renderScale: number }> = {
	Low: { tier: 1, renderScale: 75 },
	Medium: { tier: 2, renderScale: 100 },
	High: { tier: 3, renderScale: 100 },
};

export class GameSettings {
	private readonly state;
	private overlay: HTMLElement;
	private worldSelect!: HTMLSelectElement;
	/** Suppresses "custom preset" marking while a preset is being applied. */
	private applyingPreset = false;
	/**
	 * The AA mode this session was actually built with, as opposed to the one
	 * currently selected. They differ once the user picks a new mode, which is
	 * what the restart note is keyed on.
	 */
	private readonly sessionAaMode: AaMode;

	constructor(private readonly options: GameSettingsOptions) {
		this.sessionAaMode = options.aaMode;
		this.state = {
			shadowQuality: options.shadowQuality,
			resolutionQuality: options.resolutionQuality,
			renderScale: options.renderScale,
			aaMode: options.aaMode,
			supersample: options.supersample,
			roomMaxPlayers: options.roomMaxPlayers,
			botCount: options.botCount,
			waterQuality: options.waterQuality,
			postFx: options.postFx,
			showStats: options.showStats,
			period: options.period,
			autoDayNight: options.autoDayNight,
			hour: options.hour,
			grassDensity: options.grassDensity,
			grassCullDistance: options.grassCullDistance,
			carPower: options.carPower,
			godRayIntensity: 0.1,
			sunGlowMultiplier: 0.1,
			vehicle: options.vehicle,
			world: options.world,
		};

		this.overlay = this.buildDOM();
		document.body.appendChild(this.overlay);

		this.populateTuningSliders(this.state.vehicle);
		this.bindToggle();
	}

	show(): void {
		this.overlay.style.display = "grid";
		this.overlay.classList.remove("hidden");
		this.syncToggle();
	}

	hide(): void {
		this.overlay.style.display = "none";
		this.overlay.classList.add("hidden");
		// Return focus to the document so form elements inside the settings panel
		// don't keep blocking game keyboard inputs (Q, WASD…)
		const focused = this.overlay.querySelector<HTMLElement>(":focus");
		focused?.blur();
		this.syncToggle();
	}

	/**
	 * Dense layout for in-game, roomy layout for the menu.
	 *
	 * Same markup either way — the compact rules drop the hint text, shrink the
	 * controls and thin the backdrop so the scene stays readable behind it.
	 */
	setCompact(compact: boolean): void {
		this.overlay.classList.toggle("is-compact", compact);
	}

	/** Jump to a pane by id, e.g. "multiplayer". */
	openPane(pane: string): void {
		const tab = this.overlay.querySelector<HTMLElement>(`.nav-item[data-tab="${pane}"]`);
		tab?.click();
		this.show();
	}

	private syncToggle(): void {
		const toggle = document.getElementById("settings-toggle");
		if (toggle) {
			const open = this.overlay.style.display !== "none";
			toggle.classList.toggle("is-open", open);
			toggle.setAttribute("aria-label", open ? "Close settings" : "Open settings");
		}
	}

	setHour(hour: number): void {
		this.state.hour = hour;
		const el = this.overlay.querySelector<HTMLElement>('[data-slider][data-key="hour"]');
		if (!el) return;
		const input = el.querySelector("input") as HTMLInputElement;
		input.value = hour.toString();
		this.paintSlider(el);
	}

	setPeriod(period: DayPeriod): void {
		this.state.period = period;
		const index = PERIODS.indexOf(period);
		if (index < 0) return;
		this.selectChip('[data-chips][data-key="period"]', index);
	}

	setAutoDayNight(enabled: boolean): void {
		this.state.autoDayNight = enabled;
		const sw = this.overlay.querySelector<HTMLElement>('[data-switch][data-key="autoDayNight"]');
		if (!sw) return;
		sw.setAttribute("aria-checked", String(enabled));
		this.setReadout(sw, enabled ? "On" : "Off");
	}

	setWorld(world: GameWorldId): void {
		this.state.world = world;
		if (this.worldSelect) this.worldSelect.value = world;
	}

	setWorldOptions(options: Record<string, string>): void {
		if (!this.worldSelect) return;
		this.worldSelect.innerHTML = "";
		for (const [label, val] of Object.entries(options)) {
			const opt = document.createElement("option");
			opt.value = val;
			opt.textContent = label;
			this.worldSelect.appendChild(opt);
		}
		this.worldSelect.value = this.state.world;
	}

	private bindToggle(): void {
		// Every entry point into the panel: the in-game gear, the menu gear, and
		// the menu's own Settings row.
		const openers = ["settings-toggle", "menu-settings-btn", "menu-settings-item"];
		for (const id of openers) {
			document.getElementById(id)?.addEventListener("click", () => {
				if (this.overlay.style.display === "none") this.show();
				else this.hide();
			});
		}

		// The menu's Multiplayer row lands straight on the relevant pane.
		document.getElementById("menu-multiplayer-btn")?.addEventListener("click", () => {
			this.openPane("multiplayer");
		});

		this.overlay.querySelectorAll(".custom-settings-close").forEach((btn) =>
			btn.addEventListener("click", () => this.hide())
		);

		// Close on backdrop click.
		this.overlay.addEventListener("click", (e) => {
			if (e.target === this.overlay) this.hide();
		});
	}

	public attachSystemButtons() {
		const container = document.getElementById("system-actions-container");
		if (!container) return;

		const topNav = document.getElementById("game-top-nav");
		const editBtn = document.getElementById("edit-mode-toggle");

		if (topNav) {
			topNav.style.position = "static";
			topNav.style.flexDirection = "column";
			topNav.style.alignItems = "stretch";
			topNav.style.width = "100%";
			topNav.style.display = topNav.style.display === "none" ? "none" : "flex";
			container.appendChild(topNav);
		}
		if (editBtn) {
			editBtn.style.position = "static";
			editBtn.style.width = "100%";
			editBtn.style.marginBottom = "0";
			container.appendChild(editBtn);
		}
	}

	/* ── control helpers ──────────────────────────────────── */

	private readoutOf(el: Element): HTMLElement | null {
		return el.closest(".row")?.querySelector(".readout") ?? null;
	}

	private setReadout(el: Element, text: string): void {
		const r = this.readoutOf(el);
		if (!r) return;
		r.textContent = text;
		r.classList.toggle("is-off", /^(off|none|0%)$/i.test(text));
	}

	/** Row markup shared by every control type. */
	private row(label: string, hint: string, control: string, readout: string): string {
		return `
			<div class="row">
				<div><div class="label">${label}</div><div class="hint">${hint}</div></div>
				<div class="control">${control}</div>
				<div class="readout">${readout}</div>
			</div>`;
	}

	private notch(key: string, labels: string[], value: number): string {
		const buttons = labels.map(() => "<button type=\"button\"></button>").join("");
		return `<div class="notch" data-notch data-key="${key}" data-labels="${labels.join(",")}" data-value="${value}">${buttons}</div>`;
	}

	private chips(key: string, labels: string[], activeIndex: number): string {
		const buttons = labels
			.map((l, i) => `<button type="button" class="${i === activeIndex ? "on" : ""}">${l}</button>`)
			.join("");
		return `<div class="chips" data-chips data-key="${key}">${buttons}</div>`;
	}

	private slider(
		key: string,
		min: number,
		max: number,
		step: number,
		value: number,
		unit = "",
		format = ""
	): string {
		return `<div class="ui-slider" data-slider data-key="${key}" data-unit="${unit}" data-format="${format}">
			<input type="range" min="${min}" max="${max}" step="${step}" value="${value}" />
			<div class="ticks"><i></i><i></i><i></i><i></i><i></i></div>
		</div>`;
	}

	private toggle(key: string, checked: boolean): string {
		return `<button class="switch" type="button" data-switch data-key="${key}" role="switch" aria-checked="${checked}"><b></b></button>`;
	}

	private formatSlider(el: HTMLElement): string {
		const input = el.querySelector("input") as HTMLInputElement;
		const raw = parseFloat(input.value);
		if (el.dataset.format === "hour") {
			const h = Math.floor(raw);
			const m = Math.round((raw - h) * 60);
			return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
		}
		if (el.dataset.format === "decimal") return raw.toFixed(1) + (el.dataset.unit ?? "");
		return raw + (el.dataset.unit ?? "");
	}

	private paintSlider(el: HTMLElement): void {
		this.setReadout(el, this.formatSlider(el));
	}

	private paintNotch(g: HTMLElement): void {
		const v = Number(g.dataset.value);
		g.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i < v));
		this.setReadout(g, (g.dataset.labels ?? "").split(",")[v - 1] ?? "");
	}

	private selectChip(selector: string, index: number): void {
		const group = this.overlay.querySelector<HTMLElement>(selector);
		if (!group) return;
		const buttons = [...group.querySelectorAll("button")];
		buttons.forEach((b, i) => b.classList.toggle("on", i === index));
		this.setReadout(group, buttons[index]?.textContent ?? "");
	}

	/** Any manual change means the preset chips no longer describe the state. */
	private markCustomPreset(): void {
		if (this.applyingPreset) return;
		this.overlay
			.querySelectorAll('[data-chips][data-key="preset"] button')
			.forEach((b) => b.classList.remove("on"));
	}

	private applyPreset(name: string): void {
		const preset = PRESETS[name];
		if (!preset) return;
		this.applyingPreset = true;

		for (const key of ["shadowQuality", "resolutionQuality", "waterQuality"]) {
			const g = this.overlay.querySelector<HTMLElement>(`[data-notch][data-key="${key}"]`);
			if (!g) continue;
			g.dataset.value = String(preset.tier);
			this.paintNotch(g);
			this.dispatchNotch(key, preset.tier);
		}

		const rs = this.overlay.querySelector<HTMLElement>('[data-slider][data-key="renderScale"]');
		if (rs) {
			const input = rs.querySelector("input") as HTMLInputElement;
			input.value = String(preset.renderScale);
			this.paintSlider(rs);
			this.state.renderScale = preset.renderScale / 100;
			this.options.onRenderScaleChange(preset.renderScale / 100);
			this.updateScaleCaution(preset.renderScale);
		}

		this.applyingPreset = false;
	}

	/**
	 * `root` is explicit because this also runs from `bindControls`, which is
	 * called *inside* `buildDOM()` — before `this.overlay` has been assigned.
	 */
	private updateScaleCaution(percent: number, root?: HTMLElement): void {
		(root ?? this.overlay)
			?.querySelector("#scale-caution")
			?.classList.toggle("is-on", percent > 100);
	}

	private dispatchNotch(key: string, value: number): void {
		const tier = QUALITY_TIERS[value - 1];
		if (!tier) return;
		if (key === "shadowQuality") {
			this.state.shadowQuality = tier;
			this.options.onShadowQualityChange(tier);
		} else if (key === "resolutionQuality") {
			this.state.resolutionQuality = tier;
			this.options.onResolutionQualityChange(tier);
		} else if (key === "waterQuality") {
			this.state.waterQuality = tier;
			this.options.onWaterQualityChange(tier);
		}
	}

	/* ── DOM ──────────────────────────────────────────────── */

	private buildDOM(): HTMLElement {
		const overlay = document.createElement("div");
		overlay.id = "custom-settings-overlay";
		overlay.className = "custom-settings-overlay hidden";
		overlay.style.display = "none";

		const tierIndex = (q: QualityLevel) => QUALITY_TIERS.indexOf(q) + 1;
		const s = this.state;

		overlay.innerHTML = `
		<div class="panel">
			<div class="panel-head">
				<h2>Settings</h2>
				<div class="spacer"></div>
				<div class="preset">
					<span>Preset</span>
					${this.chips("preset", ["Low", "Medium", "High"], -1)}
				</div>
				<button class="shell-icon-btn custom-settings-close" type="button" aria-label="Close settings">
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
				</button>
			</div>

			<div class="panel-body">
				<aside class="sidenav" role="tablist">
					<button class="nav-item is-active" type="button" data-tab="graphics" role="tab">Graphics</button>
					<button class="nav-item" type="button" data-tab="daynight" role="tab">Day / Night</button>
					<button class="nav-item" type="button" data-tab="grass" role="tab">Grass</button>
					<button class="nav-item" type="button" data-tab="atmosphere" role="tab">Atmosphere</button>
					<button class="nav-item" type="button" data-tab="car" role="tab">Car</button>
					<button class="nav-item" type="button" data-tab="world" role="tab">World</button>
					<button class="nav-item" type="button" data-tab="multiplayer" role="tab">Multiplayer</button>
				</aside>

				<div class="panes">
					<section class="pane is-active" data-pane="graphics" role="tabpanel">
						<div class="pane-head">
							<h3>Graphics</h3>
							<p>Higher settings cost frames. Render scale moves the whole frame — almost everything here is fill-rate bound.</p>
						</div>
						${this.row("Shadow quality", "Map resolution and update rate", this.notch("shadowQuality", QUALITY_TIERS, tierIndex(s.shadowQuality)), s.shadowQuality)}
						${this.row("Resolution", "Base render resolution tier", this.notch("resolutionQuality", QUALITY_TIERS, tierIndex(s.resolutionQuality)), s.resolutionQuality)}
						${this.row("Render scale", "Multiplies the resolution tier. Frame cost scales with pixel count.", this.slider("renderScale", 50, 200, 5, Math.round(s.renderScale * 100), "%"), Math.round(s.renderScale * 100) + "%")}
						${this.row("Antialiasing", "Edge smoothing. MSAA is 4x — WebGPU has no 2x or 8x. MSAA also keeps grass depth-sorted.", this.chips("aaMode", AA_MODE_LABELS, AA_MODES.indexOf(s.aaMode)), AA_MODE_LABELS[AA_MODES.indexOf(s.aaMode)] ?? "Off")}
						${this.row("Supersampling", "Renders above native and downsamples. 4x = four times the pixels.", this.chips("supersample", SUPERSAMPLE_LABELS, SUPERSAMPLE_LEVELS.indexOf(s.supersample)), SUPERSAMPLE_LABELS[SUPERSAMPLE_LEVELS.indexOf(s.supersample)] ?? "1x")}
						${this.row("Water physics", "Wave simulation and buoyancy", this.notch("waterQuality", QUALITY_TIERS, tierIndex(s.waterQuality)), s.waterQuality)}
						${this.row("Atmospheric FX", "God rays, bloom and the colour grade", this.toggle("postFx", s.postFx), s.postFx ? "On" : "Off")}
						${this.row("Frame counter", "Shows FPS and draw calls", this.toggle("showStats", s.showStats), s.showStats ? "On" : "Off")}
						<p class="caution" id="aa-restart-note">Antialiasing changes apply the next time the game loads.</p>
						<p class="caution" id="aa-grass-note">Without MSAA the grass loses alpha-to-coverage and returns to the blended queue, so blades shimmer as they sway. FXAA smooths still edges but cannot fix that.</p>
						<p class="caution" id="scale-caution">Render scale above 100% will cost frames on most machines.</p>
					</section>

					<section class="pane" data-pane="daynight" role="tabpanel">
						<div class="pane-head">
							<h3>Day / night</h3>
							<p>Pick a fixed time of day, or let the clock run while you drive.</p>
						</div>
						${this.row("Time of day", "Sun position, sky and fog", this.slider("hour", 0, 24, 0.1, s.hour, "", "hour"), "")}
						${this.row("Period", "Jump to a preset time — transitions are eased", this.chips("period", PERIOD_LABELS, PERIODS.indexOf(s.period)), PERIOD_LABELS[PERIODS.indexOf(s.period)] ?? "")}
						${this.row("Auto cycle", "Time advances as you play", this.toggle("autoDayNight", s.autoDayNight), s.autoDayNight ? "On" : "Off")}
					</section>

					<section class="pane" data-pane="grass" role="tabpanel">
						<div class="pane-head">
							<h3>Grass</h3>
							<p>Grass is the single most expensive thing on screen. Density is the first dial to turn down.</p>
						</div>
						${this.row("Density", "Share of blades actually drawn", this.slider("grassDensity", 0, 100, 1, s.grassDensity, "%"), s.grassDensity + "%")}
						${this.row("Draw distance", "Where grass stops rendering", this.slider("grassCull", 30, 250, 1, s.grassCullDistance, " m"), s.grassCullDistance + " m")}
					</section>

					<section class="pane" data-pane="atmosphere" role="tabpanel">
						<div class="pane-head">
							<h3>Atmosphere</h3>
							<p>Needs Atmospheric FX switched on under Graphics.</p>
						</div>
						${this.row("God rays", "Light shafts through the fog", this.slider("godRays", 0, 3, 0.1, s.godRayIntensity, "", "decimal"), s.godRayIntensity.toFixed(1))}
						${this.row("Sun glow", "Bloom around the sun disc", this.slider("sunGlow", 0, 3, 0.1, s.sunGlowMultiplier, "", "decimal"), s.sunGlowMultiplier.toFixed(1))}
					</section>

					<section class="pane" data-pane="car" role="tabpanel">
						<div class="pane-head">
							<h3>Car</h3>
							<p>Pick a vehicle, then tune it. Changes apply live; save to keep them.</p>
						</div>
						${this.row("Vehicle", "Switching reloads the model", this.chips("vehicle", VEHICLE_LABELS, VEHICLES.indexOf(s.vehicle)), VEHICLE_LABELS[VEHICLES.indexOf(s.vehicle)] ?? "—")}
						<div id="car-tuning-sliders"></div>
						<div class="lobby-buttons" style="margin-top:16px">
							<button id="btn-revert-car" class="ghost-btn is-danger" type="button">Revert</button>
							<button id="btn-save-car" class="solid-btn" type="button">Save &amp; apply</button>
						</div>
					</section>

					<section class="pane" data-pane="world" role="tabpanel">
						<div class="pane-head">
							<h3>World</h3>
							<p>Switching worlds reloads terrain, grass and everything placed in the editor.</p>
						</div>
						<div class="row">
							<div><div class="label">Current world</div><div class="hint">Built-in maps and your saved custom worlds</div></div>
							<div class="control"><select id="set-world" class="shell-select"></select></div>
							<div class="readout"></div>
						</div>
					</section>

					<section class="pane" data-pane="multiplayer" role="tabpanel">
						<div class="pane-head">
							<h3>Multiplayer</h3>
							<p>Host a room for others to join, or join an existing one. An account is required.</p>
						</div>
						${this.row("Room size", "Players allowed in a room you host. Applies to the next room you create.", this.slider("roomMaxPlayers", 2, 100, 1, s.roomMaxPlayers), String(s.roomMaxPlayers))}
						${this.row("Bots", "AI players that spawn into the world you are in. Takes effect immediately.", this.slider("botCount", 0, 100, 1, s.botCount), String(s.botCount))}
						<p class="caution is-on" id="bot-note">Bots shoot but do not deal damage yet \u2014 each client simulates its own copy, so damage needs the host-authoritative pass.</p>
						<div class="stack" id="system-actions-container"></div>
					</section>
				</div>
			</div>

			<div class="panel-foot">
				<div class="spacer"></div>
				<span class="kbd">Esc to close</span>
				<button class="solid-btn only-full custom-settings-close" type="button">Done</button>
				<button class="solid-btn only-compact custom-settings-close" type="button">Resume</button>
			</div>
		</div>`;

		this.bindControls(overlay);
		return overlay;
	}

	private bindControls(overlay: HTMLElement): void {
		// Tabs
		const tabs = [...overlay.querySelectorAll<HTMLElement>(".nav-item")];
		const panes = [...overlay.querySelectorAll<HTMLElement>(".pane")];
		tabs.forEach((tab) =>
			tab.addEventListener("click", () => {
				tabs.forEach((t) => t.classList.toggle("is-active", t === tab));
				panes.forEach((p) =>
					p.classList.toggle("is-active", p.dataset.pane === tab.dataset.tab)
				);
			})
		);

		// Notch gauges
		overlay.querySelectorAll<HTMLElement>("[data-notch]").forEach((g) => {
			this.paintNotch(g);
			g.querySelectorAll("button").forEach((b, i) =>
				b.addEventListener("click", () => {
					g.dataset.value = String(i + 1);
					this.paintNotch(g);
					this.dispatchNotch(g.dataset.key ?? "", i + 1);
					this.markCustomPreset();
				})
			);
		});

		// Chip groups
		overlay.querySelectorAll<HTMLElement>("[data-chips]").forEach((group) => {
			const buttons = [...group.querySelectorAll("button")];
			buttons.forEach((b, i) =>
				b.addEventListener("click", () => {
					buttons.forEach((x) => x.classList.toggle("on", x === b));
					this.setReadout(group, b.textContent ?? "");
					this.dispatchChip(group.dataset.key ?? "", i, b.textContent ?? "");
				})
			);
		});

		// Sliders
		overlay.querySelectorAll<HTMLElement>("[data-slider]").forEach((el) => {
			const input = el.querySelector("input") as HTMLInputElement;
			this.paintSlider(el);
			input.addEventListener("input", () => {
				this.paintSlider(el);
				this.dispatchSlider(el.dataset.key ?? "", parseFloat(input.value));
				this.markCustomPreset();
			});
		});

		// Switches
		overlay.querySelectorAll<HTMLElement>("[data-switch]").forEach((sw) => {
			sw.addEventListener("click", () => {
				const next = sw.getAttribute("aria-checked") !== "true";
				sw.setAttribute("aria-checked", String(next));
				this.setReadout(sw, next ? "On" : "Off");
				this.dispatchSwitch(sw.dataset.key ?? "", next);
			});
		});

		// Car tuning actions
		overlay.querySelector("#btn-save-car")?.addEventListener("click", () => {
			this.options.onCarTuningSave?.(this.state.vehicle);
		});
		overlay.querySelector("#btn-revert-car")?.addEventListener("click", () => {
			this.options.onCarTuningRevert?.(this.state.vehicle);
			this.populateTuningSliders(this.state.vehicle);
		});

		// World select
		this.worldSelect = overlay.querySelector("#set-world") as HTMLSelectElement;
		this.setWorldOptions(this.options.worldOptions ?? { Island: "island", Valley: "valley" });
		this.worldSelect.addEventListener("change", async (e) => {
			const next = (e.target as HTMLSelectElement).value;
			const previous = this.state.world;
			this.hide();
			try {
				await this.options.onWorldChange(next);
			} catch {
				this.state.world = previous;
				this.worldSelect.value = previous;
			}
		});

		this.updateScaleCaution(Math.round(this.state.renderScale * 100), overlay);
		// Runs before `this.overlay` is assigned, hence the explicit root — same
		// reason as updateScaleCaution above.
		this.updateAaRestartHint(overlay);
	}

	private dispatchChip(key: string, index: number, label: string): void {
		if (key === "preset") {
			this.applyPreset(label);
			return;
		}
		if (key === "period") {
			const period = PERIODS[index];
			if (period) {
				this.state.period = period;
				this.options.onPeriodChange(period);
			}
			return;
		}
		if (key === "aaMode") {
			const mode = AA_MODES[index];
			if (mode) {
				this.state.aaMode = mode;
				this.options.onAaModeChange(mode);
				this.updateAaRestartHint();
			}
			return;
		}
		if (key === "supersample") {
			const level = SUPERSAMPLE_LEVELS[index];
			if (level) {
				this.state.supersample = level;
				this.options.onSupersampleChange(level);
			}
			return;
		}
		if (key === "vehicle") {
			const vehicle = VEHICLES[index];
			if (vehicle) {
				this.state.vehicle = vehicle;
				this.options.onVehicleChange(vehicle);
				// The model loads asynchronously; its tuning defs only exist after.
				setTimeout(() => this.populateTuningSliders(vehicle), 200);
			}
		}
	}

	/**
	 * Show or hide the "takes effect after restart" note for the AA row.
	 *
	 * Both halves of the mode are baked in at startup: MSAA is fixed when the
	 * renderer is constructed (assigning `renderer.samples` later is silently
	 * ignored — it still reads 4 afterwards), and the FXAA node is part of the
	 * composite's node graph, which cannot be swapped without rebuilding
	 * `PostProcessing` — and that has no `dispose()`, so each rebuild strands
	 * ~26 MB of render targets. Persist now, apply on the next load.
	 */
	private updateAaRestartHint(root?: HTMLElement): void {
		const host = root ?? this.overlay;
		const pending = this.state.aaMode !== this.sessionAaMode;
		host?.querySelector("#aa-restart-note")?.classList.toggle("is-on", pending);

		// Dropping MSAA costs more than edge quality, so it is called out rather
		// than left as a surprise.
		//
		// Alpha-to-coverage needs real samples to distribute coverage across, so it
		// switches off with MSAA — and that moves the grass out of the opaque queue
		// and back into the blended one, where a field this dense cannot be
		// depth-sorted meaningfully and overlapping blades trade places frame to
		// frame. Measured on the island ridge, isolated flickering pixels per 1000:
		// MSAA 0.29, MSAA+FXAA 0.23, FXAA alone 1.29, Off 2.01. FXAA smooths a
		// static edge well but cannot put the sort order back.
		host
			?.querySelector("#aa-grass-note")
			?.classList.toggle("is-on", !aaModeUsesMsaa(this.state.aaMode));
	}

	private dispatchSlider(key: string, value: number): void {
		switch (key) {
			case "roomMaxPlayers":
				this.state.roomMaxPlayers = value;
				this.options.onRoomMaxPlayersChange(value);
				return;
			case "botCount":
				this.state.botCount = value;
				this.options.onBotCountChange(value);
				return;
			case "renderScale":
				this.state.renderScale = value / 100;
				this.options.onRenderScaleChange(value / 100);
				this.updateScaleCaution(value);
				break;
			case "hour":
				this.state.hour = value;
				this.options.onHourChange(value);
				break;
			case "grassDensity":
				this.state.grassDensity = value;
				this.options.onGrassDensityChange(value);
				break;
			case "grassCull":
				this.state.grassCullDistance = value;
				this.options.onGrassCullDistanceChange(value);
				break;
			case "godRays":
				this.state.godRayIntensity = value;
				this.options.onGodRayIntensityChange(value);
				break;
			case "sunGlow":
				this.state.sunGlowMultiplier = value;
				this.options.onSunGlowMultiplierChange(value);
				break;
		}
	}

	private dispatchSwitch(key: string, value: boolean): void {
		if (key === "postFx") {
			this.state.postFx = value;
			this.options.onPostFxChange(value);
		} else if (key === "showStats") {
			this.state.showStats = value;
			this.options.onShowStatsChange(value);
		} else if (key === "autoDayNight") {
			this.state.autoDayNight = value;
			this.options.onAutoDayNightChange(value);
		}
	}

	/** Dynamically populate the per-vehicle tuning sliders in the CAR pane. */
	private populateTuningSliders(vehicleId: VehicleId): void {
		const container = this.overlay.querySelector("#car-tuning-sliders") as HTMLDivElement;
		if (!container) return;
		container.innerHTML = "";

		const defs = this.options.getCarTuningDefs?.(vehicleId);
		if (!defs || defs.length === 0) {
			container.innerHTML = `<div class="row"><div><div class="label">No tuning available</div><div class="hint">Select a vehicle to expose its parameters.</div></div><div class="control"></div><div class="readout is-off">—</div></div>`;
			return;
		}

		const decimals = (step: number) => (step < 1 ? 2 : 0);

		for (const def of defs) {
			const row = document.createElement("div");
			row.className = "row";
			row.innerHTML = `
				<div><div class="label">${def.label}</div><div class="hint">Default ${def.defaultValue.toFixed(decimals(def.step))}</div></div>
				<div class="control">
					<div class="ui-slider">
						<input type="range" min="${def.min}" max="${def.max}" step="${def.step}" value="${def.currentValue}" />
						<div class="ticks"><i></i><i></i><i></i><i></i><i></i></div>
					</div>
				</div>
				<div class="readout">${def.currentValue.toFixed(decimals(def.step))}</div>`;

			const input = row.querySelector("input") as HTMLInputElement;
			const readout = row.querySelector(".readout") as HTMLElement;
			input.addEventListener("input", () => {
				const val = parseFloat(input.value);
				readout.textContent = val.toFixed(decimals(def.step));
				this.options.onCarTuningChange?.(vehicleId, def.key, val);
			});

			container.appendChild(row);
		}
	}

	/** Re-populate tuning sliders (e.g. after a vehicle switch completes). */
	refreshTuningSliders(): void {
		this.populateTuningSliders(this.state.vehicle);
	}
}
