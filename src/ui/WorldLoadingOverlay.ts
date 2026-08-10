export class WorldLoadingOverlay {
	private readonly root: HTMLDivElement;
	private readonly title: HTMLHeadingElement;
	private readonly status: HTMLParagraphElement;
	private readonly bar: HTMLDivElement;

	constructor() {
		this.root = document.createElement("div");
		this.root.className = "world-loading-overlay";
		this.root.setAttribute("role", "status");
		this.root.setAttribute("aria-live", "polite");
		this.root.innerHTML = `
			<div class="world-loading-card">
				<div class="world-loading-card-head">
					<p>Loading world</p>
					<h2>Preparing terrain</h2>
				</div>
				<div class="world-loading-card-body">
					<div class="world-loading-track">
						<div class="world-loading-progress"></div>
					</div>
				</div>
			</div>
		`;

		this.title = this.root.querySelector("h2")!;
		this.status = this.root.querySelector("p")!;
		this.bar = this.root.querySelector(".world-loading-progress")!;
		document.body.appendChild(this.root);
	}

	show(worldName: string): void {
		this.status.textContent = worldName;
		this.title.textContent = "Preparing terrain";
		this.bar.style.width = "5%";
		this.root.classList.add("is-visible");
	}

	/** Generic task, for anything that stalls a frame but isn't a world load. */
	showTask(title: string, message: string): void {
		this.status.textContent = title;
		this.title.textContent = message;
		this.bar.style.width = "10%";
		this.root.classList.add("is-visible");
	}

	setProgress(percent: number, message: string): void {
		this.bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
		this.title.textContent = message;
	}

	hide(): void {
		this.root.classList.remove("is-visible");
	}

	showError(message: string): void {
		this.status.textContent = "World change failed";
		this.title.textContent = message;
		this.bar.style.width = "0%";
		window.setTimeout(() => this.hide(), 3000);
	}
}
