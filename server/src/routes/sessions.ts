import { Router } from "express";
import { resolveRepo } from "../pathUtils.js";
import type { SessionManager } from "../session.js";

export function sessionRoutes(
	sessionManager: SessionManager,
	reposRoot: string,
): Router {
	const router = Router();

	router.post("/", async (req, res) => {
		const repo = req.body.repo;
		if (!repo || typeof repo !== "string") {
			res.status(400).json({
				error: { code: "BAD_REQUEST", message: "Missing required field: repo" },
			});
			return;
		}

		const result = await resolveRepo(reposRoot, repo);
		if (!result.ok) {
			const status = result.reason === "forbidden" ? 400 : 404;
			const code = result.reason === "forbidden" ? "BAD_REQUEST" : "NOT_FOUND";
			const message =
				result.reason === "forbidden"
					? "Invalid repo name"
					: "Repository not found";
			res.status(status).json({ error: { code, message } });
			return;
		}

		try {
			const session = await sessionManager.createSession(repo, result.path);
			res.status(201).json(session);
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Failed to create session";
			res.status(500).json({
				error: { code: "ADAPTER_SPAWN_FAILED", message },
			});
		}
	});

	router.get("/", (_req, res) => {
		res.json(sessionManager.listSessions());
	});

	router.get("/:id", (req, res) => {
		const session = sessionManager.getSession(req.params.id);
		if (!session) {
			res.status(404).json({
				error: { code: "NOT_FOUND", message: "Session not found" },
			});
			return;
		}
		res.json(session);
	});

	router.delete("/:id", (req, res) => {
		const stopped = sessionManager.stopSession(req.params.id);
		if (!stopped) {
			res.status(404).json({
				error: { code: "NOT_FOUND", message: "Session not found" },
			});
			return;
		}
		const session = sessionManager.getSession(req.params.id);
		res.json(session);
	});

	return router;
}
