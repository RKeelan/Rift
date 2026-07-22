/**
 * Reads a JSON array of strings from `localStorage`, treating a missing,
 * malformed, or wrongly typed value as empty. Persisted UI state is a
 * convenience, so a bad entry must never break the view meant to restore it.
 */
export function readStringArray(key: string): string[] {
	if (typeof window === "undefined") return [];
	const stored = window.localStorage.getItem(key);
	if (!stored) return [];
	try {
		const parsed: unknown = JSON.parse(stored);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((value): value is string => typeof value === "string");
	} catch {
		return [];
	}
}

export function writeStringArray(key: string, values: string[]): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(key, JSON.stringify(values));
}
