import path from "node:path";
import express from "express";
import { simpleGit } from "simple-git";
import { fileRoutes } from "./routes/files.js";
import { sessionRoutes } from "./routes/sessions.js";
import type { SessionManager } from "./session.js";

export interface AppConfig {
	port: number;
	agentCommand: string;
	workingDir: string;
}

export function getConfig(): AppConfig {
	return {
		port: Number(process.env.PORT) || 3000,
		agentCommand: process.env.AGENT_COMMAND || "echo",
		workingDir: process.env.WORKING_DIR || process.cwd(),
	};
}

export function createApp(
	config: AppConfig,
	sessionManager?: SessionManager,
): express.Express {
	const app = express();

	app.use(express.json({ limit: "1mb" }));

	app.get("/api/health", async (_req, res) => {
		let gitRepo = false;
		try {
			const git = simpleGit(config.workingDir);
			gitRepo = await git.checkIsRepo();
		} catch {
			// Not a git repo
		}
		res.json({ status: "ok", gitRepo });
	});

	app.use("/api/files", fileRoutes(config.workingDir));

	if (sessionManager) {
		app.use("/api/sessions", sessionRoutes(sessionManager));
	}

	// Production: serve static files from client/dist
	const clientDist = path.resolve(
		import.meta.dirname,
		"..",
		"..",
		"client",
		"dist",
	);
	app.use(express.static(clientDist));

	// 404 handler for unmatched API routes
	app.all("/api/*", (_req, res) => {
		res.status(404).json({
			error: { code: "NOT_FOUND", message: "Endpoint not found" },
		});
	});

	// SPA fallback: serve index.html for client-side routes
	app.get("*", (_req, res) => {
		res.sendFile(path.join(clientDist, "index.html"));
	});

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
