import * as dat from "dat.gui";

export type GraphicsQuality = "Low" | "Medium" | "High";
/** Builtin or custom-* world ids. */
export type GameWorldId = string;

type DayPeriod = "morning" | "noon" | "evening" | "sunset" | "night";

type GameSettingsOptions = {
	quality: GraphicsQuality;
	/** Volumetric fog raymarch + HDR bloom. The composite grade always runs. */
	postFx: boolean;
	period: DayPeriod;
	autoDayNight: boolean;
	hour: number;
	grassDensity: number;
	/** Grass hard-hide distance in meters (default 72). */
	grassCullDistance: number;
	carPower: number;
	world: GameWorldId;
	worldOptions?: Record<string, string>;
	onQualityChange: (quality: GraphicsQuality) => void;
	onPostFxChange: (enabled: boolean) => void;
	onPeriodChange: (period: DayPeriod) => void;
	onAutoDayNightChange: (enabled: boolean) => void;
	onHourChange: (hour: number) => void;
	onGrassDensityChange: (percent: number) => void;
	onGrassCullDistanceChange: (meters: number) => void;
	onCarPowerChange: (power: number) => void;
	onWorldChange: (world: GameWorldId) => Promise<void>;
};

export class GameSettings {
	private readonly gui: dat.GUI;
	private readonly state;
	private worldController: dat.GUIController;
	private worldFolder: dat.GUI;

	constructor(private readonly options: GameSettingsOptions) {
		this.state = {
			graphics: options.quality,
			postFx: options.postFx,
			period: options.period,
			autoDayNight: options.autoDayNight,
			hour: options.hour,
			grassDensity: options.grassDensity,
			grassCullDistance: options.grassCullDistance,
			carPower: options.carPower,
			world: options.world,
		};

		this.gui = new dat.GUI({ hideable: false });
		this.gui.close();
		this.gui.hide();
		this.gui.domElement.classList.add("fg-settings");
		this.configureContainer();

		const graphics = this.gui.addFolder("Graphics");
		graphics
			.add(this.state, "graphics", ["Low", "Medium", "High"])
			.name("Quality")
			.onChange(options.onQualityChange);
		graphics
			.add(this.state, "postFx")
			.name("Atmospheric FX")
			.onChange(options.onPostFxChange);

		const dayNight = this.gui.addFolder("Day / Night");
		dayNight
			.add(this.state, "period", ["morning", "noon", "evening", "sunset", "night"])
			.name("Period")
			.onChange(options.onPeriodChange);
		dayNight
			.add(this.state, "autoDayNight")
			.name("Auto cycle")
			.onChange(options.onAutoDayNightChange);
		dayNight
			.add(this.state, "hour", 0, 24, 0.1)
			.name("Hour")
			.listen()
			.onChange(options.onHourChange);

		const grass = this.gui.addFolder("Grass");
		grass
			.add(this.state, "grassDensity", 0, 100, 1)
			.name("Density %")
			.onChange(options.onGrassDensityChange);
		grass
			.add(this.state, "grassCullDistance", 30, 250, 1)
			.name("Cull distance")
			.onChange(options.onGrassCullDistanceChange);

		const car = this.gui.addFolder("Car");
		car
			.add(this.state, "carPower", 100, 1200, 10)
			.name("Power")
			.onChange(options.onCarPowerChange);

		this.worldFolder = this.gui.addFolder("World");
		this.worldController = this.worldFolder
			.add(this.state, "world", options.worldOptions ?? { Island: "island", Valley: "valley" })
			.name("Current")
			.onChange(async (next: GameWorldId) => {
				const previous = this.state.world;
				try {
					await options.onWorldChange(next);
				} catch {
					this.state.world = previous;
					this.worldController.updateDisplay();
				}
			});

		graphics.open();
		dayNight.open();
		grass.open();
		car.open();
		this.worldFolder.open();
		this.bindToggle();
	}

	show(): void {
		this.gui.show();
	}

	hide(): void {
		this.gui.hide();
	}

	setHour(hour: number): void {
		this.state.hour = hour;
	}

	setPeriod(period: DayPeriod): void {
		this.state.period = period;
	}

	setAutoDayNight(enabled: boolean): void {
		this.state.autoDayNight = enabled;
	}

	setWorld(world: GameWorldId): void {
		this.state.world = world;
		this.worldController.updateDisplay();
	}

	setWorldOptions(options: Record<string, string>): void {
		this.worldFolder.remove(this.worldController);
		this.worldController = this.worldFolder
			.add(this.state, "world", options)
			.name("Current")
			.onChange(async (next: GameWorldId) => {
				const previous = this.state.world;
				try {
					await this.options.onWorldChange(next);
				} catch {
					this.state.world = previous;
					this.worldController.updateDisplay();
				}
			});
	}

	private configureContainer(): void {
		const container = this.gui.domElement.parentElement as HTMLDivElement;
		container.style.zIndex = "9999";
		container.style.position = "fixed";
		container.style.top = "0";
		container.style.left = "0";
		container.style.right = "auto";
		container.style.display = "block";
	}

	private bindToggle(): void {
		const toggle = document.getElementById("settings-toggle");
		const sync = () => {
			const open = !this.gui.closed;
			this.gui.domElement.classList.toggle("fg-hidden", !open);
			toggle?.classList.toggle("is-open", open);
			toggle?.setAttribute("aria-label", open ? "Close settings" : "Open settings");
		};

		sync();
		toggle?.addEventListener("click", () => {
			if (this.gui.closed) this.gui.open();
			else this.gui.close();
			sync();
		});
	}
}
