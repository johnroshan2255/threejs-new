export type AuthUser = {
	id?: string;
	username?: string;
	email?: string;
};

type AuthResponse = {
	user?: AuthUser;
	token?: string;
	error?: string;
};

export class AuthService {
	private readonly tokenKey = "authToken";

	constructor(private readonly serverUrl: string) {}

	async restoreSession(): Promise<AuthUser | null> {
		const token = localStorage.getItem(this.tokenKey);
		if (!token) return null;

		try {
			const response = await fetch(`${this.serverUrl}/api/auth/validate`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const data = await this.readResponse(response);

			if (!response.ok || !data.user) {
				this.logout();
				return null;
			}

			return data.user;
		} catch {
			return null;
		}
	}

	async register(username: string, email: string): Promise<void> {
		const response = await fetch(`${this.serverUrl}/api/auth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username, email }),
		});
		const data = await this.readResponse(response);

		if (!response.ok) {
			throw new Error(data.error || "Failed to create account.");
		}
	}

	async login(email: string): Promise<AuthUser> {
		const response = await fetch(`${this.serverUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email }),
		});
		const data = await this.readResponse(response);

		if (!response.ok || !data.user) {
			throw new Error(data.error || "Login failed.");
		}

		if (data.token) {
			localStorage.setItem(this.tokenKey, data.token);
		}

		return data.user;
	}

	logout(): void {
		localStorage.removeItem(this.tokenKey);
	}

	private async readResponse(response: Response): Promise<AuthResponse> {
		try {
			return (await response.json()) as AuthResponse;
		} catch {
			return {};
		}
	}
}
