import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  createMission,
  initDatabase,
  recordTaskCompleted,
  recordTaskStarted,
} from "../database.js";
import type { CrewMemberConfig } from "../fleet-config.js";
import type { SlashCommand } from "../slash-commands.js";
import { startTestServer, type TestServer } from "../testing/http.js";
import { createStatusRouter, type StatusRouterDeps } from "./status.js";

// Mounts the router on a real HTTP server and calls it with fetch. The ship composition and running state are fakes, and the DB is in-memory.
function member(name: string, provider?: string): CrewMemberConfig {
  return { name, rank: "crew", provider, acp_agent: name, cwd: "/ship", rules: [], skills: [], additionalDirectories: [] };
}

let server: TestServer;
let deps: StatusRouterDeps;
// A fake of the running state. The state is changed per test.
let busy: (role: string, missionId?: string) => boolean;
let running: (role: string) => boolean;
let currentTask: (role: string, missionId?: string) => string | undefined;
let contextPercent: (role: string, missionId: string) => number | undefined;
let commands: (role: string, missionId: string) => SlashCommand[];
let commandsLive: (role: string, missionId: string) => boolean;
let iconUrl: (role: string) => string | undefined;
let sessionPhase: (role: string, missionId?: string) => "starting" | "restarting" | undefined;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initDatabase({ path: ":memory:", agentToRole: (agent) => agent });
  createMission("m1", "Test");
  busy = () => false;
  running = () => false;
  currentTask = () => undefined;
  contextPercent = () => undefined;
  commands = () => [];
  commandsLive = () => false;
  iconUrl = () => undefined;
  sessionPhase = () => undefined;
  deps = {
    crew: {
      first_officer: member("Alex", "claude"),
      chief_engineer: member("Sam"),
      ensign: member("Jo"),
    },
    shipName: "USS Test",
    shipId: "test-ship",
    defaultProvider: "kiro",
    language: () => "en",
    crewLanguage: () => "ja",
    bridge: { isAgentBusy: (role, missionId) => busy(role, missionId) },
    crewRunner: { isRunning: (role) => running(role), getCurrentTaskId: (role, missionId) => currentTask(role, missionId) },
    contextPercent: (role, missionId) => contextPercent(role, missionId),
    commands: (role, missionId) => commands(role, missionId),
    commandsLive: (role, missionId) => commandsLive(role, missionId),
    iconUrl: (role) => iconUrl(role),
    sessionPhase: (role, missionId) => sessionPhase(role, missionId),
    hosts: { localHostname: "bridge-pc", hostAddress: () => undefined, tunnelState: () => "idle" },
  };
  server = await startTestServer((app) => app.use(createStatusRouter(deps).router));
});
// Rebuilds the server after replacing deps.
async function rebuild(): Promise<TestServer> {
  await server.close();
  return startTestServer((app) => app.use(createStatusRouter(deps).router));
}

afterEach(async () => {
  await server.close();
  closeDatabase();
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("returns that it is running, and the state of each crew member based on the ship's composition", async () => {
    busy = (role) => role === "ensign";
    const { status, body } = await server.get("/api/health");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      agents: { first_officer: "idle", chief_engineer: "idle", ensign: "working" },
    });
    expect(typeof (body as { uptime: number }).uptime).toBe("number");
  });
});

describe("GET /api/config", () => {
  it("returns the ship name and the default partner (the commander if there is one, otherwise the first crew member). Not decided by role name", async () => {
    deps.crew.chief_engineer = { ...member("Sam"), rank: "commander" };
    expect((await server.get("/api/config")).body).toEqual({ defaultTarget: "chief_engineer", shipName: "USS Test", language: "en", crewLanguage: "ja" });
  });

  it("without a commander, the first crew member written is the default partner (even one named first_officer is not special-cased)", async () => {
    deps.crew = { engineer: member("Engineer"), first_officer: member("Alex") };
    server = await rebuild();
    expect(((await server.get("/api/config")).body as { defaultTarget: string }).defaultTarget).toBe("engineer");
  });
});

describe("GET /api/crew", () => {
  it("returns the ship's composition with only the items needed for display. The host is attached only to remote crew members", async () => {
    deps.crew.ensign = { ...member("Jo"), host: { name: "dock", destination: "me@secret-host" } };
    deps.hosts = { localHostname: "bridge-pc", hostAddress: () => "10.0.0.5", tunnelState: () => "idle" };
    server = await rebuild();

    const { body } = await server.get("/api/crew");
    expect(Object.keys(body as object)).toEqual(["first_officer", "chief_engineer", "ensign"]);
    expect(body).toMatchObject({
      first_officer: { name: "Alex", provider: "claude", acp_agent: "Alex" },
      ensign: { name: "Jo", host: { label: "dock", kind: "remote", address: "10.0.0.5" } },
    });
    expect((body as Record<string, object>).chief_engineer).not.toHaveProperty("host");
    // Settings themselves (cwd, destination) are not leaked
    expect(JSON.stringify(body)).not.toContain("secret-host");
    expect(JSON.stringify(body)).not.toContain("/ship");
  });
});

describe("GET /api/crew: icon", () => {
  it("attaches the image URL only to crew members that have an icon", async () => {
    iconUrl = (role) => (role === "chief_engineer" ? "/api/crew/chief_engineer/icon?v=1" : undefined);
    const { body } = await server.get("/api/crew");
    expect((body as Record<string, { icon?: string }>).chief_engineer.icon).toBe("/api/crew/chief_engineer/icon?v=1");
    expect(body as object).not.toHaveProperty("first_officer.icon");
  });
});

describe("the crew's running state", () => {
  it("working if in a conversation or running a task, idle otherwise", async () => {
    busy = (role) => role === "first_officer";
    running = (role) => role === "chief_engineer";

    const { body } = await server.get("/api/crew/status");
    expect(body).toEqual([
      {
        host: { label: "bridge-pc", kind: "local" },
        tunnel: null,
        crew: [
          { role: "first_officer", status: "working", unreportedCount: 0, contextPercent: null, commands: [], commandsLive: false },
          { role: "chief_engineer", status: "working", unreportedCount: 0, contextPercent: null, commands: [], commandsLive: false },
          { role: "ensign", status: "idle", unreportedCount: 0, contextPercent: null, commands: [], commandsLive: false },
        ],
      },
    ]);
  });

  it("starting and restarting are returned in preference to working (restarting > starting > working > idle)", async () => {
    busy = (role) => role === "first_officer" || role === "chief_engineer";
    sessionPhase = (role) => (role === "first_officer" ? "starting" : role === "chief_engineer" ? "restarting" : undefined);

    const { body } = await server.get("/api/crew/status?missionId=m1");
    const statuses = Object.fromEntries((body as Array<{ crew: Array<{ role: string; status: string }> }>)[0].crew.map((c) => [c.role, c.status]));
    expect(statuses).toEqual({ first_officer: "starting", chief_engineer: "restarting", ensign: "idle" });
  });

  it("returns the slash commands available in the conversation session per crew member, only when a mission is specified (empty if there is no session)", async () => {
    const context: SlashCommand = { name: "context", description: "Show context usage" };
    commands = (role, missionId) => (role === "chief_engineer" && missionId === "m1" ? [context] : []);

    const byRole = async (url: string) => {
      const { body } = await server.get(url);
      return Object.fromEntries((body as Array<{ crew: Array<{ role: string; commands: SlashCommand[] }> }>)[0].crew.map((c) => [c.role, c.commands]));
    };
    expect(await byRole("/api/crew/status?missionId=m1")).toEqual({ first_officer: [], chief_engineer: [context], ensign: [] });

    // Also returns per crew member whether the list is the latest one that arrived from the running session (if false, the previous list = the cache, or empty)
    commandsLive = (role) => role === "chief_engineer";
    const { body } = await server.get("/api/crew/status?missionId=m1");
    const live = Object.fromEntries((body as Array<{ crew: Array<{ role: string; commandsLive: boolean }> }>)[0].crew.map((c) => [c.role, c.commandsLive]));
    expect(live).toEqual({ first_officer: false, chief_engineer: true, ensign: false });
    // always false in an overview with no mission specified
    const overview = await server.get("/api/crew/status");
    expect((overview.body as Array<{ crew: Array<{ commandsLive: boolean }> }>)[0].crew.every((c) => c.commandsLive === false)).toBe(true);
    expect(await byRole("/api/crew/status")).toEqual({ first_officer: [], chief_engineer: [], ensign: [] });
  });

  it("returns the context usage of the conversation session per crew member, only when a mission is specified (null if there is no session)", async () => {
    contextPercent = (role, missionId) => (role === "chief_engineer" && missionId === "m1" ? 42.5 : undefined);

    const byRole = async (url: string) => {
      const { body } = await server.get(url);
      return Object.fromEntries((body as Array<{ crew: Array<{ role: string; contextPercent: number | null }> }>)[0].crew.map((c) => [c.role, c.contextPercent]));
    };
    expect(await byRole("/api/crew/status?missionId=m1")).toEqual({ first_officer: null, chief_engineer: 42.5, ensign: null });
    // not shown in an overview with no mission specified, because it is not decided which session's value it would be
    expect(await byRole("/api/crew/status")).toEqual({ first_officer: null, chief_engineer: null, ensign: null });
  });

  it("remote host crew members are returned grouped per host (with the tunnel state and connection target)", async () => {
    deps.crew.ensign = { ...member("Jo"), host: { name: "dock", destination: "dock" } };
    deps.hosts = {
      localHostname: "bridge-pc",
      hostAddress: (name) => (name === "dock" ? "127.0.0.1" : undefined),
      tunnelState: () => "connecting",
    };
    // deps.crew shares the same object, so it is reflected without recreating the router
    server = await rebuild();

    const { body } = await server.get("/api/crew/status");
    expect(body).toEqual([
      {
        host: { label: "bridge-pc", kind: "local" },
        tunnel: null,
        crew: [
          { role: "first_officer", status: "idle", unreportedCount: 0, contextPercent: null, commands: [], commandsLive: false },
          { role: "chief_engineer", status: "idle", unreportedCount: 0, contextPercent: null, commands: [], commandsLive: false },
        ],
      },
      {
        host: { label: "dock", kind: "remote", address: "127.0.0.1" },
        tunnel: "connecting",
        crew: [{ role: "ensign", status: "idle", unreportedCount: 0, contextPercent: null, commands: [], commandsLive: false }],
      },
    ]);
  });

  it("missionId is passed only for the conversation check, and the task-running check is done across all missions", async () => {
    const busySpy = vi.fn(() => false);
    const runningSpy = vi.fn(() => false);
    busy = busySpy;
    running = runningSpy;

    await server.get("/api/crew/status?missionId=m1");

    expect(busySpy).toHaveBeenCalledWith("ensign", "m1");
    expect(runningSpy).toHaveBeenCalledWith("ensign");
  });

  it("counts the unreported tasks per crew member. Can be narrowed by mission", async () => {
    createMission("m2", "other");
    recordTaskStarted("chief_engineer_0001", "m1", "chief_engineer", "a", "i", undefined, "first_officer");
    recordTaskCompleted("chief_engineer_0001", "m1", "r");
    recordTaskStarted("chief_engineer_0002", "m2", "chief_engineer", "b", "i", undefined, "first_officer");
    recordTaskCompleted("chief_engineer_0002", "m2", "r");

    const flat = (body: unknown) => (body as Array<{ crew: Array<{ role: string; unreportedCount: number }> }>).flatMap((g) => g.crew);
    const all = flat((await server.get("/api/crew/status")).body);
    expect(all.find((c) => c.role === "chief_engineer")?.unreportedCount).toBe(2);
    expect(all.find((c) => c.role === "first_officer")?.unreportedCount).toBe(0);

    const m1 = flat((await server.get("/api/crew/status?missionId=m1")).body);
    expect(m1.find((c) => c.role === "chief_engineer")?.unreportedCount).toBe(1);
  });
});

describe("GET /api/crew/:role/tasks", () => {
  it("a nonexistent role is 404. History is returned for any role (even one named first_officer)", async () => {
    expect((await server.get("/api/crew/nobody/tasks")).status).toBe(404);
    expect((await server.get("/api/crew/first_officer/tasks")).status).toBe(200);
  });

  it("if there is no running task, current is null. History is newest first", async () => {
    recordTaskStarted("ensign_0001", "m1", "ensign", "first", "i", undefined, "first_officer");
    recordTaskCompleted("ensign_0001", "m1", "r");
    recordTaskStarted("ensign_0002", "m1", "ensign", "second", "i", undefined, "first_officer");
    recordTaskCompleted("ensign_0002", "m1", "r");

    const { body } = (await server.get("/api/crew/ensign/tasks")) as { body: { current: unknown; history: Array<{ taskId: string }>; hasMore: boolean } };
    expect(body.current).toBeNull();
    expect(body.history.map((h) => h.taskId)).toEqual(["ensign_0002", "ensign_0001"]);
    expect(body.hasMore).toBe(false);
  });

  it("if there is a running task, its name is returned as current (narrowed by passing missionId)", async () => {
    recordTaskStarted("ensign_0003", "m1", "ensign", "running_task", "i", undefined, "first_officer");
    const spy = vi.fn(() => "ensign_0003");
    currentTask = spy;

    const { body } = (await server.get("/api/crew/ensign/tasks?missionId=m1")) as { body: { current: unknown } };
    expect(body.current).toEqual({ taskId: "ensign_0003", taskName: "running_task" });
    expect(spy).toHaveBeenCalledWith("ensign", "m1");
  });

  it("the count can be specified with limit, and hasMore is true if there are more. An invalid value gives the default 5", async () => {
    for (let i = 1; i <= 7; i++) {
      const id = `ensign_000${i}`;
      recordTaskStarted(id, "m1", "ensign", `t${i}`, "i", undefined, "first_officer");
      recordTaskCompleted(id, "m1", "r");
    }
    const two = (await server.get("/api/crew/ensign/tasks?limit=2")).body as { history: unknown[]; hasMore: boolean };
    expect(two.history).toHaveLength(2);
    expect(two.hasMore).toBe(true);

    for (const bad of ["abc", "0", "-3"]) {
      const body = (await server.get(`/api/crew/ensign/tasks?limit=${bad}`)).body as { history: unknown[]; hasMore: boolean };
      expect(body.history).toHaveLength(5);
      expect(body.hasMore).toBe(true);
    }
  });
});
