import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_AGENT_HEADER, MCP_MISSION_HEADER, MCP_TOKEN_HEADER } from "./crew-manager.js";
import { createBoardServer, createMcpHandler, type McpBoardDeps } from "./mcp-board.js";
import {
  closeDatabase,
  createMission,
  initDatabase,
  recordTaskCompleted,
  recordTaskStarted,
} from "./database.js";
import { taskSessionScope } from "./crew-runner.js";

// Calls the bulletin-board MCP's tools by connecting an MCP client directly. The DB is in-memory, and
// CrewRunner and the notification to the bridge are fakes.
const names: Record<string, string> = { chief_engineer: "Sam", sam: "Sam" };
// The ship's composition (role → rank). The caller's identifying name may be a role name or an acp_agent name (sam is another name for chief_engineer).
const roles: Record<string, string> = { first_officer: "first_officer", chief_engineer: "chief_engineer", sam: "chief_engineer", ensign: "ensign" };
let ranks: Record<string, "commander" | "chief" | "crew">;
let dispatch: ReturnType<typeof vi.fn>;
let recordUnreportedFetch: ReturnType<typeof vi.fn>;
let uiStateOf: ReturnType<typeof vi.fn>;
let recordUi: ReturnType<typeof vi.fn>;
let skillBodies: Record<string, Record<string, string>>;
let currentTurn: ReturnType<typeof vi.fn>;
let deps: McpBoardDeps;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  initDatabase({ path: ":memory:", agentToRole: (agent) => agent });
  createMission("m1", "Test");
  dispatch = vi.fn();
  recordUnreportedFetch = vi.fn();
  uiStateOf = vi.fn(() => undefined); // the reply has no form yet
  recordUi = vi.fn();
  skillBodies = { chief_engineer: { deploy: "# Deploy\nRun it." } };
  currentTurn = vi.fn(() => ({ turnId: "turn-1", agentName: "first_officer" })); // the turn of `caller`
  ranks = { first_officer: "commander", chief_engineer: "chief", ensign: "crew" };
  deps = {
    token: "test-token",
    crewRunner: { dispatch },
    recordUnreportedFetch,
    displayName: (agentDir) => names[agentDir] ?? agentDir,
    roleOf: (agent) => roles[agent],
    rankOf: (role) => ranks[role],
    skillsOf: (role) => ({ names: Object.keys(skillBodies[role] ?? {}), read: (name) => skillBodies[role]?.[name] }),
    currentTurn,
    uiStateOf,
    recordUi,
  };
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  closeDatabase();
  vi.restoreAllMocks();
});

/** Creates an MCP client connected to the server dedicated to the caller (`caller`). */
async function connect(caller?: { agent: string; missionId: string }): Promise<Client> {
  const server = createBoardServer(deps, caller);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return client;
}

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { text: result.content.map((c) => c.text ?? "").join(""), isError: result.isError === true };
}

const caller = { agent: "first_officer", missionId: "m1" };

describe("list of tools", () => {
  it("exposes the tools of the bulletin board", async () => {
    const client = await connect(caller);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["dispatch_task", "get_skill", "get_task", "list_unreported_tasks", "render_ui"]);
  });
});

describe("list_unreported_tasks", () => {
  it("if the caller cannot be identified, returns an error (no guessing)", async () => {
    const client = await connect(undefined);
    const result = await call(client, "list_unreported_tasks");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("the caller could not be identified");
    expect(recordUnreportedFetch).not.toHaveBeenCalled();
  });

  it("if nothing is unreported, says so and records an empty list", async () => {
    const client = await connect(caller);
    const result = await call(client, "list_unreported_tasks");
    expect(result.text).toBe("There are no unreported tasks.");
    expect(recordUnreportedFetch).toHaveBeenCalledWith(caller, []);
  });

  it("returns the completed tasks as formatted text of display name, taskId, name, and result, and records the returned taskIds", async () => {
    recordTaskStarted("sam_0001", "m1", "sam", "fix_bug", "fix it", undefined, "first_officer");
    recordTaskCompleted("sam_0001", "m1", "fixed");
    const client = await connect(caller);

    const result = await call(client, "list_unreported_tasks");

    expect(result.text).toBe("## Sam: sam_0001 (fix_bug)\nfixed");
    expect(recordUnreportedFetch).toHaveBeenCalledWith(caller, ["sam_0001"]);
  });

  it("returns only those of its own mission", async () => {
    createMission("m2", "other");
    recordTaskStarted("sam_0001", "m1", "sam", "a", "i", undefined, "first_officer");
    recordTaskCompleted("sam_0001", "m1", "r1");
    recordTaskStarted("sam_0002", "m2", "sam", "b", "i", undefined, "first_officer");
    recordTaskCompleted("sam_0002", "m2", "r2");

    const client = await connect({ agent: "first_officer", missionId: "m2" });
    const result = await call(client, "list_unreported_tasks");
    expect(result.text).toContain("sam_0002");
    expect(result.text).not.toContain("sam_0001");
  });

  it("a call from a task-running scope (__tasks__:{mission}) is treated as the original mission", async () => {
    recordTaskStarted("sam_0001", "m1", "sam", "a", "i", undefined, "first_officer");
    recordTaskCompleted("sam_0001", "m1", "r");
    const client = await connect({ agent: "first_officer", missionId: taskSessionScope("m1") });
    const result = await call(client, "list_unreported_tasks");
    expect(result.text).toContain("sam_0001");
  });
});

describe("dispatch_task", () => {
  it("if the caller cannot be identified, no task is issued and an error is returned", async () => {
    const client = await connect(undefined);
    const result = await call(client, "dispatch_task", { agent: "sam", task_name: "x", instruction: "y" });
    expect(result.isError).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("assigns a taskId and puts it in the run queue with a short notice (the full instruction is not included)", async () => {
    const client = await connect(caller);
    const result = await call(client, "dispatch_task", { agent: "sam", task_name: "fix_bug", instruction: "Fix the login" });

    expect(result.isError).toBe(false);
    expect(result.text).toBe("Delegated task chief_engineer_0001 to Sam.");
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0][0];
    expect(event).toMatchObject({
      agent: "chief_engineer",
      taskId: "chief_engineer_0001",
      missionId: "m1",
      originalName: "fix_bug",
      content: "Fix the login",
      dispatchedBy: "first_officer",
    });
    expect(event.livePrompt).toContain("chief_engineer_0001");
    expect(event.livePrompt).toContain("get_task");
    expect(event.livePrompt).not.toContain("Fix the login");
  });

  it("canonicalises the assignee to its role: the role name and the acp_agent name reach the same crew member and queue", async () => {
    const client = await connect(caller);
    await call(client, "dispatch_task", { agent: "chief_engineer", task_name: "a", instruction: "i" });
    await call(client, "dispatch_task", { agent: "sam", task_name: "b", instruction: "i" });
    expect(dispatch.mock.calls.map((c) => c[0].agent)).toEqual(["chief_engineer", "chief_engineer"]);
  });

  it("refuses an assignee that is not a crew member, creating no task and no counter (a name is never used as a path)", async () => {
    const client = await connect(caller);
    for (const agent of ["nobody", "../../outside", "chief_engineer/../x", ""]) {
      const result = await call(client, "dispatch_task", { agent, task_name: "a", instruction: "i" });
      expect(result.isError, agent).toBe(true);
      expect(result.text).toContain("not a crew member");
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("takes the turn that is issuing the task at dispatch time, and passes it on (a queued task starts long after the turn)", async () => {
    deps.currentTurnId = (missionId) => (missionId === "m1" ? "turn-42" : undefined);
    const client = await connect(caller);
    await call(client, "dispatch_task", { agent: "sam", task_name: "a", instruction: "i" });
    expect(dispatch.mock.calls[0][0].turnId).toBe("turn-42");
  });

  it("issuing consecutively increases the taskId", async () => {
    const client = await connect(caller);
    await call(client, "dispatch_task", { agent: "sam", task_name: "a", instruction: "i" });
    await call(client, "dispatch_task", { agent: "sam", task_name: "b", instruction: "i" });
    expect(dispatch.mock.calls.map((c) => c[0].taskId)).toEqual(["chief_engineer_0001", "chief_engineer_0002"]);
  });

  it("when issued by a crew member running a task, it is attributed to the original mission", async () => {
    const client = await connect({ agent: "chief_engineer", missionId: taskSessionScope("m1") });
    await call(client, "dispatch_task", { agent: "sam", task_name: "a", instruction: "i" });
    expect(dispatch.mock.calls[0][0].missionId).toBe("m1");
  });
});

describe("dispatch_task: authority by rank", () => {
  const dispatchAs = async (agent: string) => {
    const client = await connect({ agent, missionId: "m1" });
    return call(client, "dispatch_task", { agent: "sam", task_name: "x", instruction: "y" });
  };

  it("commanders and chiefs can issue. The issuer is recorded as the caller's role (a role even when called by an acp_agent name)", async () => {
    expect((await dispatchAs("first_officer")).isError).toBe(false);
    expect((await dispatchAs("sam")).isError).toBe(false);
    expect(dispatch.mock.calls.map((c) => c[0].dispatchedBy)).toEqual(["first_officer", "chief_engineer"]);
  });

  it("crew cannot issue (no task is created). Decided by rank, not by role name", async () => {
    const result = await dispatchAs("ensign");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("your rank does not allow you to delegate tasks");
    expect(dispatch).not.toHaveBeenCalled();

    // even one named first_officer cannot issue if its rank is crew
    ranks.first_officer = "crew";
    expect((await dispatchAs("first_officer")).isError).toBe(true);
    // a caller that is not on the ship cannot issue either
    expect((await dispatchAs("stranger")).isError).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("list_unreported_tasks: what is visible by rank", () => {
  beforeEach(() => {
    recordTaskStarted("a_0001", "m1", "sam", "by_lead", "i", undefined, "first_officer");
    recordTaskCompleted("a_0001", "m1", "r1");
    recordTaskStarted("a_0002", "m1", "ensign", "by_chief", "i", undefined, "chief_engineer");
    recordTaskCompleted("a_0002", "m1", "r2");
  });

  it("the commander can see everything, whoever issued it", async () => {
    const result = await call(await connect({ agent: "first_officer", missionId: "m1" }), "list_unreported_tasks");
    expect(result.text).toContain("a_0001");
    expect(result.text).toContain("a_0002");
  });

  it("a chief can see only what they issued themselves (as the same role even when called by an acp_agent name)", async () => {
    const result = await call(await connect({ agent: "sam", missionId: "m1" }), "list_unreported_tasks");
    expect(result.text).toContain("a_0002");
    expect(result.text).not.toContain("a_0001");
  });

  it("crew cannot issue, so they see nothing", async () => {
    const result = await call(await connect({ agent: "ensign", missionId: "m1" }), "list_unreported_tasks");
    expect(result.text).toBe("There are no unreported tasks.");
  });

  it("not decided by role name: even one named first_officer, if its rank is crew, sees only its own issued ones (none)", async () => {
    ranks.first_officer = "crew";
    const result = await call(await connect({ agent: "first_officer", missionId: "m1" }), "list_unreported_tasks");
    expect(result.text).toContain("a_0001"); // what first_officer issued is visible as its own
    expect(result.text).not.toContain("a_0002");
  });
});

describe("render_ui", () => {
  const surface = { version: "1.0", createSurface: { surfaceId: "s1", catalogId: "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json", components: [{ id: "root", component: "Text", text: "hi" }] } };

  it("shows the messages in the reply of the turn in progress, as the caller's role in the caller's mission (a role even when called by an acp_agent name)", async () => {
    const client = await connect({ agent: "sam", missionId: "m1" });
    currentTurn.mockReturnValue({ turnId: "turn-1", agentName: "chief_engineer" });
    const result = await call(client, "render_ui", { messages: [surface] });
    expect(result.isError).toBe(false);
    expect(currentTurn).toHaveBeenCalledWith("m1");
    expect(recordUi).toHaveBeenCalledWith({ turnId: "turn-1", role: "chief_engineer", missionId: "m1", messages: [surface] });
  });

  it("is refused outside a reply to the captain: no turn in progress, or the turn is with someone else (for example while the caller works on a delegated task)", async () => {
    const client = await connect({ agent: "sam", missionId: "m1" });
    currentTurn.mockReturnValue(undefined);
    expect((await call(client, "render_ui", { messages: [surface] })).isError).toBe(true);
    currentTurn.mockReturnValue({ turnId: "turn-1", agentName: "first_officer" }); // the turn is with someone else
    expect((await call(client, "render_ui", { messages: [surface] })).isError).toBe(true);
    expect(recordUi).not.toHaveBeenCalled();
  });

  it("refuses a second form in the same reply, whether the first is still open or was already dealt with, and says why", async () => {
    const client = await connect(caller);
    for (const state of ["pending", "open", "answered", "dismissed"]) {
      uiStateOf.mockReturnValue(state);
      const result = await call(client, "render_ui", { messages: [surface] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("already");
    }
    expect(uiStateOf).toHaveBeenCalledWith("turn-1");
    expect(recordUi).not.toHaveBeenCalled();
  });

  it("refuses messages without the v1.0 envelope, showing nothing", async () => {
    const client = await connect(caller);
    const wrongVersion = await call(client, "render_ui", { messages: [{ ...surface, version: "0.9" }] });
    const noType = await call(client, "render_ui", { messages: [{ version: "1.0" }] });
    expect(wrongVersion.isError).toBe(true);
    expect(noType.isError).toBe(true);
    expect(recordUi).not.toHaveBeenCalled();
  });

  it("refuses a value the basic catalog does not have, returning what is wrong so the crew member can fix it", async () => {
    const client = await connect(caller);
    const badVariant = { ...surface, createSurface: { ...surface.createSurface, components: [{ id: "root", component: "Text", text: "hi", variant: "h3" }] } };
    const result = await call(client, "render_ui", { messages: [badVariant] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("variant");
    expect(recordUi).not.toHaveBeenCalled();
  });

  it("refuses what the renderer would draw as a blank screen: an unknown component type, no root, a child that does not exist", async () => {
    const client = await connect(caller);
    const withComponents = (components: unknown[]) => ({ ...surface, createSurface: { ...surface.createSurface, components, dataModel: {} } });
    for (const components of [
      [{ id: "root", component: "Columnn", children: [] }],
      [{ id: "a", component: "Text", text: "x" }],
      [{ id: "root", component: "Column", children: ["ghost"] }],
    ]) {
      expect((await call(client, "render_ui", { messages: [withComponents(components)] })).isError).toBe(true);
    }
    expect(recordUi).not.toHaveBeenCalled();
  });

  it("accepts the child-list template of v1.0, whose path is written without the @ (it is not a legacy binding)", async () => {
    const client = await connect(caller);
    const list = { ...surface, createSurface: { ...surface.createSurface, dataModel: { items: [{ n: "a" }] }, components: [
      { id: "root", component: "List", children: { componentId: "row", path: "/items" } },
      { id: "row", component: "Text", text: { "@path": "n" } },
    ] } };
    expect((await call(client, "render_ui", { messages: [list] })).isError).toBe(false);
  });

  it("the messages must make exactly one surface", async () => {
    const client = await connect(caller);
    const second = { ...surface, createSurface: { ...surface.createSurface, surfaceId: "s2" } };
    expect((await call(client, "render_ui", { messages: [surface, second] })).isError).toBe(true);
    expect(recordUi).not.toHaveBeenCalled();
  });

  it("the description shows how to bind an input to the data model and send it back (the model is not left to guess)", async () => {
    const client = await connect(caller);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "render_ui")?.description).toContain('"@path"');
  });

  it("refuses the pre-1.0 data binding {\"path\": ...} (the renderer cannot resolve it), asking for \"@path\"", async () => {
    const client = await connect(caller);
    const legacy = { ...surface, createSurface: { ...surface.createSurface, components: [{ id: "root", component: "TextField", label: "Name", value: { path: "/name" } }], dataModel: { name: "" } } };
    const result = await call(client, "render_ui", { messages: [legacy] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("@path");
    expect(recordUi).not.toHaveBeenCalled();
  });

  it("if the caller cannot be identified, shows nothing", async () => {
    const client = await connect(undefined);
    const result = await call(client, "render_ui", { messages: [surface] });
    expect(result.isError).toBe(true);
    expect(recordUi).not.toHaveBeenCalled();
  });
});

describe("get_skill", () => {
  const engineer = { agent: "chief_engineer", missionId: "m1" };

  it("returns the body of a skill announced to the caller", async () => {
    const client = await connect(engineer);
    const result = await call(client, "get_skill", { name: "deploy" });
    expect(result.isError).toBe(false);
    expect(result.text).toBe("# Deploy\nRun it.");
  });

  it("reads by the caller's role, even when it is identified by another name (sam is chief_engineer)", async () => {
    const client = await connect({ agent: "sam", missionId: "m1" });
    expect((await call(client, "get_skill", { name: "deploy" })).text).toContain("Deploy");
  });

  it("does not give a skill that is announced to someone else, and lists the names the caller has", async () => {
    const client = await connect(caller);
    const result = await call(client, "get_skill", { name: "deploy" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("No skills are announced to you");

    const other = await call(await connect(engineer), "get_skill", { name: "nope" });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("deploy");
  });

  it("if the caller cannot be identified, returns an error", async () => {
    const result = await call(await connect(undefined), "get_skill", { name: "deploy" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("the caller could not be identified");
  });
});

describe("get_task", () => {
  it("a nonexistent taskId is an error", async () => {
    const client = await connect(caller);
    const result = await call(client, "get_task", { taskId: "nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("was not found");
  });

  it("for an incomplete task, returns the instruction content and \"not completed yet\"", async () => {
    recordTaskStarted("sam_0001", "m1", "sam", "fix_bug", "Fix the login", undefined, "first_officer");
    const client = await connect(caller);
    const result = await call(client, "get_task", { taskId: "sam_0001" });
    expect(result.text).toBe("## fix_bug\nFix the login\n\n(not completed yet)");
  });

  it("for a completed task, the result is returned too", async () => {
    recordTaskStarted("sam_0001", "m1", "sam", "fix_bug", "Fix the login", undefined, "first_officer");
    recordTaskCompleted("sam_0001", "m1", "fixed");
    const client = await connect(caller);
    const result = await call(client, "get_task", { taskId: "sam_0001" });
    expect(result.text).toBe("## fix_bug\nFix the login\n\n### Result\nfixed");
  });
});

describe("HTTP endpoint (identification header)", () => {
  async function connectOverHttp(headers: Record<string, string>): Promise<Client> {
    const app = express();
    app.use(express.json());
    app.post("/mcp", createMcpHandler(deps));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const { port } = server.address() as AddressInfo;

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }));
    cleanups.push(() => client.close());
    return client;
  }

  it("determines the caller (crew member, mission) from the identification header", async () => {
    const client = await connectOverHttp({ [MCP_AGENT_HEADER]: "first_officer", [MCP_MISSION_HEADER]: "m1", [MCP_TOKEN_HEADER]: "test-token" });
    await call(client, "dispatch_task", { agent: "sam", task_name: "a", instruction: "i" });
    expect(dispatch.mock.calls[0][0]).toMatchObject({ taskId: "chief_engineer_0001", missionId: "m1" });
  });

  it("if there is no header, the caller is not guessed and an error is returned", async () => {
    const client = await connectOverHttp({ [MCP_TOKEN_HEADER]: "test-token" });
    const result = await call(client, "dispatch_task", { agent: "sam", task_name: "a", instruction: "i" });
    expect(result.isError).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["no secret", {}],
    ["a wrong secret", { [MCP_TOKEN_HEADER]: "wrong-token" }],
    ["a secret of another length", { [MCP_TOKEN_HEADER]: "x" }],
  ])("refuses a call that carries %s, before any tool runs", async (_label, headers) => {
    await expect(connectOverHttp({ [MCP_AGENT_HEADER]: "first_officer", [MCP_MISSION_HEADER]: "m1", ...headers })).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
