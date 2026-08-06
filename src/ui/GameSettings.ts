export type QualityLevel = "Low" | "Medium" | "High";
export type GameWorldId = string;

type DayPeriod = "morning" | "noon" | "evening" | "sunset" | "night";

type GameSettingsOptions = {
	shadowQuality: QualityLevel;
	resolutionQuality: QualityLevel;
	waterQuality: QualityLevel;
	postFx: boolean;
	showStats: boolean;
	period: DayPeriod;
	autoDayNight: boolean;
	hour: number;
	grassDensity: number;
	grassCullDistance: number;
	carPower: number;
	world: GameWorldId;
	worldOptions?: Record<string, string>;
	onShadowQualityChange: (quality: QualityLevel) => void;
	onResolutionQualityChange: (quality: QualityLevel) => void;
	onWaterQualityChange: (quality: QualityLevel) => void;
	onPostFxChange: (enabled: boolean) => void;
	onShowStatsChange: (enabled: boolean) => void;
	onPeriodChange: (period: DayPeriod) => void;
	onAutoDayNightChange: (enabled: boolean) => void;
	onHourChange: (hour: number) => void;
	onGrassDensityChange: (percent: number) => void;
	onGrassCullDistanceChange: (meters: number) => void;
	onCarPowerChange: (power: number) => void;
	onWorldChange: (world: GameWorldId) => Promise<void>;
};

export class GameSettings {
	private readonly state;
	private overlay: HTMLElement;
	private worldSelect!: HTMLSelectElement;

	constructor(private readonly options: GameSettingsOptions) {
		this.state = {
			shadowQuality: options.shadowQuality,
			resolutionQuality: options.resolutionQuality,
			waterQuality: options.waterQuality,
			postFx: options.postFx,
			showStats: options.showStats,
			period: options.period,
			autoDayNight: options.autoDayNight,
			hour: options.hour,
			grassDensity: options.grassDensity,
			grassCullDistance: options.grassCullDistance,
			carPower: options.carPower,
			world: options.world,
		};

		this.overlay = this.buildDOM();
		document.body.appendChild(this.overlay);

		this.bindToggle();
	}

	show(): void {
		this.overlay.style.display = "flex";
		this.overlay.classList.remove("hidden");
	}

	hide(): void {
		this.overlay.style.display = "none";
		this.overlay.classList.add("hidden");
	}

	setHour(hour: number): void {
		this.state.hour = hour;
		const hourInput = document.getElementById("set-hour") as HTMLInputElement;
		if (hourInput) {
			hourInput.value = hour.toString();
			hourInput.nextElementSibling!.textContent = hour.toFixed(1);
		}
	}

	setPeriod(period: DayPeriod): void {
		this.state.period = period;
		const periodSelect = document.getElementById("set-period") as HTMLSelectElement;
		if (periodSelect) periodSelect.value = period;
	}

	setAutoDayNight(enabled: boolean): void {
		this.state.autoDayNight = enabled;
		const autoToggle = document.getElementById("set-autodaynight") as HTMLInputElement;
		if (autoToggle) autoToggle.checked = enabled;
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
		const toggle = document.getElementById("settings-toggle");
		const sync = () => {
			const open = this.overlay.style.display === "flex";
			toggle?.classList.toggle("is-open", open);
			toggle?.setAttribute("aria-label", open ? "Close settings" : "Open settings");
		};

		sync();
		toggle?.addEventListener("click", () => {
			if (this.overlay.style.display === "none") {
				this.show();
			} else {
				this.hide();
			}
			sync();
		});

		const closeBtn = this.overlay.querySelector(".custom-settings-close");
		closeBtn?.addEventListener("click", () => {
			this.hide();
			sync();
		});
		
		// Close on backdrop click
		this.overlay.addEventListener("click", (e) => {
			if (e.target === this.overlay) {
				this.hide();
				sync();
			}
		});
	}

	public attachSystemButtons() {
		const container = document.getElementById("system-actions-container");
		if (container) {
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
	}

	private buildDOM(): HTMLElement {
		const overlay = document.createElement("div");
		overlay.id = "custom-settings-overlay";
		overlay.className = "custom-settings-overlay hidden";
		overlay.style.display = "none";

		const html = `
			<div class="custom-settings-modal">
				<div class="custom-settings-header">
					<h2>SETTINGS</h2>
					<button class="custom-settings-close" title="Close Settings">&times;</button>
				</div>
				<div class="custom-settings-body">
					<div class="custom-settings-sidebar">
						<button data-target="settings-graphics" class="active">GRAPHICS</button>
						<button data-target="settings-daynight">DAY / NIGHT</button>
						<button data-target="settings-grass">GRASS</button>
						<button data-target="settings-car">CAR</button>
						<button data-target="settings-world">WORLD</button>
						<button data-target="settings-system">SYSTEM</button>
					</div>
					<div class="custom-settings-content">
						<!-- GRAPHICS -->
						<div id="settings-graphics" class="settings-pane active">
							<h3>GRAPHICS SETTINGS</h3>
							<div class="setting-row">
								<label for="set-shadow">Shadow Quality</label>
								<select id="set-shadow">
									<option value="Low">Low (Off)</option>
									<option value="Medium">Medium</option>
									<option value="High">High</option>
								</select>
							</div>
							<div class="setting-row">
								<label for="set-resolution">Resolution</label>
								<select id="set-resolution">
									<option value="Low">Low</option>
									<option value="Medium">Medium</option>
									<option value="High">High</option>
								</select>
							</div>
							<div class="setting-row">
								<label for="set-water">Water Physics</label>
								<select id="set-water">
									<option value="Low">Low</option>
									<option value="Medium">Medium</option>
									<option value="High">High</option>
								</select>
							</div>
							<div class="setting-row">
								<label for="set-postfx">Atmospheric FX</label>
								<label class="toggle-switch">
									<input type="checkbox" id="set-postfx" />
									<span class="toggle-slider"></span>
								</label>
							</div>
							<div class="setting-row">
								<label for="set-showstats">Show Stats (FPS)</label>
								<label class="toggle-switch">
									<input type="checkbox" id="set-showstats" />
									<span class="toggle-slider"></span>
								</label>
							</div>
						</div>

						<!-- DAY / NIGHT -->
						<div id="settings-daynight" class="settings-pane">
							<h3>DAY / NIGHT</h3>
							<div class="setting-row">
								<label for="set-period">Period</label>
								<select id="set-period">
									<option value="morning">Morning</option>
									<option value="noon">Noon</option>
									<option value="evening">Evening</option>
									<option value="sunset">Sunset</option>
									<option value="night">Night</option>
								</select>
							</div>
							<div class="setting-row">
								<label for="set-autodaynight">Auto Cycle</label>
								<label class="toggle-switch">
									<input type="checkbox" id="set-autodaynight" />
									<span class="toggle-slider"></span>
								</label>
							</div>
							<div class="setting-row">
								<label for="set-hour">Hour</label>
								<div class="slider-container">
									<input type="range" id="set-hour" min="0" max="24" step="0.1" />
									<span class="slider-value">0.0</span>
								</div>
							</div>
						</div>

						<!-- GRASS -->
						<div id="settings-grass" class="settings-pane">
							<h3>GRASS SETTINGS</h3>
							<div class="setting-row">
								<label for="set-grass-density">Density %</label>
								<div class="slider-container">
									<input type="range" id="set-grass-density" min="0" max="100" step="1" />
									<span class="slider-value">100</span>
								</div>
							</div>
							<div class="setting-row">
								<label for="set-grass-cull">Cull Distance (m)</label>
								<div class="slider-container">
									<input type="range" id="set-grass-cull" min="30" max="250" step="1" />
									<span class="slider-value">72</span>
								</div>
							</div>
						</div>

						<!-- CAR -->
						<div id="settings-car" class="settings-pane">
							<h3>VEHICLE SETTINGS</h3>
							<div class="setting-row">
								<label for="set-car-power">Engine Power</label>
								<div class="slider-container">
									<input type="range" id="set-car-power" min="100" max="1200" step="10" />
									<span class="slider-value">400</span>
								</div>
							</div>
						</div>

						<!-- WORLD -->
						<div id="settings-world" class="settings-pane">
							<h3>WORLD SELECTION</h3>
							<div class="setting-row">
								<label for="set-world">Current World</label>
								<select id="set-world"></select>
							</div>
						</div>

						<!-- SYSTEM -->
						<div id="settings-system" class="settings-pane">
							<h3>SYSTEM & MULTIPLAYER</h3>
							<div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 10px;">
								<div id="system-actions-container" style="display: flex; flex-direction: column; gap: 10px;">
									<!-- Buttons will be moved here by JS -->
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;
		overlay.innerHTML = html;

		// Bind sidebar switching
		const tabs = overlay.querySelectorAll(".custom-settings-sidebar button");
		const panes = overlay.querySelectorAll(".settings-pane");
		tabs.forEach(tab => {
			tab.addEventListener("click", () => {
				tabs.forEach(t => t.classList.remove("active"));
				panes.forEach(p => p.classList.remove("active"));
				tab.classList.add("active");
				const target = tab.getAttribute("data-target");
				if (target) {
					overlay.querySelector("#" + target)?.classList.add("active");
				}
			});
		});

		// Initialize values & listeners
		const sSel = overlay.querySelector("#set-shadow") as HTMLSelectElement;
		sSel.value = this.state.shadowQuality;
		sSel.addEventListener("change", (e) => this.options.onShadowQualityChange((e.target as HTMLSelectElement).value as QualityLevel));

		const rSel = overlay.querySelector("#set-resolution") as HTMLSelectElement;
		rSel.value = this.state.resolutionQuality;
		rSel.addEventListener("change", (e) => this.options.onResolutionQualityChange((e.target as HTMLSelectElement).value as QualityLevel));

		const wSel = overlay.querySelector("#set-water") as HTMLSelectElement;
		wSel.value = this.state.waterQuality;
		wSel.addEventListener("change", (e) => this.options.onWaterQualityChange((e.target as HTMLSelectElement).value as QualityLevel));

		const fxChk = overlay.querySelector("#set-postfx") as HTMLInputElement;
		fxChk.checked = this.state.postFx;
		fxChk.addEventListener("change", (e) => this.options.onPostFxChange((e.target as HTMLInputElement).checked));

		const statsChk = overlay.querySelector("#set-showstats") as HTMLInputElement;
		statsChk.checked = this.state.showStats;
		statsChk.addEventListener("change", (e) => this.options.onShowStatsChange((e.target as HTMLInputElement).checked));

		const pSel = overlay.querySelector("#set-period") as HTMLSelectElement;
		pSel.value = this.state.period;
		pSel.addEventListener("change", (e) => this.options.onPeriodChange((e.target as HTMLSelectElement).value as DayPeriod));

		const autoChk = overlay.querySelector("#set-autodaynight") as HTMLInputElement;
		autoChk.checked = this.state.autoDayNight;
		autoChk.addEventListener("change", (e) => this.options.onAutoDayNightChange((e.target as HTMLInputElement).checked));

		const hourInp = overlay.querySelector("#set-hour") as HTMLInputElement;
		hourInp.value = this.state.hour.toString();
		hourInp.nextElementSibling!.textContent = this.state.hour.toFixed(1);
		hourInp.addEventListener("input", (e) => {
			const val = parseFloat((e.target as HTMLInputElement).value);
			hourInp.nextElementSibling!.textContent = val.toFixed(1);
			this.options.onHourChange(val);
		});

		const gDensInp = overlay.querySelector("#set-grass-density") as HTMLInputElement;
		gDensInp.value = this.state.grassDensity.toString();
		gDensInp.nextElementSibling!.textContent = this.state.grassDensity.toString();
		gDensInp.addEventListener("input", (e) => {
			const val = parseFloat((e.target as HTMLInputElement).value);
			gDensInp.nextElementSibling!.textContent = val.toString();
			this.options.onGrassDensityChange(val);
		});

		const gCullInp = overlay.querySelector("#set-grass-cull") as HTMLInputElement;
		gCullInp.value = this.state.grassCullDistance.toString();
		gCullInp.nextElementSibling!.textContent = this.state.grassCullDistance.toString();
		gCullInp.addEventListener("input", (e) => {
			const val = parseFloat((e.target as HTMLInputElement).value);
			gCullInp.nextElementSibling!.textContent = val.toString();
			this.options.onGrassCullDistanceChange(val);
		});

		const cPowInp = overlay.querySelector("#set-car-power") as HTMLInputElement;
		cPowInp.value = this.state.carPower.toString();
		cPowInp.nextElementSibling!.textContent = this.state.carPower.toString();
		cPowInp.addEventListener("input", (e) => {
			const val = parseFloat((e.target as HTMLInputElement).value);
			cPowInp.nextElementSibling!.textContent = val.toString();
			this.options.onCarPowerChange(val);
		});

		this.worldSelect = overlay.querySelector("#set-world") as HTMLSelectElement;
		const initialWorldOptions = this.options.worldOptions ?? { Island: "island", Valley: "valley" };
		this.setWorldOptions(initialWorldOptions);
		this.worldSelect.addEventListener("change", async (e) => {
			const next = (e.target as HTMLSelectElement).value;
			const previous = this.state.world;
			try {
				await this.options.onWorldChange(next);
			} catch {
				this.state.world = previous;
				this.worldSelect.value = previous;
			}
		});

		return overlay;
	}
}
