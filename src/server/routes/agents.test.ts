import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, createMission, initDatabase } from "../database.js";
import { startTestServer, type TestServer } from "../testing/http.js";
import { createAgentsRouter, type AgentsRouterDeps } from "./agents.js";

let server: TestServer;
let calls: string[];
let deps: AgentsRouterDeps;
let busy: boolean;
let running: boolean;
let restartFails: Error | null;
let phase: "starting" | "restarting" | undefined;
let debug: boolean;
const armErrorSimulation = vi.fn();

async function start(): Promise<void> {
  deps = {
    crew: { first_officer: {}, chief_engineer: {}, ensign: {} },
    agentStatus: (role) => (role === "ensign" ? "working" : "idle"),
    bridge: { isAgentBusy: () => busy, armErrorSimulation },
    crewRunner: { isRunning: () => running, getCurrentTaskId: (role) => (role === "ensign" ? "ensign_0001" : undefined) },
    crewManager: {
      restartSession: async (role, mission) => {
        calls.push(`restart:${role}:${mission}`);
        if (restartFails) throw restartFails;
      },
      sessionPhase: () => phase,
    },
    debug,
  };
  server = await startTestServer((app) => app.use(createAgentsRouter(deps)));
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  initDatabase({ path: ":memory:", agentToRole: (agent) => agent });
  createMission("m1", "Test");
  calls = [];
  phase = undefined;
  busy = false;
  running = false;
  restartFails = null;
  debug = false;
  armErrorSimulation.mockClear();
});
afterEach(async () => {
  await server.close();
  closeDatabase();
  vi.restoreAllMocks();
});

describe("GET /api/agents", () => {
  it("returns the running state and the running task ID for every crew member of the ship's composition (null if none)", async () => {
    await start();
    const { status, body } = await server.get("/api/agents");
    expect(status).toBe(200);
    expect(body).toEqual([
      { name: "first_officer", status: "idle", currentTaskId: null },
      { name: "chief_engineer", status: "idle", currentTaskId: null },
      { name: "ensign", status: "working", currentTaskId: "ensign_0001" },
    ]);
  });
});

describe("POST /api/agents/:role/restart", () => {
  beforeEach(start);

  it("requests rebuilding of the session (the default mission if not specified)", async () => {
    const { status, body } = await server.send("POST", "/api/agents/chief_engineer/restart", {});
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok", message: "chief_engineer restarted successfully" });
    expect(calls).toEqual(["restart:chief_engineer:bridge"]);
  });

  it("it is the session of the missionId in the body that is restarted", async () => {
    await server.send("POST", "/api/agents/chief_engineer/restart", { missionId: "m1" });
    expect(calls).toContain("restart:chief_engineer:m1");
  });

  it("a nonexistent role or mission is 404 (nothing is done)", async () => {
    const role = await server.send("POST", "/api/agents/nobody/restart", {});
    expect(role.status).toBe(404);
    expect(role.body).toEqual({ error: "Unknown role" });
    const mission = await server.send("POST", "/api/agents/chief_engineer/restart", { missionId: "nope" });
    expect(mission.status).toBe(404);
    expect(mission.body).toEqual({ error: "Unknown mission" });
    expect(calls).toEqual([]);
  });

  it("409 while running a task or in a conversation (no restart and no notification)", async () => {
    running = true;
    const a = await server.send("POST", "/api/agents/chief_engineer/restart", {});
    expect(a.status).toBe(409);
    expect(a.body).toEqual({ error: "agent_busy", message: "This crew member is busy. Restart it after it has finished." });

    running = false;
    busy = true;
    expect((await server.send("POST", "/api/agents/chief_engineer/restart", {})).status).toBe(409);
    expect(calls).toEqual([]);
  });

  it("a crew member that is starting or restarting is 409 (no overlapping restart)", async () => {
    phase = "starting";
    expect((await server.send("POST", "/api/agents/chief_engineer/restart", {})).status).toBe(409);
    phase = "restarting";
    expect((await server.send("POST", "/api/agents/chief_engineer/restart", {})).status).toBe(409);
    expect(calls).toEqual([]);
  });

  it("if the rebuild fails, 500 with the reason", async () => {
    restartFails = new Error("cannot start");
    const { status, body } = await server.send("POST", "/api/agents/chief_engineer/restart", {});
    expect(status).toBe(500);
    expect(body).toEqual({ error: "cannot start" });
  });
});

describe("POST /api/debug/simulate-error", () => {
  it("if debug is disabled, 404 (no error simulation is set up)", async () => {
    debug = false;
    await start();
    const { status, body } = await server.send("POST", "/api/debug/simulate-error");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not found" });
    expect(armErrorSimulation).not.toHaveBeenCalled();
  });

  it("if debug is enabled, set it up to cause an error at the next prompt", async () => {
    debug = true;
    await start();
    const { status, body } = await server.send("POST", "/api/debug/simulate-error");
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok" });
    expect(armErrorSimulation).toHaveBeenCalledTimes(1);
  });
});
