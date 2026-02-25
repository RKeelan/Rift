/**
 * Prepend Vite's BASE_URL to an API path so fetch/WebSocket calls
 * work behind a reverse-proxy sub-path (e.g. /rift/).
 */
export function apiUrl(path: string): string {
	return `${import.meta.env.BASE_URL.replace(/\/$/, "")}${path}`;
}
