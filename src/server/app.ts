import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { Request, Response } from "express";
import { createErrorHandler } from "./http-errors.js";
import { createLocalRequestGuard } from "./local-guard.js";
import { createSecurityHeaders } from "./security-headers.js";
import { logger } from "./logger.js";
import { addConnection } from "./sse-emitter.js";

/** What is needed to assemble the app. index.ts wires it in production; tests pass fakes. */
export type AppDeps = {
  /** Routers per feature, mounted at the root (each router owns its URLs). */
  routers: express.Router[];
  /** Router mounted at `/api/pins`. */
  pinsRouter: express.Router;
  /** Handler for `POST /mcp` (the bulletin-board MCP). */
  handleMcpRequest: (req: Request, res: Response) => Promise<void>;
  /**
   * Directory of the built client (`dist/client`). Only when given, the UI is served on the same port
   * (`npm start`). When omitted, it is not served (with `npm run dev`, Vite serves the UI and proxies the API).
   */
  clientDir?: string;
};

/**
 * Assembles the Express app. It does not listen on a port (the caller does),
 * so tests can start it on any port and call it over HTTP.
 */
export function createApp(deps: AppDeps): express.Express {
  const app = express();
  // The framework name is not told to anyone who asks.
  app.disable("x-powered-by");

  // cors() is not used here: the client only ever calls the relative path /api, and
  // Vite (vite.config.ts) in dev, or the static serving below with `npm start`, serves it from the same origin.
  // There is no legitimate cross-origin caller and this server has no authentication — a permissive CORS would let any web page
  // open in the same browser POST to /api/bridge/message and drive the commander (and indirectly crew members with file-write
  // permission).
  // First of all: refuse requests addressed to a non-local host name (DNS rebinding) or sent from another origin.
  app.use(createLocalRequestGuard());
  app.use(createSecurityHeaders());
  app.use(express.json({ limit: "1mb" }));

  // --- MCP bulletin board ---
  // Endpoint that crew sessions can call as typed tools instead of curl.
  // It is stateless, so it can be treated like any other API route.
  app.post("/mcp", (req, res) => {
    deps.handleMcpRequest(req, res).catch((error: unknown) => {
      logger.error("[MCP] Request handling failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    });
  });

  // --- SSE ---
  app.get("/api/events/bridge", (req, res) => {
    addConnection(res, "bridge");
  });

  app.get("/api/events", (req, res) => {
    addConnection(res, "all");
  });

  for (const router of deps.routers) app.use(router);

  // --- Pins ---
  app.use("/api/pins", deps.pinsRouter);

  // --- Serving the UI (the built client) ---
  // GET requests other than /api go to the UI's index.html. An undefined /api/... is not swallowed by the UI and stays a 404.
  if (deps.clientDir) {
    const indexHtml = path.join(deps.clientDir, "index.html");
    if (fs.existsSync(indexHtml)) {
      app.use(express.static(deps.clientDir));
      app.get(/^(?!\/(api|mcp)(\/|$)).*/, (_req, res) => {
        res.sendFile(indexHtml);
      });
    }
  }

  // --- Error handling ---
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (typeof err === "object" && err !== null && err instanceof SyntaxError && "status" in err && (err as { status: number }).status === 400 && "body" in err) {
      res.status(400).json({ error: "Invalid JSON in request body" });
      return;
    }
    next(err);
  });
  // Last of all: whatever else is thrown is a JSON answer, never an HTML page with a stack trace.
  app.use(createErrorHandler());

  return app;
}
