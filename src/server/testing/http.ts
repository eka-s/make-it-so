import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

/**
 * HTTP server for tests. Starts the given router (or app) on a free port
 * so it can be called with Node's built-in fetch. JSON body parsing uses the same settings as production.
 */
export type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
  /** Fetches JSON from the given path. */
  get: (path: string) => Promise<{ status: number; body: unknown }>;
  /** Sends JSON with POST/PATCH/DELETE. */
  send: (method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
};

export async function startTestServer(mount: (app: express.Express) => void): Promise<TestServer> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  mount(app);
  return serveApp(app);
}

/** Starts an already assembled app (such as the result of createApp()) on a free port as is. */
export async function serveApp(app: express.Express): Promise<TestServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  return {
    baseUrl,
    get: (path) => request("GET", path),
    send: (method, path, body) => request(method, path, body),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
