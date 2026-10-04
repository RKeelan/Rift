import type { IncomingHttpHeaders } from "node:http";
import net from "node:net";
import type { RequestHandler } from "express";

// Rift has two kinds of caller. Local processes on this machine (the CLI, the
// Vite dev proxy, a browser on the desktop) reach the loopback-bound server
// directly and send no proxy headers; they already have filesystem access, so
// the server trusts them. Everyone else arrives through `tailscale serve`, which
// adds forwarding headers and stamps the caller's Tailscale identity, replacing
// any identity header the caller sent. A request carrying any sign of a proxy
// is therefore treated as remote and must name an allowed login.

// Headers whose presence marks a request as having passed through a proxy.
// tailscaled sets the `tailscale-*` identity headers and the `x-forwarded-*`
// family; the rest are what other proxies commonly add.
const PROXY_HEADER_PREFIXES = ["tailscale-", "x-forwarded-"];
const PROXY_HEADERS = new Set([
	"forwarded",
	"via",
	"x-real-ip",
	"x-client-ip",
	"true-client-ip",
	"cf-connecting-ip",
]);

const LOGIN_HEADER = "tailscale-user-login";
const FUNNEL_HEADER = "tailscale-funnel-request";

export type RequestOrigin =
	| { kind: "local" }
	| { kind: "proxied"; login: string | null; funnel: boolean };

export type AccessDecision =
	| { allowed: true }
	| { allowed: false; reason: "funnel" | "no-login" | "login-not-allowed" };

function headerValue(value: string | string[] | undefined): string | null {
	if (value === undefined) return null;
	const joined = Array.isArray(value) ? value.join(", ") : value;
	const trimmed = joined.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function classifyRequest(headers: IncomingHttpHeaders): RequestOrigin {
	const proxied = Object.keys(headers).some((name) => {
		const lower = name.toLowerCase();
		return (
			PROXY_HEADERS.has(lower) ||
			PROXY_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
		);
	});
	if (!proxied) return { kind: "local" };
	return {
		kind: "proxied",
		login: headerValue(headers[LOGIN_HEADER]),
		funnel: headers[FUNNEL_HEADER] !== undefined,
	};
}

export function decideAccess(
	origin: RequestOrigin,
	allowedLogins: ReadonlySet<string>,
): AccessDecision {
	if (origin.kind === "local") return { allowed: true };
	if (origin.funnel) return { allowed: false, reason: "funnel" };
	if (origin.login === null) return { allowed: false, reason: "no-login" };
	if (!allowedLogins.has(origin.login.toLowerCase())) {
		return { allowed: false, reason: "login-not-allowed" };
	}
	return { allowed: true };
}

/** Splits `RIFT_ALLOWED_LOGINS` into lower-cased logins. */
export function parseAllowedLogins(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((login) => login.trim().toLowerCase())
		.filter((login) => login.length > 0);
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Interprets `RIFT_ALLOW_WRITES`; anything but a recognised truthy value is false. */
export function parseAllowWrites(value: string | undefined): boolean {
	return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

/**
 * True when `host` names a loopback interface: an address in 127.0.0.0/8, `::1`,
 * or `localhost`. Header-less requests are trusted as local, which is only safe
 * when nothing outside this machine can connect except through tailscaled.
 */
export function isLoopbackHost(host: string): boolean {
	const value = host.trim().toLowerCase();
	if (value === "localhost") return true;
	if (net.isIPv4(value)) return value.split(".")[0] === "127";
	if (net.isIPv6(value)) {
		// Canonicalise so spellings such as 0:0:0:0:0:0:0:1 are recognised.
		try {
			return new URL(`http://[${value}]`).hostname === "[::1]";
		} catch {
			return false;
		}
	}
	return false;
}

/** Returns the bind address from `HOST`, refusing anything but loopback. */
export function resolveHost(value: string | undefined): string {
	const host = value?.trim() || "127.0.0.1";
	if (!isLoopbackHost(host)) {
		throw new Error(
			`HOST=${host} is not a loopback address. Rift trusts requests that ` +
				"arrive without proxy headers as coming from this machine, which is " +
				"only safe while tailscale serve is the sole way in from outside. " +
				"Bind to 127.0.0.1 (the default), ::1, or localhost, and expose Rift " +
				"with tailscale serve.",
		);
	}
	return host;
}

const DENIAL_MESSAGES: Record<
	Exclude<AccessDecision, { allowed: true }>["reason"],
	string
> = {
	funnel: "Rift is not available through Tailscale Funnel",
	"no-login": "Proxied requests must carry an allowed Tailscale identity",
	"login-not-allowed": "This Tailscale login is not allowed to use Rift",
};

/** Refuses proxied requests unless they carry an allowed Tailscale login. */
export function identityGate(allowedLogins: readonly string[]): RequestHandler {
	const allowed = new Set(allowedLogins.map((login) => login.toLowerCase()));
	return (req, res, next) => {
		const origin = classifyRequest(req.headers);
		const decision = decideAccess(origin, allowed);
		if (decision.allowed) {
			next();
			return;
		}
		const login = origin.kind === "proxied" ? origin.login : null;
		console.warn(
			`Refused ${req.method} ${req.originalUrl}: ${decision.reason}${
				login ? ` (${login})` : ""
			}`,
		);
		res.status(403).json({
			error: {
				code: "ACCESS_DENIED",
				message: DENIAL_MESSAGES[decision.reason],
			},
		});
	};
}

// Methods that never change state. Every other method is treated as a write, so
// a mutating endpoint is gated as soon as it exists rather than once someone
// remembers to list it.
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Refuses every state-changing request unless writes are allowed. */
export function writeGate(allowWrites: boolean): RequestHandler {
	return (req, res, next) => {
		if (allowWrites || READ_METHODS.has(req.method)) {
			next();
			return;
		}
		console.warn(`Refused ${req.method} ${req.originalUrl}: writes disabled`);
		res.status(403).json({
			error: {
				code: "WRITES_DISABLED",
				message:
					"Rift is read-only: the server does not allow changes. " +
					"Set RIFT_ALLOW_WRITES=1 on the server to allow them.",
			},
		});
	};
}
