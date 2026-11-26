import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Request, Response } from "express";
import { createLocalRequestGuard } from "./local-guard.js";
import { logger } from "./logger.js";

/** Handler for `POST /mcp` (the bulletin-board MCP). */
export type McpRequestHandler = (req: Request, res: Response) => Promise<void>;

export type McpListener = {
  /** The port the OS gave this listener. Sessions and reverse tunnels need it before the board's own dependencies exist. */
  port: number;
  /** Starts answering `/mcp` calls with `handler`. Until then they get 503. */
  serve: (handler: McpRequestHandler) => void;
  close: () => Promise<void>;
};

/**
 * Opens the listener that only the bulletin-board MCP uses: loopback only (whatever `server.host` says) and on a port the OS picks, so
 * that no browser page or other client of the UI's port can reach it, and nothing can guess where it is.
 */
export async function openMcpListener(): Promise<McpListener> {
  let handler: McpRequestHandler | null = null;

  const app = express();
  app.disable("x-powered-by");
  app.use(createLocalRequestGuard());
  // A memo of 1 MB or more is accepted with a warning (see memory-store.ts), and JSON escaping makes the request bigger than the memo.
  app.use(express.json({ limit: "8mb" }));
  // It is stateless, so it can be treated like any other API route.
  app.post("/mcp", (req, res) => {
    if (!handler) {
      res.status(503).json({ error: "starting" });
      return;
    }
    handler(req, res).catch((error: unknown) => {
      logger.error("[MCP] Request handling failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    port,
    serve: (next) => { handler = next; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
