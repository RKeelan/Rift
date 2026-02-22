export class ApiError extends Error {
	constructor(
		public code: string,
		message: string,
		public statusCode: number,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export class ApiClient {
	constructor(public baseUrl: string) {}

	private url(path: string): string {
		return `${this.baseUrl}${path}`;
	}

	private async throwIfNotOk(res: Response): Promise<void> {
		if (res.ok) return;
		let code = "UNKNOWN";
		let message = res.statusText;
		try {
			const body = await res.json();
			if (body.error) {
				code = body.error.code ?? code;
				message = body.error.message ?? message;
			}
		} catch {
			// Response body wasn't JSON
		}
		throw new ApiError(code, message, res.status);
	}

	async get<T>(path: string): Promise<T> {
		const res = await fetch(this.url(path));
		await this.throwIfNotOk(res);
		return res.json() as Promise<T>;
	}

	async getText(path: string): Promise<string> {
		const res = await fetch(this.url(path));
		await this.throwIfNotOk(res);
		return res.text();
	}

	async post<T>(path: string, body?: unknown): Promise<T> {
		const res = await fetch(this.url(path), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		await this.throwIfNotOk(res);
		return res.json() as Promise<T>;
	}

	async delete<T>(path: string): Promise<T> {
		const res = await fetch(this.url(path), { method: "DELETE" });
		await this.throwIfNotOk(res);
		return res.json() as Promise<T>;
	}

	wsUrl(path: string): string {
		const base = this.baseUrl.startsWith("https")
			? this.baseUrl.replace("https", "wss")
			: this.baseUrl.replace("http", "ws");
		return `${base}${path}`;
	}
}
