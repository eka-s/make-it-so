import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer } from "../testing/http.js";
import { createQuickActionsRouter } from "./quick-actions.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-qa-route-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("quick actions routes", () => {
  it("lists the defaults, then saves this ship's list", async () => {
    const server = await startTestServer((app) => app.use(createQuickActionsRouter({ dir, shipId: "s1" })));
    const first = await server.get("/api/quick-actions");
    expect((first.body as { actions: { id: string }[] }).actions.map((a) => a.id)).toEqual(["resume", "compact"]);

    const put = await server.send("PUT", "/api/quick-actions", { actions: [{ name: "Hello", kind: "message", command: "hello", send: "fill" }] });
    expect(put.status).toBe(200);
    expect((put.body as { actions: unknown[] }).actions).toMatchObject([{ name: "Hello", kind: "message", command: "hello", send: "fill", shared: false }]);
    await server.close();
  });

  it("answers 400 with errors by index, and 400 for a body without a list", async () => {
    const server = await startTestServer((app) => app.use(createQuickActionsRouter({ dir, shipId: "s1" })));
    const bad = await server.send("PUT", "/api/quick-actions", { actions: [{ name: "", kind: "message", command: "x" }] });
    expect(bad).toEqual({ status: 400, body: { error: "invalid", errors: { 0: "settings.error.quickName" } } });
    expect((await server.send("PUT", "/api/quick-actions", {})).status).toBe(400);
    await server.close();
  });

  it("answers 409 when the file is not valid YAML, and leaves it alone", async () => {
    fs.writeFileSync(path.join(dir, "quick-actions.yml"), "actions: [unclosed\n");
    const server = await startTestServer((app) => app.use(createQuickActionsRouter({ dir, shipId: "s1" })));
    expect((await server.get("/api/quick-actions")).status).toBe(409);
    expect((await server.send("PUT", "/api/quick-actions", { actions: [] })).status).toBe(409);
    expect(fs.readFileSync(path.join(dir, "quick-actions.yml"), "utf-8")).toBe("actions: [unclosed\n");
    await server.close();
  });
});
