import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivityHandler } from "../bridge-activity.js";
import { listPending, registerPermission, resolvePermission } from "../permission-registry.js";
import { startTestServer, type TestServer } from "../testing/http.js";
import type { PendingPermission } from "../types.js";
import { createPermissionsRouter } from "./permissions.js";

let server: TestServer;
let respondToPermission: ReturnType<typeof vi.fn>;

function pending(key: string, overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    key,
    scope: "chief_engineer",
    missionId: "m1",
    requestId: 7,
    toolName: "Write",
    toolInput: {},
    options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }],
    receivedAt: "2026-11-07T00:00:00.000Z",
    ...overrides,
  } as PendingPermission;
}

beforeEach(async () => {
  respondToPermission = vi.fn(() => true);
  server = await startTestServer((app) => app.use(createPermissionsRouter({ crewManager: { respondToPermission } })));
});
afterEach(async () => {
  await server.close();
  // It is a module-level registry, so everything left over is resolved to empty it
  for (const p of listPending()) resolvePermission(p.key);
  setActivityHandler("m1", null);
});

describe("GET /api/permissions", () => {
  it("returns the list of pending requests (empty if none)", async () => {
    expect((await server.get("/api/permissions")).body).toEqual({ permissions: [] });
    registerPermission(pending("k1"));
    const { body } = await server.get("/api/permissions");
    expect((body as { permissions: PendingPermission[] }).permissions.map((p) => p.key)).toEqual(["k1"]);
  });
});

describe("POST /api/permissions/:key/respond", () => {
  it("400 if there is no optionId", async () => {
    registerPermission(pending("k1"));
    const { status, body } = await server.send("POST", "/api/permissions/k1/respond", {});
    expect(status).toBe(400);
    expect(body).toEqual({ error: "optionId is required" });
    expect(listPending()).toHaveLength(1); // not resolved
  });

  it("409 when the answer reached nothing (the session is gone): the entry is removed and ok is not reported", async () => {
    respondToPermission.mockReturnValue(false);
    registerPermission(pending("k1"));
    const { status, body } = await server.send("POST", "/api/permissions/k1/respond", { optionId: "allow-once" });
    expect(status).toBe(409);
    expect(body).toEqual({ status: "undeliverable" });
    expect(listPending()).toEqual([]);
  });

  it("responding to a pending request reaches the session it came from (crew member, mission, requestId) and removes it from the list", async () => {
    registerPermission(pending("k1"));
    const { status, body } = await server.send("POST", "/api/permissions/k1/respond", { optionId: "allow-once" });
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
    expect(respondToPermission).toHaveBeenCalledWith("chief_engineer", "m1", 7, "allow-once");
    expect(listPending()).toEqual([]);
  });

  it("a response extends the idle timer of that mission's turn (a slow approval is not treated as a hang)", async () => {
    const bump = vi.fn();
    setActivityHandler("m1", bump);
    registerPermission(pending("k1"));
    await server.send("POST", "/api/permissions/k1/respond", { optionId: "allow-once" });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it("a nonexistent or already resolved key is 404 (idempotent — a double click does not deliver twice)", async () => {
    registerPermission(pending("k1"));
    await server.send("POST", "/api/permissions/k1/respond", { optionId: "allow-once" });
    respondToPermission.mockClear();

    const again = await server.send("POST", "/api/permissions/k1/respond", { optionId: "allow-once" });
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ status: "not_found" });
    expect((await server.send("POST", "/api/permissions/nope/respond", { optionId: "x" })).status).toBe(404);
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it("requests of the same crew member in different missions each reach their own mission's session", async () => {
    registerPermission(pending("k1", { missionId: "m1", requestId: 1 }));
    registerPermission(pending("k2", { missionId: "m2", requestId: 2 }));
    await server.send("POST", "/api/permissions/k2/respond", { optionId: "reject" });
    expect(respondToPermission).toHaveBeenCalledWith("chief_engineer", "m2", 2, "reject");
    expect(listPending().map((p) => p.key)).toEqual(["k1"]);
  });
});
