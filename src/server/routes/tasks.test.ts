import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, createMission, initDatabase, recordTaskCompleted, recordTaskError, recordTaskStarted } from "../database.js";
import { startTestServer, type TestServer } from "../testing/http.js";
import { createTasksRouter } from "./tasks.js";

let server: TestServer;
let cancel: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initDatabase({ path: ":memory:", agentToRole: (agent) => agent });
  createMission("m1", "Test");
  cancel = vi.fn(() => true);
  server = await startTestServer((app) => app.use(createTasksRouter({ crewRunner: { cancel } })));
});
afterEach(async () => {
  await server.close();
  closeDatabase();
  vi.restoreAllMocks();
});

describe("GET /api/results/:taskId", () => {
  it("returns the details (instruction, result) of a completed task", async () => {
    recordTaskStarted("sam_0001", "m1", "sam", "fix_bug", "fix it", undefined, "first_officer");
    recordTaskCompleted("sam_0001", "m1", "fixed");
    const { status, body } = await server.get("/api/results/sam_0001");
    expect(status).toBe(200);
    expect(body).toMatchObject({ text: "fixed", status: "done", taskName: "fix_bug", instruction: "fix it" });
  });

  it("also returns the details of a task that ended in an error", async () => {
    recordTaskStarted("sam_0002", "m1", "sam", "x", "i", undefined, "first_officer");
    recordTaskError("sam_0002", "m1", null, "failed");
    const { status, body } = await server.get("/api/results/sam_0002");
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "error", taskName: "x" });
    expect(JSON.stringify(body)).toContain("failed");
  });

  it("a nonexistent taskId is 404", async () => {
    const { status, body } = await server.get("/api/results/nope_0001");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not found" });
  });

  it("a taskId containing anything other than alphanumerics, underscore, and hyphen is 400 (the DB is not queried)", async () => {
    for (const bad of ["a.b", "a%20b", "a%2Fb", "a%3Bb"]) {
      const { status, body } = await server.get(`/api/results/${bad}`);
      expect(status).toBe(400);
      expect(body).toEqual({ error: "Invalid taskId" });
    }
  });
});

describe("POST /api/crew/:taskId/cancel", () => {
  it("conveys the cancellation of the given task to CrewRunner", async () => {
    const { status, body } = await server.send("POST", "/api/crew/sam_0001/cancel");
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
    expect(cancel).toHaveBeenCalledWith("sam_0001");
  });
});
