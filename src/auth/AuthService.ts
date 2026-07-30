export type AuthUser = {
	id?: string;
	username?: string;
	email?: string;
};

type AuthResponse = {
	user?: AuthUser & { _id?: string };
	token?: string;
	error?: string;
};

function normalizeUser(raw: AuthUser & { _id?: string } | null | undefined): AuthUser | null {
	if (!raw) return null;
	const id = raw.id ?? (raw._id != null ? String(raw._id) : undefined);
	if (!id) return { username: raw.username, email: raw.email };
	return {
		id,
		username: raw.username,
		email: raw.email,
	};
}

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

			return normalizeUser(data.user);
		} catch {
			return null;
		}
	}

	async register(username: string, email: string): Promise<AuthUser> {
		const response = await fetch(`${this.serverUrl}/api/auth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username, email }),
		});
		const data = await this.readResponse(response);

		if (!response.ok) {
			throw new Error(data.error || "Failed to create account.");
		}

		if (data.token) {
			localStorage.setItem(this.tokenKey, data.token);
		}

		const user = normalizeUser(data.user);
		if (!user?.id) {
			throw new Error("Account created but user id was missing.");
		}
		return user;
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

		const user = normalizeUser(data.user);
		if (!user?.id) {
			throw new Error("Login succeeded but user id was missing.");
		}
		return user;
	}

	logout(): void {
		localStorage.removeItem(this.tokenKey);
	}

	getToken(): string | null {
		return localStorage.getItem(this.tokenKey);
	}

	private async readResponse(response: Response): Promise<AuthResponse> {
		try {
			return (await response.json()) as AuthResponse;
		} catch {
			return {};
		}
	}
}
