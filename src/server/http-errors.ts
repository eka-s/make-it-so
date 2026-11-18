import type { ErrorRequestHandler } from "express";
import { logger } from "./logger.js";

// Express 4 does not catch what an async route handler throws: it becomes an unhandled rejection and Node ends the process. A route
// that awaits something is written `(req, res, next) => { void (async () => { ... })().catch(next); }`, which hands the error to the
// error handler below. The handler is the last middleware of every app: it answers JSON (never an HTML page with a stack trace)
// and logs the details on the server.

export function createErrorHandler(): ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    // Errors the framework itself raises for a bad request (malformed JSON, a body that is too large) carry a 4xx status.
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: "invalid_request", message: err instanceof Error ? err.message : "Bad request" });
      return;
    }
    logger.error("[HTTP] Request failed:", err);
    res.status(500).json({ error: "failed", message: "Internal server error" });
  };
}
