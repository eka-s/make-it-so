import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStartAbortedError, CrewManager, MCP_AGENT_HEADER, MCP_MISSION_HEADER, MCP_TOKEN_HEADER, type CrewManagerDeps, type CrewManagerSettings } from "./crew-manager.js";
import type { CrewMemberConfig } from "./fleet-config.js";
import { setActivityHandler } from "./bridge-activity.js";
import { taskSessionScope } from "./crew-runner.js";
import { FakeAgentClient } from "./testing/fake-agent-client.js";

// The ship config is built in a temporary directory and a fake agent is passed in, so neither a real process nor
// a ship config file is needed.
let root: string;
let settings: CrewManagerSettings;
let clients: FakeAgentClient[];
let ensureTunnel: ReturnType<typeof vi.fn>;
let createClient: ReturnType<typeof vi.fn>;
let manager: CrewManager;
let getModelOverride: ReturnType<typeof vi.fn>;

function crewMember(overrides: Partial<CrewMemberConfig> = {}): CrewMemberConfig {
  return {
    name: "Test",
    rank: "crew",
    provider: "claude",
    acp_agent: "tester",
    cwd: root,
    rules: [],
    skills: [],
    additionalDirectories: [],
    ...overrides,
  };
}

function makeManager(crew: Record<string, CrewMemberConfig>, extra: Partial<CrewManagerDeps> = {}): void {
  settings = {
    crew,
    defaultProvider: "kiro",
    fleetRoot: path.join(root, "fleet"),
    projectRoot: root,
    skillsDir: path.join(root, "skills"),
    crewLanguage: () => "en",
    mcpToken: "test-token",
  };
  createClient = vi.fn((_provider: string) => {
    const client = new FakeAgentClient();
    clients.push(client);
    return client;
  });
  manager = new CrewManager({ settings, createClient, ensureTunnel, getModelOverride, ...extra });
}

const personaOf = (client: FakeAgentClient) => client.prompts[0]?.text ?? "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mis-crewmgr-"));
  clients = [];
  ensureTunnel = vi.fn(async () => {});
  getModelOverride = vi.fn(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fs.mkdirSync(path.join(root, "fleet", "personnel"), { recursive: true });
  fs.writeFileSync(path.join(root, "fleet", "personnel", "sam.md"), "Sam's persona");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("session creation", () => {
  beforeEach(() => {
    makeManager({
      first_officer: crewMember({ name: "Alex", acp_agent: "alex" }),
      chief_engineer: crewMember({ name: "Sam", acp_agent: "sam" }),
    });
  });

  it("starts and initializes the agent, and creates the session with the bulletin-board MCP's identification header", async () => {
    const session = await manager.getOrCreateSession("chief_engineer", "m1");

    const client = clients[0];
    expect(client.spawnCalls).toEqual([{ agentName: undefined, cwd: root, host: undefined }]);
    expect(client.initializeCalls).toBe(1);
    expect(client.newSessionCalls).toEqual([
      {
        cwd: root,
        additionalDirectories: [],
        mcpIdentity: { [MCP_AGENT_HEADER]: "chief_engineer", [MCP_MISSION_HEADER]: "m1", [MCP_TOKEN_HEADER]: "test-token" },
      },
    ]);
    expect(session).toMatchObject({ sessionId: "fake-session", agentName: "chief_engineer", missionId: "m1", lastSeenSeq: 0 });
  });

  it("for the same (crew member, mission), the same session is returned without recreating", async () => {
    const a = await manager.getOrCreateSession("chief_engineer", "m1");
    const b = await manager.getOrCreateSession("chief_engineer", "m1");
    expect(b).toBe(a);
    expect(clients).toHaveLength(1);
  });

  it("a different mission gives a different client and session even for the same crew member", async () => {
    const a = await manager.getOrCreateSession("chief_engineer", "m1");
    const b = await manager.getOrCreateSession("chief_engineer", "m2");
    expect(b).not.toBe(a);
    expect(clients).toHaveLength(2);
  });

  it("can be looked up by role name or by acp_agent name", async () => {
    const byRole = await manager.getOrCreateSession("chief_engineer", "m1");
    const byAgent = await manager.getOrCreateSession("sam", "m2");
    expect(byRole.crewConfig).toBe(byAgent.crewConfig);
  });

  it("an unknown crew member throws", async () => {
    await expect(manager.getOrCreateSession("nobody", "m1")).rejects.toThrow(/No crew config for agent "nobody"/);
    expect(clients).toHaveLength(0);
  });

  it("the provider prefers the crew member's setting, otherwise the default is used", async () => {
    makeManager({
      first_officer: crewMember({ provider: undefined }),
      chief_engineer: crewMember({ provider: "claude", acp_agent: "sam" }),
    });
    await manager.getOrCreateSession("first_officer", "m1");
    await manager.getOrCreateSession("chief_engineer", "m1");
    expect(createClient.mock.calls.map((c) => c[0])).toEqual(["kiro", "claude"]);
  });
});

describe("briefing at startup (persona injection)", () => {
  it("no agent: the persona, rules, common operating rules, and guidance on the scope of responsibility are sent as one briefing", async () => {
    const rules = path.join(root, "rules.md");
    fs.writeFileSync(rules, "common rule text");
    makeManager({
      first_officer: crewMember({ acp_agent: "alex" }),
      chief_engineer: crewMember({
        acp_agent: "sam",
        rules: [rules],
        accessNote: "## Allowed directories\n- /work/app",
      }),
    });
    await manager.getOrCreateSession("chief_engineer", "m1");

    const persona = personaOf(clients[0]);
    expect(persona).toContain("This is a briefing at the start of the session");
    expect(persona).toContain("Sam's persona");
    expect(persona).toContain("common rule text");
    expect(persona).toContain("## Common operating rules");
    expect(persona).toContain("/work/app");
    expect(clients[0].prompts).toHaveLength(1);
  });

  it("with an agent: the persona (personnel) is not sent. The rules and common operating rules are sent, and the agent is selected", async () => {
    const rules = path.join(root, "rules.md");
    fs.writeFileSync(rules, "common rule text");
    makeManager({
      first_officer: crewMember({ acp_agent: "alex" }),
      chief_engineer: crewMember({ acp_agent: "sam", agent: "sam", rules: [rules] }),
    });
    createClient.mockImplementationOnce(() => {
      const client = new FakeAgentClient();
      client.agentValues = ["default", "sam"];
      clients.push(client);
      return client;
    });
    await manager.getOrCreateSession("chief_engineer", "m1");

    const persona = personaOf(clients[0]);
    expect(persona).not.toContain("Sam's persona");
    expect(persona).toContain("common rule text");
    expect(persona).toContain("## Common operating rules");
    // The agent name is passed to both the startup arguments (for kiro) and the selection after session creation (for claude)
    expect(clients[0].spawnCalls[0].agentName).toBe("sam");
    expect(clients[0].setAgentCalls).toEqual([{ sessionId: "fake-session", agent: "sam" }]);
  });

  it("a crew member with no agent does no agent selection (nor passes it in the startup arguments)", async () => {
    makeManager({ first_officer: crewMember({ acp_agent: "alex" }) });
    await manager.getOrCreateSession("first_officer", "m1");
    expect(clients[0].spawnCalls[0].agentName).toBeUndefined();
    expect(clients[0].setAgentCalls).toEqual([]);
  });

  it("an agent that cannot be selected (a misspelled name, etc.) is not silently run with the default agent; it is an error and the process is stopped too", async () => {
    makeManager({
      first_officer: crewMember({ acp_agent: "alex", agent: "typo" }),
    });
    await expect(manager.getOrCreateSession("first_officer", "m1")).rejects.toThrow(/agent "typo".*is not available/);
    expect(clients[0].killed).toBe(true);
    expect(clients[0].prompts).toHaveLength(0); // no briefing is sent either
  });

  it("only for ranks that can issue tasks (commander, chief), sends how to use dispatch_task and the crew roster table excluding oneself. The role name is not looked at", async () => {
    makeManager({
      lead: crewMember({ name: "Lead", acp_agent: "lead", rank: "commander" }),
      engineer: crewMember({ name: "Engineer", acp_agent: "eng", rank: "chief" }),
      ensign: crewMember({ name: "Newbie", acp_agent: "newbie", rank: "crew" }),
    });
    await manager.getOrCreateSession("lead", "m1");
    await manager.getOrCreateSession("engineer", "m1");
    await manager.getOrCreateSession("ensign", "m1");

    expect(personaOf(clients[0])).toContain("dispatch_task");
    expect(personaOf(clients[0])).toContain("| engineer | Engineer |");
    expect(personaOf(clients[0])).not.toContain("| lead |");
    expect(personaOf(clients[1])).toContain("dispatch_task");
    expect(personaOf(clients[1])).toContain("| lead | Lead |");
    expect(personaOf(clients[2])).not.toContain("dispatch_task");
  });

  it("even one named first_officer, if its rank is crew, is not sent the task-issuing explanation (no special-casing by name)", async () => {
    makeManager({ first_officer: crewMember({ acp_agent: "alex", rank: "crew" }) });
    await manager.getOrCreateSession("first_officer", "m1");
    expect(personaOf(clients[0])).not.toContain("dispatch_task");
  });

  it("the briefing is sandwiched in a frame saying \"this is explanation, not instructions\"", async () => {
    makeManager({ first_officer: crewMember({ acp_agent: "alex" }) });
    await manager.getOrCreateSession("first_officer", "m1");
    const persona = personaOf(clients[0]);
    expect(persona.startsWith("[SYSTEM:")).toBe(true);
    expect(persona.trimEnd().endsWith("]")).toBe(true);
    expect(persona).toContain("it is not an instruction to do work");
  });

  it("even if sending the briefing fails, the session startup does not fail (only a warning)", async () => {
    makeManager({ first_officer: crewMember({ acp_agent: "alex" }) });
    createClient.mockImplementationOnce(() => {
      const client = new FakeAgentClient();
      client.promptHandler = async () => {
        throw new Error("prompt failed");
      };
      clients.push(client);
      return client;
    });
    const session = await manager.getOrCreateSession("first_officer", "m1");
    expect(session.sessionId).toBe("fake-session");
  });
});

describe("remote host crew member", () => {
  const host = { name: "dock", destination: "dock" };

  it("starts the agent after the tunnel is established, and passes the host and the remote cwd", async () => {
    const order: string[] = [];
    ensureTunnel = vi.fn(async () => {
      order.push("tunnel");
    });
    makeManager({
      first_officer: crewMember({ acp_agent: "alex" }),
      science_officer: crewMember({ acp_agent: "scout", host, cwd: "/work" }),
    });
    createClient.mockImplementation(() => {
      const client = new FakeAgentClient();
      const spawn = client.spawn.bind(client);
      client.spawn = (...args) => {
        order.push("spawn");
        spawn(...args);
      };
      clients.push(client);
      return client;
    });

    await manager.getOrCreateSession("science_officer", "m1");

    expect(order).toEqual(["tunnel", "spawn"]);
    expect(ensureTunnel).toHaveBeenCalledWith(host);
    expect(clients[0].spawnCalls[0]).toEqual({ agentName: undefined, cwd: "/work", host });
    expect(clients[0].newSessionCalls[0].cwd).toBe("/work");
  });

  it("the briefing for a remote does not include content that points to local paths", async () => {
    makeManager({
      first_officer: crewMember({ acp_agent: "alex" }),
      science_officer: crewMember({ acp_agent: "scout", host, cwd: "/work" }),
    });
    await manager.getOrCreateSession("science_officer", "m1");
    const persona = personaOf(clients[0]);
    expect(persona).toContain("get_task");
    expect(persona).not.toContain(path.join(root, "workspace"));
  });

  it("the briefing for a remote lists the skills by name, to be read with get_skill, without their local paths", async () => {
    const file = path.join(root, "extra-skills", "deploy", "skill.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "---\nname: deploy\ndescription: How to deploy\n---\nbody\n");
    makeManager({
      first_officer: crewMember({ acp_agent: "alex" }),
      science_officer: crewMember({ acp_agent: "scout", host, cwd: "/work", skills: [file] }),
    });
    await manager.getOrCreateSession("science_officer", "m1");
    const persona = personaOf(clients[0]);
    expect(persona).toContain("- deploy: How to deploy");
    expect(persona).toContain("get_skill");
    expect(persona).not.toContain(file);
  });

  it("if the tunnel cannot be established, an exception, and the agent is not started", async () => {
    ensureTunnel = vi.fn(async () => {
      throw new Error("tunnel not ready");
    });
    makeManager({
      first_officer: crewMember({ acp_agent: "alex" }),
      science_officer: crewMember({ acp_agent: "scout", host, cwd: "/work" }),
    });
    await expect(manager.getOrCreateSession("science_officer", "m1")).rejects.toThrow(/tunnel not ready/);
    expect(clients[0].spawnCalls).toEqual([]);
  });

  it("for a crew member that is not remote, no tunnel is requested", async () => {
    makeManager({ first_officer: crewMember({ acp_agent: "alex" }) });
    await manager.getOrCreateSession("first_officer", "m1");
    expect(ensureTunnel).not.toHaveBeenCalled();
  });
});

describe("session lifetime", () => {
  beforeEach(() => {
    makeManager({
      first_officer: crewMember({ acp_agent: "alex" }),
      chief_engineer: crewMember({ acp_agent: "sam" }),
    });
  });

  it("when the agent dies, the cache is discarded and agentExited is notified", async () => {
    const onExit = vi.fn();
    manager.on("agentExited", onExit);
    await manager.getOrCreateSession("chief_engineer", "m1");

    clients[0].emitExit(1);

    expect(manager.getExistingSession("chief_engineer", "m1")).toBeUndefined();
    expect(onExit).toHaveBeenCalledWith("chief_engineer", "m1");
  });

  it("a killed process that exits late does not wipe the newer session that replaced it", async () => {
    await manager.getOrCreateSession("chief_engineer", "m1");
    manager.killSession("chief_engineer", "m1");
    const second = await manager.getOrCreateSession("chief_engineer", "m1");
    expect(second.client).toBe(clients[1]);

    clients[0].emitExit(143); // the old process finally leaves

    expect(manager.getExistingSession("chief_engineer", "m1")?.client).toBe(clients[1]);
  });

  it("if addressed after it died, it is recreated with a new process", async () => {
    await manager.getOrCreateSession("chief_engineer", "m1");
    clients[0].emitExit(1);

    const session = await manager.getOrCreateSession("chief_engineer", "m1");
    expect(clients).toHaveLength(2);
    expect(session.client).toBe(clients[1]);
  });

  it("killSession stops the client, and next time it is recreated (lastSeenSeq also goes back to 0)", async () => {
    const first = await manager.getOrCreateSession("chief_engineer", "m1");
    manager.markSeen("chief_engineer", "m1", 42);
    expect(first.lastSeenSeq).toBe(42);

    manager.killSession("chief_engineer", "m1");
    expect(clients[0].killed).toBe(true);
    expect(manager.getExistingSession("chief_engineer", "m1")).toBeUndefined();

    const second = await manager.getOrCreateSession("chief_engineer", "m1");
    expect(second.lastSeenSeq).toBe(0);
    expect(clients).toHaveLength(2);
  });

  it("markSeen only advances the reference point and never moves it back", async () => {
    const session = await manager.getOrCreateSession("chief_engineer", "m1");
    manager.markSeen("chief_engineer", "m1", 10);
    manager.markSeen("chief_engineer", "m1", 5);
    expect(session.lastSeenSeq).toBe(10);
  });

  it("a client left over after a failure partway through setup is killed before next time", async () => {
    createClient.mockImplementationOnce(() => {
      const client = new FakeAgentClient();
      client.failInitialize = true;
      clients.push(client);
      return client;
    });
    await expect(manager.getOrCreateSession("chief_engineer", "m1")).rejects.toThrow(/initialize failed/);

    await manager.getOrCreateSession("chief_engineer", "m1");
    expect(clients[0].killed).toBe(true);
    expect(clients).toHaveLength(2);
  });

  it("closeAll stops all clients", async () => {
    await manager.getOrCreateSession("chief_engineer", "m1");
    await manager.getOrCreateSession("first_officer", "m1");
    manager.closeAll();
    expect(clients.every((c) => c.killed)).toBe(true);
  });
});

describe("relaying permissions", () => {
  beforeEach(async () => {
    makeManager({
      first_officer: crewMember({ acp_agent: "alex" }),
      chief_engineer: crewMember({ acp_agent: "sam" }),
    });
    await manager.getOrCreateSession("chief_engineer", "m1");
  });

  it("notifies the agent's permission request as (crew member, request, mission)", () => {
    const onRequest = vi.fn();
    manager.on("permissionRequest", onRequest);
    const request = clients[0].emitPermissionRequest({ toolName: "Edit" });
    expect(onRequest).toHaveBeenCalledWith("chief_engineer", request, "m1");
  });

  it("when a request arrives, the idle timer of that mission's turn is extended (waiting for a human's approval is not a hang)", () => {
    const bump = vi.fn();
    setActivityHandler("m1", bump);
    clients[0].emitPermissionRequest();
    expect(bump).toHaveBeenCalledTimes(1);
    setActivityHandler("m1", null);
  });

  it("the response reaches the client of the matching session", () => {
    manager.respondToPermission("chief_engineer", "m1", 7, "allow-once");
    expect(clients[0].permissionResponses).toEqual([{ requestId: 7, optionId: "allow-once" }]);
  });

  it("a response addressed to a session whose client does not exist is dropped (not an exception)", () => {
    expect(() => manager.respondToPermission("chief_engineer", "nope", 1, "x")).not.toThrow();
    expect(clients[0].permissionResponses).toEqual([]);
  });
});

describe("context usage", () => {
  beforeEach(() => {
    makeManager({
      first_officer: crewMember({ acp_agent: "alex" }),
      chief_engineer: crewMember({ acp_agent: "sam" }),
    });
  });

  it("the conversation session's value is remembered independently per (crew member, mission)", async () => {
    await manager.getOrCreateSession("first_officer", "m1");
    await manager.getOrCreateSession("chief_engineer", "m1");
    await manager.getOrCreateSession("chief_engineer", "m2");

    clients[0].emitUsage(33);
    clients[1].emitUsage(99);
    clients[2].emitUsage(5);

    expect(manager.getContextPercent("first_officer", "m1")).toBe(33);
    expect(manager.getContextPercent("chief_engineer", "m1")).toBe(99);
    expect(manager.getContextPercent("chief_engineer", "m2")).toBe(5);
    expect(manager.getContextPercent("first_officer", "m2")).toBeUndefined();
  });

  it("the list of slash commands is remembered per conversation session, signals the screen when it arrives, and disappears when the session ends", async () => {
    const changed: Array<[string, string]> = [];
    manager.on("sessionStatusChanged", (role, missionId) => changed.push([role, missionId]));
    await manager.getOrCreateSession("chief_engineer", "m1");
    await manager.getOrCreateSession("chief_engineer", "m2");
    changed.length = 0;

    const context = { name: "context", description: "Show context usage" };
    clients[0].pushCommands([context]);
    expect(manager.getCommands("chief_engineer", "m1")).toEqual([context]);
    expect(manager.getCommands("sam", "m1")).toEqual([context]); // can be looked up by acp_agent name too
    expect(manager.getCommands("chief_engineer", "m2")).toEqual([]);
    expect(changed).toEqual([["chief_engineer", "m1"]]);

    clients[0].emitExit(1);
    expect(manager.getCommands("chief_engineer", "m1")).toEqual([]);
  });

  it("slash commands of a task-running session (throwaway) are not tracked", async () => {
    await manager.getOrCreateSession("chief_engineer", taskSessionScope("m1"));
    clients[0].pushCommands([{ name: "context", description: "" }]);
    expect(manager.getCommands("chief_engineer", taskSessionScope("m1"))).toEqual([]);
  });

  it("a session called by acp_agent name can also be looked up as the role's value", async () => {
    await manager.getOrCreateSession("sam", "m1");
    clients[0].emitUsage(12);
    expect(manager.getContextPercent("chief_engineer", "m1")).toBe(12);
  });

  it("values of a task-running session (throwaway) are not tracked", async () => {
    await manager.getOrCreateSession("chief_engineer", taskSessionScope("m1"));
    clients[0].emitUsage(77);
    expect(manager.getContextPercent("chief_engineer", "m1")).toBeUndefined();
    expect(manager.getContextPercent("chief_engineer", taskSessionScope("m1"))).toBeUndefined();
  });

  it("when the session ends (process exit, forced termination, closing all), the value goes away too", async () => {
    await manager.getOrCreateSession("first_officer", "m1");
    await manager.getOrCreateSession("chief_engineer", "m1");
    await manager.getOrCreateSession("chief_engineer", "m2");
    clients.forEach((c) => c.emitUsage(50));

    clients[0].emitExit(1);
    expect(manager.getContextPercent("first_officer", "m1")).toBeUndefined();

    manager.killSession("sam", "m1"); // even when discarded by acp_agent name, the role's value goes away
    expect(manager.getContextPercent("chief_engineer", "m1")).toBeUndefined();

    expect(manager.getContextPercent("chief_engineer", "m2")).toBe(50);
    manager.closeAll();
    expect(manager.getContextPercent("chief_engineer", "m2")).toBeUndefined();
  });
});

describe("language of the crew", () => {
  it("the briefing tells the crew to speak the language in effect when the session starts", async () => {
    let language: "en" | "ja" = "en";
    makeManager({ chief_engineer: crewMember({ acp_agent: "sam" }) });
    settings.crewLanguage = () => language;

    await manager.getOrCreateSession("chief_engineer", "m1");
    expect(personaOf(clients[0])).toContain("Always respond in English");

    // a change from the UI applies to sessions that start afterwards
    language = "ja";
    await manager.getOrCreateSession("chief_engineer", "m2");
    expect(personaOf(clients[1])).toContain("Always respond in Japanese");
  });
});

describe("CrewManager: starting / restarting", () => {
  let changes: Array<[string, string]>;

  beforeEach(() => {
    makeManager({
      first_officer: crewMember({ acp_agent: "alex" }),
      chief_engineer: crewMember({ acp_agent: "sam" }),
    });
    changes = [];
    manager.on("sessionStatusChanged", (role, missionId) => changes.push([role, missionId]));
  });

  it("while a session is starting up it is \"starting\", and it clears when done (signals are sent at the start and the end)", async () => {
    let release: (() => void) | null = null;
    createClient.mockImplementation(() => {
      const client = new FakeAgentClient();
      client.promptHandler = () => new Promise((resolve) => { release = () => resolve({ stopReason: "end_turn" }); });
      clients.push(client);
      return client;
    });

    const creating = manager.getOrCreateSession("sam", "m1"); // even when called by acp_agent name, it is looked up by role
    await vi.waitFor(() => expect(manager.sessionPhase("chief_engineer", "m1")).toBe("starting"));
    expect(manager.sessionPhase("chief_engineer", "m2")).toBeUndefined(); // another mission is separate
    expect(manager.sessionPhase("chief_engineer")).toBe("starting"); // overview (no mission specified)
    expect(changes).toEqual([["chief_engineer", "m1"]]);

    await vi.waitFor(() => expect(release).not.toBeNull()); // wait until the persona injection has been sent
    release!();
    await creating;
    expect(manager.sessionPhase("chief_engineer", "m1")).toBeUndefined();
    expect(changes).toEqual([["chief_engineer", "m1"], ["chief_engineer", "m1"]]);
  });

  it("just taking an existing session does not make it \"starting\" (and no signal is sent)", async () => {
    await manager.getOrCreateSession("chief_engineer", "m1");
    changes.length = 0;
    await manager.getOrCreateSession("chief_engineer", "m1");
    expect(changes).toEqual([]);
  });

  it("the startup of a task-running session (throwaway) is not shown as starting", async () => {
    await manager.getOrCreateSession("chief_engineer", taskSessionScope("m1"));
    expect(changes).toEqual([]);
  });

  it("even if the startup fails, \"starting\" is cleared", async () => {
    createClient.mockImplementation(() => {
      const client = new FakeAgentClient();
      client.failInitialize = true;
      clients.push(client);
      return client;
    });
    await expect(manager.getOrCreateSession("chief_engineer", "m1")).rejects.toThrow();
    expect(manager.sessionPhase("chief_engineer", "m1")).toBeUndefined();
  });

  it("while restarting it is \"restarting\" (taking priority over starting), and it clears when done. The old session is discarded and recreated", async () => {
    await manager.getOrCreateSession("chief_engineer", "m1");
    const old = clients[0];
    changes.length = 0;

    let release: (() => void) | null = null;
    createClient.mockImplementation(() => {
      const client = new FakeAgentClient();
      client.promptHandler = () => new Promise((resolve) => { release = () => resolve({ stopReason: "end_turn" }); });
      clients.push(client);
      return client;
    });

    const restarting = manager.restartSession("chief_engineer", "m1");
    await vi.waitFor(() => expect(manager.sessionPhase("chief_engineer", "m1")).toBe("restarting"));
    expect(old.killed).toBe(true);

    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    await restarting;
    expect(manager.sessionPhase("chief_engineer", "m1")).toBeUndefined();
    expect(manager.getExistingSession("chief_engineer", "m1")).toBeDefined();
    expect(changes.length).toBeGreaterThanOrEqual(2); // start and end of the restart
    expect(changes.at(-1)).toEqual(["chief_engineer", "m1"]);
  });

  it("even if the restart fails, \"restarting\" is cleared (the error goes to the caller)", async () => {
    await manager.getOrCreateSession("chief_engineer", "m1");
    createClient.mockImplementation(() => {
      const client = new FakeAgentClient();
      client.failInitialize = true;
      clients.push(client);
      return client;
    });
    await expect(manager.restartSession("chief_engineer", "m1")).rejects.toThrow();
    expect(manager.sessionPhase("chief_engineer", "m1")).toBeUndefined();
  });
});

describe("CrewManager: permission mode", () => {
  /** Gives the created client the selectable permission modes. */
  function withModes(modes: string[]): void {
    createClient.mockImplementation(() => {
      const client = new FakeAgentClient();
      client.modeValues = modes;
      clients.push(client);
      return client;
    });
  }

  beforeEach(() => {
    makeManager({
      first_officer: crewMember({ name: "Alex", acp_agent: "alex" }),
      ensign: crewMember({ name: "Jo", acp_agent: "jo", permissionMode: "default" }),
    });
  });

  it("applies the configured permissionMode when the session is created (nothing is done for a crew member with none specified)", async () => {
    withModes(["default", "auto"]);
    await manager.getOrCreateSession("ensign", "m1");
    await manager.getOrCreateSession("first_officer", "m1");
    expect(clients[0].setPermissionModeCalls).toEqual([{ sessionId: "fake-session", mode: "default" }]);
    expect(clients[1].setPermissionModeCalls).toEqual([]);
  });

  it("for an unselectable mode or a provider that does not support it, a warning is issued and it carries on with the default (the session is created)", async () => {
    withModes([]);
    await expect(manager.getOrCreateSession("ensign", "m1")).resolves.toBeDefined();
    expect(clients[0].setPermissionModeCalls).toEqual([]);
  });
});

describe("CrewManager: model selection", () => {
  const modelState = { current: "sonnet", options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }, { value: "haiku", name: "Haiku" }] };

  /** Gives the created client a fake state that supports model switching. */
  function withModelSupport(): void {
    createClient.mockImplementation((_provider: string) => {
      const client = new FakeAgentClient();
      client.modelState = { ...modelState };
      clients.push(client);
      return client;
    });
  }

  beforeEach(() => {
    makeManager({
      first_officer: crewMember({ name: "Alex", acp_agent: "alex" }),
      chief_engineer: crewMember({ name: "Sam", acp_agent: "sam", model: "opus" }),
    });
    withModelSupport();
  });

  it("applies the configured model when the session is created", async () => {
    await manager.getOrCreateSession("chief_engineer", "m1");
    expect(clients[0].setModelCalls).toEqual([{ sessionId: "fake-session", model: "opus" }]);
  });

  it("the mission override takes priority over the configuration (even when called by acp_agent name, it is looked up by role)", async () => {
    getModelOverride.mockImplementation((role: string, scope: string) => (role === "chief_engineer" && scope === "m1" ? "haiku" : undefined));
    await manager.getOrCreateSession("sam", "m1");
    expect(clients[0].setModelCalls).toEqual([{ sessionId: "fake-session", model: "haiku" }]);
  });

  it("if none is specified, the model is not switched", async () => {
    await manager.getOrCreateSession("first_officer", "m1");
    expect(clients[0].setModelCalls).toEqual([]);
  });

  it("a client that does not support switching does nothing (and it is not an error either)", async () => {
    createClient.mockImplementation(() => {
      const client = new FakeAgentClient();
      clients.push(client);
      return client;
    });
    await expect(manager.getOrCreateSession("chief_engineer", "m1")).resolves.toBeDefined();
    expect(clients[0].setModelCalls).toEqual([]);
    expect(manager.getModelOptions("claude")).toEqual([]);
  });

  it("remembers the selectable model list per provider", async () => {
    await manager.getOrCreateSession("first_officer", "m1");
    expect(manager.getModelOptions("claude").map((o) => o.value)).toEqual(["sonnet", "opus", "haiku"]);
  });

  it("saves a cache of the selectable model list, and after a restart (no session) it is returned from the cache", async () => {
    const stored = new Map<string, { value: string; name: string }[]>();
    const store = { load: (p: string) => stored.get(p) ?? [], save: (p: string, o: { value: string; name: string }[]) => { stored.set(p, o); } };
    const make = () => new CrewManager({ settings, createClient, ensureTunnel, getModelOverride, modelOptionsStore: store });
    await make().getOrCreateSession("first_officer", "m1");
    expect(stored.get("claude")?.map((o) => o.value)).toEqual(["sonnet", "opus", "haiku"]);
    // A new manager (= after a server restart) returns the cache without creating a session
    expect(make().getModelOptions("claude").map((o) => o.value)).toEqual(["sonnet", "opus", "haiku"]);
  });

  it("applyModel reflects it in the running session, and with undefined goes back to the model from right after creation", async () => {
    await manager.getOrCreateSession("first_officer", "m1");
    await manager.applyModel("first_officer", "m1", "__tasks__:m1", "haiku");
    expect(manager.getLiveModel("first_officer", "m1", "__tasks__:m1")).toBe("haiku");
    await manager.applyModel("first_officer", "m1", "__tasks__:m1", undefined);
    expect(manager.getLiveModel("first_officer", "m1", "__tasks__:m1")).toBe("sonnet");
  });

  it("applyModel does nothing if there is no session", async () => {
    await expect(manager.applyModel("first_officer", "m1", "__tasks__:m1", "haiku")).resolves.toBeUndefined();
    expect(manager.getLiveModel("first_officer", "m1", "__tasks__:m1")).toBeUndefined();
  });
});

describe("startup watchdog (so that we are not made to wait forever on a provider that does not respond)", () => {
  const crew = () => ({ lead: crewMember({ acp_agent: "lead" }) });

  it("if the startup exceeds the time limit, the starting process is stopped and it fails. \"Starting\" is cleared, and the next startup is done with a new client", async () => {
    makeManager(crew(), { startupTimeoutMs: 40 });
    createClient.mockImplementationOnce(() => {
      const client = new FakeAgentClient();
      client.hangInitialize = true;
      clients.push(client);
      return client;
    });

    await expect(manager.getOrCreateSession("lead", "m1")).rejects.toThrow(/timed out after .*did not respond/);
    expect(clients[0].killed).toBe(true);
    expect(manager.sessionPhase("lead", "m1")).toBeUndefined();
    expect(manager.getExistingSession("lead", "m1")).toBeUndefined();

    // the next call starts up with a new client
    await manager.getOrCreateSession("lead", "m1");
    expect(clients).toHaveLength(2);
    expect(manager.getExistingSession("lead", "m1")).toBeDefined();
  });

  it("abortStartup can abort a session that is starting up. false if nothing is starting", async () => {
    makeManager(crew());
    expect(manager.abortStartup("lead", "m1")).toBe(false);
    createClient.mockImplementationOnce(() => {
      const client = new FakeAgentClient();
      client.hangInitialize = true;
      clients.push(client);
      return client;
    });

    const starting = manager.getOrCreateSession("lead", "m1");
    await vi.waitFor(() => expect(manager.sessionPhase("lead", "m1")).toBe("starting"));
    expect(manager.abortStartup("lead", "m1")).toBe(true);

    await expect(starting).rejects.toBeInstanceOf(SessionStartAbortedError);
    expect(clients[0].killed).toBe(true);
    expect(manager.sessionPhase("lead", "m1")).toBeUndefined();
    expect(manager.abortStartup("lead", "m1")).toBe(false);
  });

  it("even if the startup processing finishes late after an abort, that session is not registered and the client is stopped", async () => {
    makeManager(crew());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    createClient.mockImplementationOnce(() => {
      const client = new FakeAgentClient();
      client.initializeGate = gate;
      clients.push(client);
      return client;
    });

    const starting = manager.getOrCreateSession("lead", "m1");
    await vi.waitFor(() => expect(clients[0]?.initializeCalls).toBe(1));
    manager.abortStartup("lead", "m1");
    await expect(starting).rejects.toBeInstanceOf(SessionStartAbortedError);

    release(); // later, the startup processing moves on
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.getExistingSession("lead", "m1")).toBeUndefined();
    expect(clients[0].killed).toBe(true);
  });

  it("if sending the briefing times out with no response, the startup fails (we do not carry on in an unusable state)", async () => {
    makeManager(crew(), { personaIdleTimeoutMs: 30 });
    createClient.mockImplementationOnce(() => {
      const client = new FakeAgentClient();
      client.promptHandler = () => new Promise(() => {}); // does not respond
      clients.push(client);
      return client;
    });

    await expect(manager.getOrCreateSession("lead", "m1")).rejects.toThrow(/did not answer the briefing/);
    expect(clients[0].killed).toBe(true);
    expect(manager.getExistingSession("lead", "m1")).toBeUndefined();
  });

  it("a briefing that waits for the captain's answer to a permission request is not a hang, however long it takes", async () => {
    makeManager(crew(), { personaIdleTimeoutMs: 30 });
    let answer!: () => void;
    createClient.mockImplementationOnce(() => {
      const client = new FakeAgentClient();
      client.pendingPermission = true;
      client.promptHandler = () => new Promise((resolve) => { answer = () => resolve({ stopReason: "end_turn" }); });
      clients.push(client);
      return client;
    });

    const starting = manager.getOrCreateSession("lead", "m1");
    await new Promise((resolve) => setTimeout(resolve, 120)); // four times the limit
    expect(clients[0].killed).toBe(false);
    answer();
    await expect(starting).resolves.toBeDefined();
  });

  it("an agent that dies while it is being briefed fails the start, instead of leaving a dead session cached", async () => {
    makeManager(crew(), {});
    createClient.mockImplementationOnce(() => {
      const client = new FakeAgentClient();
      client.promptHandler = async () => { client.ended = true; client.emitExit(1); return { stopReason: "end_turn" }; };
      clients.push(client);
      return client;
    });

    await expect(manager.getOrCreateSession("lead", "m1")).rejects.toThrow(/ended while it was being briefed/);
    expect(manager.getExistingSession("lead", "m1")).toBeUndefined();
  });

  it("two requests for the same session at the same moment share one start (nobody kills the other's process)", async () => {
    makeManager(crew(), {});
    const [a, b] = await Promise.all([manager.getOrCreateSession("lead", "m1"), manager.getOrCreateSession("lead", "m1")]);
    expect(clients).toHaveLength(1);
    expect(a).toBe(b);
    expect(clients[0].killed).toBe(false);
  });

  it("a restart while a start is running is not made to wait for the start it killed", async () => {
    makeManager(crew(), {});
    let release!: () => void;
    createClient.mockImplementationOnce(() => {
      const client = new FakeAgentClient();
      client.initializeGate = new Promise<void>((resolve) => { release = resolve; });
      clients.push(client);
      return client;
    });
    const first = manager.getOrCreateSession("lead", "m1");
    first.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));

    manager.killSession("lead", "m1");
    const second = await manager.getOrCreateSession("lead", "m1");
    expect(second.client).toBe(clients[1]);
    release();
  });

  it("if it comes up normally, the watchdog does nothing (even after the time limit passes, the session is alive)", async () => {
    makeManager(crew(), { startupTimeoutMs: 40 });
    await manager.getOrCreateSession("lead", "m1");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(clients[0].killed).toBe(false);
    expect(manager.getExistingSession("lead", "m1")).toBeDefined();
  });
});

describe("cache of slash commands (the previous list can be shown even before startup)", () => {
  const crew = () => ({
    lead: crewMember({ acp_agent: "lead", provider: "claude" }),
    other: crewMember({ acp_agent: "other", provider: "kiro" }),
  });
  const context = { name: "context", description: "Show context usage" };

  function store(initial: Record<string, Array<{ name: string; description: string }>> = {}) {
    const saved = new Map(Object.entries(initial));
    return {
      saved,
      commandsStore: {
        load: (provider: string) => saved.get(provider) ?? [],
        save: vi.fn((provider: string, commands: Array<{ name: string; description: string }>) => void saved.set(provider, commands)),
      },
    };
  }

  it("before startup (no session), the provider's cache is returned. It is not the running session's list, so it is not live", () => {
    const { commandsStore } = store({ claude: [context] });
    makeManager(crew(), { commandsStore });
    expect(manager.getCommands("lead", "m1")).toEqual([context]);
    expect(manager.hasLiveCommands("lead", "m1")).toBe(false);
    // another provider's cache is not used. Empty if there is no cache
    expect(manager.getCommands("other", "m1")).toEqual([]);
  });

  it("when the list arrives from the session, it is returned (live) and saved as that provider's cache", async () => {
    const { commandsStore, saved } = store({ claude: [context] });
    makeManager(crew(), { commandsStore });
    await manager.getOrCreateSession("lead", "m1");

    const fresh = { name: "compact", description: "Compact the conversation" };
    clients[0].pushCommands([fresh]);
    expect(manager.getCommands("lead", "m1")).toEqual([fresh]);
    expect(manager.hasLiveCommands("lead", "m1")).toBe(true);
    expect(saved.get("claude")).toEqual([fresh]);
    expect(saved.has("kiro")).toBe(false);
  });

  it("if the list that arrived is empty, the existing cache is not erased", async () => {
    const { commandsStore, saved } = store({ claude: [context] });
    makeManager(crew(), { commandsStore });
    await manager.getOrCreateSession("lead", "m1");
    clients[0].pushCommands([]);
    expect(saved.get("claude")).toEqual([context]);
    expect(manager.hasLiveCommands("lead", "m1")).toBe(true); // the session's list has arrived (though it is empty)
  });

  it("when the session ends, it is no longer live and goes back to the cache", async () => {
    const { commandsStore } = store();
    makeManager(crew(), { commandsStore });
    await manager.getOrCreateSession("lead", "m1");
    clients[0].pushCommands([context]);
    clients[0].emitExit(1);
    expect(manager.hasLiveCommands("lead", "m1")).toBe(false);
    expect(manager.getCommands("lead", "m1")).toEqual([context]); // the saved cache
  });

  it("even without a place to keep the cache, it works as before (empty)", () => {
    makeManager(crew());
    expect(manager.getCommands("lead", "m1")).toEqual([]);
  });
});
