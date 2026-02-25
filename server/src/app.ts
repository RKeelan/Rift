import os from "node:os";
import path from "node:path";
import express from "express";
import { simpleGit } from "simple-git";
import { resolveRepo } from "./pathUtils.js";
import { fileRoutes } from "./routes/files.js";
import { gitRoutes } from "./routes/git.js";
import { sessionRoutes } from "./routes/sessions.js";
import type { SessionManager } from "./session.js";

export interface AppConfig {
	port: number;
	agentCommand: string;
	reposRoot: string;
	basePath: string;
}

export function getConfig(): AppConfig {
	const baseName = process.env.BASE_NAME;
	return {
		port: Number(process.env.PORT) || 3000,
		agentCommand: process.env.AGENT_COMMAND || "echo",
		reposRoot: process.env.REPOS_ROOT || path.join(os.homedir(), "Src"),
		basePath: baseName ? `/${baseName}` : "",
	};
}

export function createApp(
	config: AppConfig,
	sessionManager?: SessionManager,
): express.Express {
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

	if (sessionManager) {
		router.use("/api/sessions", sessionRoutes(sessionManager));
	}

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

	// Mount router at base path (e.g. "/rift" or "/" for dev)
	app.use(config.basePath || "/", router);

	// Redirect root to base path for convenience
	if (config.basePath) {
		app.get("/", (_req, res) => {
			res.redirect(config.basePath);
		});
	}

	// Catch-all error handler
	app.use(
		(
			err: Error,
			_req: express.Request,
			res: express.Response,
			_next: express.NextFunction,
		) => {
			res.status(500).json({
				error: { code: "INTERNAL_ERROR", message: err.message },
			});
		},
	);

	return app;
}
