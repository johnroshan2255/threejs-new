import { AuthService, type AuthUser } from "../auth/AuthService";

type LoadingScreenOptions = {
	auth: AuthService;
	onPlay: () => void;
	onAccountCreated?: (user: AuthUser) => void;
};

export class LoadingScreenController {
	constructor(private readonly options: LoadingScreenOptions) {}

	initialize(): void {
		const loadingScreen = document.getElementById("loading-screen");
		const playButton = document.getElementById("play-button") as HTMLButtonElement | null;
		const createAccountButton = document.getElementById("create-account-btn");
		const closeAccountButton = document.getElementById("close-account-btn");
		const submitAccountButton = document.getElementById("submit-account-btn") as HTMLButtonElement | null;
		const usernameInput = document.getElementById("username") as HTMLInputElement | null;
		const emailInput = document.getElementById("email") as HTMLInputElement | null;
		const message = document.getElementById("account-success-msg");

		if (playButton) {
			playButton.textContent = "Play";
			playButton.disabled = false;
			playButton.classList.add("ready");
			playButton.addEventListener("click", this.options.onPlay);
		}

		createAccountButton?.addEventListener("click", () => {
			loadingScreen?.classList.add("show-account");
		});

		closeAccountButton?.addEventListener("click", () => {
			loadingScreen?.classList.remove("show-account");
		});

		submitAccountButton?.addEventListener("click", async () => {
			const username = usernameInput?.value.trim() ?? "";
			const email = emailInput?.value.trim() ?? "";

			if (!username || !email) {
				this.showMessage(message, "Please fill in all fields.", true);
				return;
			}

			submitAccountButton.disabled = true;
			try {
				const user = await this.options.auth.register(username, email);
				this.options.onAccountCreated?.(user);
				this.showMessage(message, "Account created — you're logged in.", false);
				if (usernameInput) usernameInput.value = "";
				if (emailInput) emailInput.value = "";
				window.setTimeout(() => {
					loadingScreen?.classList.remove("show-account");
					if (message) message.style.display = "none";
				}, 1800);
			} catch (error) {
				const text = error instanceof Error ? error.message : "Unable to create account.";
				this.showMessage(message, text, true);
			} finally {
				submitAccountButton.disabled = false;
			}
		});
	}

	hide(): void {
		const loadingScreen = document.getElementById("loading-screen");
		if (!loadingScreen) return;

		loadingScreen.style.opacity = "0";
		window.setTimeout(() => {
			loadingScreen.style.display = "none";
		}, 500);
	}

	private showMessage(element: HTMLElement | null, text: string, isError: boolean): void {
		if (!element) return;
		element.textContent = text;
		element.style.color = isError ? "#ff6b6b" : "#a3d977";
		element.style.display = "block";
	}
}
