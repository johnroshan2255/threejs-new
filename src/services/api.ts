const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";

export const api = {
  async validateToken(token: string) {
    const res = await fetch(`${SERVER_URL}/api/auth/validate`, {
      headers: { Authorization: `Bearer ${token}` },
      method: "POST"
    });
    return res.json();
  },
  
  async login(email: string) {
    const res = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    return res.json();
  },

  async register(username: string, email: string) {
    const res = await fetch(`${SERVER_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email })
    });
    return res.json();
  }
};
