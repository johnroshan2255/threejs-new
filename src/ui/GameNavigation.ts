import { AuthService, type AuthUser } from "../auth/AuthService";

type GameNavigationOptions = {
	auth: AuthService;
	onUserChanged: (user: AuthUser | null) => void;
	onHost: () => void;
	onJoin: () => void;
	onLogout: () => void;
};

export class GameNavigation {
	private user: AuthUser | null = null;
	private isVisible = false;

	constructor(private readonly options: GameNavigationOptions) {}

	initialize(): void {
		const loginButton = document.getElementById("login-btn");
		const closeLoginButton = document.getElementById("close-game-login-btn");
		const submitLoginButton = document.getElementById("submit-game-login-btn") as HTMLButtonElement | null;
		const loginModal = document.getElementById("game-login-modal");
		const loginEmail = document.getElementById("game-login-email") as HTMLInputElement | null;
		const loginMessage = document.getElementById("game-login-error");

		loginButton?.addEventListener("click", () => {
			if (loginMessage) loginMessage.style.display = "none";
			if (loginModal) loginModal.style.display = "flex";
			loginEmail?.focus();
		});

		closeLoginButton?.addEventListener("click", () => {
			if (loginModal) loginModal.style.display = "none";
		});

		submitLoginButton?.addEventListener("click", async () => {
			const email = loginEmail?.value.trim() ?? "";
			if (!email) {
				this.showLoginError("Please provide an email.");
				return;
			}

			submitLoginButton.disabled = true;
			try {
				const user = await this.options.auth.login(email);
				this.setUser(user);
				this.options.onUserChanged(user);
				if (loginEmail) loginEmail.value = "";
				if (loginModal) loginModal.style.display = "none";
			} catch (error) {
				this.showLoginError(error instanceof Error ? error.message : "Login failed.");
			} finally {
				submitLoginButton.disabled = false;
			}
		});

		const logoutButton = document.getElementById("logout-btn");
		const logoutModal = document.getElementById("logout-confirm-modal");
		document.getElementById("cancel-logout-btn")?.addEventListener("click", () => {
			if (logoutModal) logoutModal.style.display = "none";
		});
		logoutButton?.addEventListener("click", () => {
			if (logoutModal) logoutModal.style.display = "flex";
		});
		document.getElementById("confirm-logout-btn")?.addEventListener("click", () => {
			this.options.auth.logout();
			this.setUser(null);
			this.options.onUserChanged(null);
			this.options.onLogout();
			if (logoutModal) logoutModal.style.display = "none";
		});

		const hostModal = document.getElementById("host-confirm-modal");
		document.getElementById("in-game-host-btn")?.addEventListener("click", () => {
			if (this.user && hostModal) hostModal.style.display = "flex";
		});
		document.getElementById("cancel-host-btn")?.addEventListener("click", () => {
			if (hostModal) hostModal.style.display = "none";
		});
		document.getElementById("confirm-host-btn")?.addEventListener("click", () => {
			if (!this.user) return;
			if (hostModal) hostModal.style.display = "none";
			this.options.onHost();
		});

		document.getElementById("in-game-join-btn")?.addEventListener("click", () => {
			if (this.user) this.options.onJoin();
		});

		this.render();
	}

	setUser(user: AuthUser | null): void {
		this.user = user;
		this.render();
	}

	show(): void {
		this.isVisible = true;
		this.render();
	}

	hide(): void {
		this.isVisible = false;
		this.render();
	}

	private render(): void {
		const nav = document.getElementById("game-top-nav");
		const loginButton = document.getElementById("login-btn");
		const hostButton = document.getElementById("in-game-host-btn");
		const joinButton = document.getElementById("in-game-join-btn");
		const logoutButton = document.getElementById("logout-btn");
		const isAuthenticated = this.user !== null;

		if (nav) nav.style.display = this.isVisible ? "flex" : "none";
		if (loginButton) loginButton.style.display = isAuthenticated ? "none" : "block";
		if (hostButton) hostButton.style.display = isAuthenticated ? "block" : "none";
		if (joinButton) joinButton.style.display = isAuthenticated ? "block" : "none";
		if (logoutButton) logoutButton.style.display = isAuthenticated ? "block" : "none";
	}

	private showLoginError(message: string): void {
		const element = document.getElementById("game-login-error");
		if (!element) return;
		element.textContent = message;
		element.style.display = "block";
	}
}
