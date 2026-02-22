// Minimal type declarations for globals provided by the Bun runtime.
// A full @types/node or @types/bun dependency conflicts with the
// server workspace's transitive @types/node version.

declare namespace NodeJS {
	interface ProcessEnv {
		RIFT_URL?: string;
		[key: string]: string | undefined;
	}
}

declare const process: {
	env: NodeJS.ProcessEnv;
	stdout: { write(chunk: string): boolean };
	stderr: { write(chunk: string): boolean };
	exit(code?: number): never;
};

declare function setTimeout<T extends unknown[]>(
	callback: (...args: T) => void,
	ms?: number,
	...args: T
): ReturnType<typeof globalThis.setTimeout>;
declare function clearTimeout(
	id: ReturnType<typeof setTimeout> | undefined,
): void;
