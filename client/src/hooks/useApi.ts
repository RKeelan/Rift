import { useCallback, useEffect, useRef } from "react";
import { useErrorBanner } from "../components/ErrorBanner.tsx";

export interface ApiError {
	code: string;
	message: string;
}

interface ApiErrorEnvelope {
	error: ApiError;
}

function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		"error" in value &&
		typeof (value as ApiErrorEnvelope).error === "object" &&
		typeof (value as ApiErrorEnvelope).error.code === "string" &&
		typeof (value as ApiErrorEnvelope).error.message === "string"
	);
}

export function useApi() {
	const { showError } = useErrorBanner();
	const abortControllers = useRef<AbortController[]>([]);

	useEffect(() => {
		const controllers = abortControllers;
		return () => {
			for (const controller of controllers.current) {
				controller.abort();
			}
		};
	}, []);

	const request = useCallback(
		async <T>(
			url: string,
			options?: RequestInit & { silent?: boolean },
		): Promise<T | null> => {
			const { silent, ...fetchOptions } = options ?? {};
			const controller = new AbortController();
			abortControllers.current.push(controller);

			try {
				const headers: Record<string, string> = {
					...(fetchOptions.headers as Record<string, string>),
				};
				if (fetchOptions.body) {
					headers["Content-Type"] ??= "application/json";
				}

				const response = await fetch(url, {
					...fetchOptions,
					signal: controller.signal,
					headers,
				});

				if (!response.ok) {
					const body = await response.json().catch(() => null);
					const errorMessage = isApiErrorEnvelope(body)
						? body.error.message
						: `Request failed (${response.status})`;
					if (!silent) {
						showError(errorMessage);
					}
					return null;
				}

				return (await response.json()) as T;
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					return null;
				}
				if (!silent) {
					showError(err instanceof Error ? err.message : "Network error");
				}
				return null;
			} finally {
				abortControllers.current = abortControllers.current.filter(
					(c) => c !== controller,
				);
			}
		},
		[showError],
	);

	return { request };
}
