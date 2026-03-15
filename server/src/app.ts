import os from "node:os";
import path from "node:path";
import express from "express";
import { simpleGit } from "simple-git";
import { resolveRepo } from "./pathUtils.js";
import { fileRoutes } from "./routes/files.js";
import { gitRoutes } from "./routes/git.js";
import { repoRoutes } from "./routes/repos.js";

export interface AppConfig {
	port: number;
	reposRoot: string;
}

function looksLikeWindowsPath(input: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(input) || input.includes("\\");
}

const COMMON_SOURCE_DIR_NAMES = new Set(["src", "source", "repos"]);

export function inferReposRoot(cwd: string, homeDir: string): string {
	const pathImpl =
		looksLikeWindowsPath(cwd) || looksLikeWindowsPath(homeDir)
			? path.win32
			: path.posix;
	const resolvedHome = pathImpl.resolve(homeDir);
	const resolvedCwd = pathImpl.resolve(cwd);
	const relativeToHome = pathImpl.relative(resolvedHome, resolvedCwd);

	if (
		relativeToHome &&
		relativeToHome !== "." &&
		!relativeToHome.startsWith("..") &&
		!pathImpl.isAbsolute(relativeToHome)
	) {
		const segments = relativeToHome
			.split(pathImpl.sep)
			.filter((segment) => segment.length > 0);
		const sourceRootSegments: string[] = [];

		for (const segment of segments) {
			sourceRootSegments.push(segment);
			if (COMMON_SOURCE_DIR_NAMES.has(segment.toLowerCase())) {
				return pathImpl.join(resolvedHome, ...sourceRootSegments);
			}
		}
	}

	return resolvedHome;
}

export function getConfig(): AppConfig {
	const homeDir = os.homedir();
	return {
		port: Number(process.env.PORT) || 13000,
		reposRoot: process.env.REPOS_ROOT || inferReposRoot(process.cwd(), homeDir),
	};
}

export function createApp(config: AppConfig): express.Express {
	const app = express();
	const router = express.Router();

	router.use(express.json({ limit: "1mb" }));

	router.get("/api/health", async (req, res) => {
		const repoName = req.query.repo as string | undefined;
		if (!repoName) {
			res.json({ status: "ok" });
			return;
		}
		const result = await resolveRepo(config.reposRoot, repoName);
		if (!result.ok) {
			const status = result.reason === "forbidden" ? 403 : 404;
			const code =
				result.reason === "forbidden" ? "REPO_FORBIDDEN" : "NOT_FOUND";
			const message =
				result.reason === "forbidden"
					? "Invalid repo name"
					: "Repository not found";
			res.status(status).json({ error: { code, message } });
			return;
		}
		let gitRepo = false;
		try {
			const git = simpleGit(result.path);
			gitRepo = await git.checkIsRepo();
		} catch {
			// Not a git repo
		}
		res.json({ status: "ok", gitRepo });
	});

	router.use("/api/files", fileRoutes(config.reposRoot));
	router.use("/api/git", gitRoutes(config.reposRoot));
	router.use("/api/repos", repoRoutes(config.reposRoot));

	// Production: serve static files from client/dist
	const clientDist = path.resolve(
		import.meta.dirname,
		"..",
		"..",
		"client",
		"dist",
	);
	router.use(express.static(clientDist));

	// 404 handler for unmatched API routes
	router.all("/api/*", (_req, res) => {
		res.status(404).json({
			error: { code: "NOT_FOUND", message: "Endpoint not found" },
		});
	});

	// SPA fallback: serve index.html for client-side routes
	router.get("*", (_req, res) => {
		res.sendFile(path.join(clientDist, "index.html"));
	});

	app.use("/", router);

	// Catch-all error handler
	app.use(
		(
			err: Error,
			_req: express.Request,
			res: express.Response,
			_next: express.NextFunction,
		) => {
			if ((err as Error & { type?: string }).type === "entity.too.large") {
				res.status(413).json({
					error: {
						code: "FILE_TOO_LARGE",
						message: "File exceeds maximum size of 1 MB",
					},
				});
				return;
			}

			res.status(500).json({
				error: { code: "INTERNAL_ERROR", message: err.message },
			});
		},
	);

	return app;
}
