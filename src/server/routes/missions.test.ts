import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MISSION_ID, closeDatabase, initDatabase } from "../database.js";
import { startTestServer, type TestServer } from "../testing/http.js";
import { createMissionsRouter } from "./missions.js";
import { resolveMissionId } from "./mission-id.js";

type MissionJson = { id: string; name: string; archivedAt: string | null };

let server: TestServer;
beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initDatabase({ path: ":memory:", agentToRole: (agent) => agent });
  server = await startTestServer((app) => app.use(createMissionsRouter()));
});
afterEach(async () => {
  await server.close();
  closeDatabase();
  vi.restoreAllMocks();
});

describe("GET /api/missions", () => {
  it("the default mission (bridge) is included from the start", async () => {
    const { status, body } = await server.get("/api/missions");
    expect(status).toBe(200);
    expect((body as MissionJson[]).map((m) => m.id)).toContain(DEFAULT_MISSION_ID);
  });
});

describe("POST /api/missions: the ID", () => {
  it("an ID that is too long, starts with a symbol (such as the task-running scope prefix) or has odd characters is 400", async () => {
    for (const id of ["__tasks__:m1", "-x", "a b", "a/b", "x".repeat(65), "日本語"]) {
      expect((await server.send("POST", "/api/missions", { name: "n", id })).status, id).toBe(400);
    }
  });

  it("an issue-style ID is accepted as is", async () => {
    expect((await server.send("POST", "/api/missions", { name: "n", id: "PROJ-123" })).status).toBe(201);
  });
});

describe("POST /api/missions", () => {
  it("specifying a name creates it with 201, and the id is assigned automatically", async () => {
    const { status, body } = await server.send("POST", "/api/missions", { name: "New mission" });
    expect(status).toBe(201);
    expect(body).toMatchObject({ name: "New mission", archivedAt: null });
    expect((body as MissionJson).id).toMatch(/^m\d+$/);
    const list = (await server.get("/api/missions")).body as MissionJson[];
    expect(list.map((m) => m.name)).toContain("New mission");
  });

  it("whitespace around the name is trimmed. The id can be specified explicitly (a workflow of using an issue ID as is)", async () => {
    const { body } = await server.send("POST", "/api/missions", { id: " ISSUE-42 ", name: "  Issue 42  " });
    expect(body).toMatchObject({ id: "ISSUE-42", name: "Issue 42" });
  });

  it.each([
    ["name is missing", {}],
    ["name is only whitespace", { name: "   " }],
    ["name is not a string", { name: 123 }],
  ])("400 when %s", async (_label, payload) => {
    const { status, body } = await server.send("POST", "/api/missions", payload);
    expect(status).toBe(400);
    expect(body).toEqual({ error: "name is required" });
  });

  it("an id that already exists is 409", async () => {
    await server.send("POST", "/api/missions", { id: "dup", name: "a" });
    const { status, body } = await server.send("POST", "/api/missions", { id: "dup", name: "b" });
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'Mission "dup" already exists' });
  });
});

describe("PATCH /api/missions/:id", () => {
  it("archiving sets archivedAt, and restoring clears it (it stays in the list)", async () => {
    await server.send("POST", "/api/missions", { id: "m1", name: "x" });

    const archived = await server.send("PATCH", "/api/missions/m1", { archived: true });
    expect(archived.status).toBe(200);
    expect((archived.body as MissionJson).archivedAt).not.toBeNull();
    expect(((await server.get("/api/missions")).body as MissionJson[]).map((m) => m.id)).toContain("m1");

    const restored = await server.send("PATCH", "/api/missions/m1", { archived: false });
    expect((restored.body as MissionJson).archivedAt).toBeNull();
  });

  it("400 if archived is not a boolean", async () => {
    await server.send("POST", "/api/missions", { id: "m1", name: "x" });
    for (const archived of ["true", 1, undefined]) {
      const { status, body } = await server.send("PATCH", "/api/missions/m1", { archived });
      expect(status).toBe(400);
      expect(body).toEqual({ error: "archived must be a boolean" });
    }
  });

  it("a nonexistent mission is 404", async () => {
    const { status, body } = await server.send("PATCH", "/api/missions/nope", { archived: true });
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Mission "nope" not found' });
  });
});

describe("resolveMissionId", () => {
  beforeEach(async () => {
    await server.send("POST", "/api/missions", { id: "m1", name: "x" });
  });

  it("when unspecified, empty, or not a string, the default mission (for callers unaware of missions)", () => {
    expect(resolveMissionId(undefined)).toBe(DEFAULT_MISSION_ID);
    expect(resolveMissionId(null)).toBe(DEFAULT_MISSION_ID);
    expect(resolveMissionId({})).toBe(DEFAULT_MISSION_ID);
    expect(resolveMissionId({ missionId: "" })).toBe(DEFAULT_MISSION_ID);
    expect(resolveMissionId({ missionId: 5 })).toBe(DEFAULT_MISSION_ID);
  });

  it("the ID if it is an existing mission, undefined if it does not exist (the caller turns that into a 404)", () => {
    expect(resolveMissionId({ missionId: "m1" })).toBe("m1");
    expect(resolveMissionId({ missionId: "nope" })).toBeUndefined();
  });
});
