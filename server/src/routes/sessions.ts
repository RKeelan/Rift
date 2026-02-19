import { Router } from "express";
import type { SessionManager } from "../session.js";

export function sessionRoutes(sessionManager: SessionManager): Router {
	const router = Router();

	router.post("/", async (req, res) => {
		const workingDirectory =
			req.body.workingDirectory || process.env.WORKING_DIR || process.cwd();
		try {
			const session = await sessionManager.createSession(workingDirectory);
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
