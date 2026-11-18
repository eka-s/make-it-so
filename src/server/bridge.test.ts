import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridge, type Bridge } from "./bridge.js";
import { SERVER_MESSAGES } from "./messages.js";
import { CrewManager } from "./crew-manager.js";
import {
  closeDatabase,
  createMission,
  getTimelineEventsHistory,
  getUnreportedTasks,
  initDatabase,
  recordTaskCompleted,
  recordTaskStarted,
} from "./database.js";
import { configureTimeline } from "./timeline.js";
import * as timeline from "./timeline.js";
import { createTurnStreams, type TurnStreams } from "./turn-stream.js";
import { agentToRole, type CrewMemberConfig } from "./fleet-config.js";
import { FakeAgentClient } from "./testing/fake-agent-client.js";

// Checks the conversation lifecycle with the real CrewManager + a fake agent + an in-memory DB.
// The agent's replies are stacked into `behaviors` per test (one is consumed per prompt).
type Behavior = (text: string, client: FakeAgentClient) => Promise<{ stopReason: string }>;

let root: string;
let clients: FakeAgentClient[];
let behaviors: Behavior[];
let turnStreams: TurnStreams;
let bridge: Bridge;
const fetchUsage = vi.fn(async () => ({ accounts: [], untracked: [] }));
const touchedTurns: string[] = [];

const BRIEFING_MARK = "This is a briefing at the start of the session";

/** A response that streams the body as chunks and then completes with end_turn. */
const reply = (text: string): Behavior => async (_t, client) => {
  client.emit("chunk", text);
  return { stopReason: "end_turn" };
};

function member(name: string, acpAgent: string): CrewMemberConfig {
  return { name, rank: "crew", provider: "claude", acp_agent: acpAgent, cwd: root, rules: [], skills: [], additionalDirectories: [] };
}

const testCrew = () => ({ first_officer: member("Alex", "alex"), chief_engineer: member("Sam", "sam") });

let language: "en" | "ja" = "en";

function makeBridge(options: { idleTimeoutMs?: number; cancelGraceMs?: number; hangStartup?: boolean } = {}): void {
  const crew = testCrew();
  const crewManager = new CrewManager({
    getModelOverride: () => undefined,
    settings: { crew, defaultProvider: "claude", fleetRoot: path.join(root, "fleet"), projectRoot: root, skillsDir: path.join(root, "skills"), crewLanguage: () => "en" },
    createClient: () => {
      const client = new FakeAgentClient();
      client.hangInitialize = options.hangStartup === true; // a provider that does not respond (startup never finishes)
      client.promptHandler = async (text) => {
        if (text.includes(BRIEFING_MARK)) return { stopReason: "end_turn" }; // returns nothing for the startup briefing
        const next = behaviors.shift() ?? reply("(default response)");
        return next(text, client);
      };
      clients.push(client);
      return client;
    },
    ensureTunnel: async () => {},
  });
  bridge = createBridge({
    crewManager,
    turnStreams,
    isCrewRole: (role) => role in crew,
    displayName: (role) => (crew as Record<string, { name: string }>)[role]?.name ?? role,
    fetchUsage,
    crewLanguage: () => language,
    idleTimeoutMs: options.idleTimeoutMs,
    cancelGraceMs: options.cancelGraceMs,
  });
}

beforeEach(() => {
  language = "en";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mis-bridge-"));
  clients = [];
  behaviors = [];
  turnStreams = createTurnStreams(path.join(root, "turns"));
  initDatabase({ path: ":memory:", agentToRole: (agent) => agentToRole(testCrew(), agent) });
  createMission("m1", "test 1");
  createMission("m2", "test 2");
  configureTimeline({ readTaskText: async () => "", readTurnText: turnStreams.read });
  fetchUsage.mockClear();
  makeBridge();
});

afterEach(() => {
  for (const id of touchedTurns.splice(0)) timeline.forget(id);
  closeDatabase();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function send(text: string, agent = "first_officer", mission = "m1"): string {
  const id = bridge.sendMessage(text, agent, mission);
  touchedTurns.push(id);
  return id;
}
const idle = (mission = "m1") => vi.waitFor(() => expect(bridge.isMissionBusy(mission)).toBe(false));
const history = (mission = "m1") => getTimelineEventsHistory({ missionId: mission }).items;
/** Holds the prompt so that it can be released at any timing in the test. */
function deferred(): { behavior: Behavior; release: (text?: string) => void; started: Promise<void> } {
  let release!: (text?: string) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const behavior: Behavior = (_t, client) => new Promise((resolve) => {
    markStarted();
    release = (text) => {
      if (text) client.emit("chunk", text);
      resolve({ stopReason: "end_turn" });
    };
  });
  return { behavior, release: (text) => release(text), started };
}

describe("slash commands", () => {
  const commands = [{ name: "context", description: "Show context usage" }];

  // In a mission with a conversation, finish the first message (the session startup) and deliver the list of commands
  async function startSessionWithCommands() {
    send("hello");
    await idle();
    clients[0].pushCommands(commands);
  }

  it("a command in the list is sent as the bare text, without the mission's conversation preamble", async () => {
    await startSessionWithCommands();
    send("a message from others", "chief_engineer"); // stack into the mission a message the commander has not seen yet
    await idle();
    send("/context");
    await idle();
    expect(clients[0].prompts.at(-1)?.text).toBe("/context");
  });

  it("running a command does not advance the conversation reference point (at the next ordinary message, the messages not yet seen are injected)", async () => {
    await startSessionWithCommands();
    send("a message from others", "chief_engineer");
    await idle();
    send("/context");
    await idle();
    send("continuing from before");
    await idle();
    const next = clients[0].prompts.at(-1)!.text;
    expect(next).toContain("a message from others");
    expect(next).toContain("continuing from before");
  });

  it("a sentence starting with / that is not in the list (a path etc.) gets the preamble as an ordinary message", async () => {
    await startSessionWithCommands();
    send("a message from others", "chief_engineer");
    await idle();
    send("/usr/bin/ls please check it");
    await idle();
    const text = clients[0].prompts.at(-1)!.text;
    expect(text).toContain("[SYSTEM:");
    expect(text).toContain("/usr/bin/ls please check it");
  });

  it("the result (response) of a command stays in the timeline like an ordinary response", async () => {
    await startSessionWithCommands();
    behaviors.push(reply("## Context Usage"));
    send("/context");
    await idle();
    expect(history().at(-1)).toMatchObject({ role: "first_officer", text: "## Context Usage" });
  });
});

describe("conversation basics", () => {
  it("sending the captain's message returns a response, and the conversation is persisted in the history", async () => {
    behaviors.push(reply("good morning to you"));
    const turnId = send("good morning");
    expect(bridge.isMissionBusy("m1")).toBe(true);
    expect(bridge.getCurrentTurnId("m1")).toBe(turnId);

    await idle();

    expect(history().map((i) => [i.role, i.text])).toEqual([
      ["captain", "good morning"],
      ["first_officer", "good morning to you"],
    ]);
    expect(bridge.getCurrentTurnId("m1")).toBeNull();
    // after completion, neither the running display (live) nor the stream file remains
    expect(timeline.get(turnId)).toBeUndefined();
    expect(await turnStreams.read(turnId)).toBe("");
  });

  it("the prompt sent to the agent includes the captain's message", async () => {
    send("please look into it");
    await idle();
    const sent = clients[0].prompts.map((p) => p.text);
    expect(sent.at(-1)).toContain("please look into it");
  });

  it("in a conversation with any crew member, the usage (credits) is fetched and broadcast (no distinction by role)", async () => {
    send("hello");
    await idle();
    expect(fetchUsage).toHaveBeenCalledTimes(1);

    send("hi", "chief_engineer");
    await idle();
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("in a direct conversation with a crew member, the response is recorded as that crew member's message", async () => {
    behaviors.push(reply("understood"));
    send("please do it", "chief_engineer");
    await idle();
    expect(history().map((i) => i.role)).toEqual(["captain", "chief_engineer"]);
  });

  it("sending to a nonexistent crew member is rejected (no turn starts)", () => {
    expect(() => bridge.sendMessage("x", "nobody", "m1")).toThrow(/Unknown crew role "nobody"/);
    expect(bridge.isMissionBusy("m1")).toBe(false);
  });

  it("a turn with an empty response is not recorded (only the captain's message remains), and busy is released too", async () => {
    behaviors.push(async () => ({ stopReason: "end_turn" }));
    send("…");
    await idle();
    expect(history().map((i) => i.role)).toEqual(["captain"]);
  });

  it("sendReport sends \"report\" to the commander", async () => {
    const { messageId } = bridge.sendReport("first_officer", "m1");
    touchedTurns.push(messageId);
    await idle();
    expect(clients[0].prompts.at(-1)?.text).toContain("report");
    expect(history()[0]).toMatchObject({ role: "captain", text: "report" });
  });
});

describe("concurrency (per mission)", () => {
  it("if the previous turn is running in the same mission, it is rejected", async () => {
    const d = deferred();
    behaviors.push(d.behavior);
    send("1st message");
    await d.started;
    expect(() => bridge.sendMessage("2nd message", "chief_engineer", "m1")).toThrow(/busy/);
    d.release("done");
    await idle();
  });

  it("another mission can run in parallel", async () => {
    const d = deferred();
    behaviors.push(d.behavior);
    send("m1 message", "first_officer", "m1");
    await d.started;

    behaviors.push(reply("m2 response"));
    send("m2 message", "first_officer", "m2");
    await idle("m2");
    expect(bridge.isMissionBusy("m1")).toBe(true);
    expect(history("m2").map((i) => i.text)).toEqual(["m2 message", "m2 response"]);

    d.release("m1 response");
    await idle("m1");
    expect(history("m1").map((i) => i.text)).toEqual(["m1 message", "m1 response"]);
  });

  it("isAgentBusy is true only for the one in a turn (a mission can be specified too)", async () => {
    const d = deferred();
    behaviors.push(d.behavior);
    send("please do it", "chief_engineer", "m1");
    await d.started;

    expect(bridge.isAgentBusy("chief_engineer")).toBe(true);
    expect(bridge.isAgentBusy("chief_engineer", "m1")).toBe(true);
    expect(bridge.isAgentBusy("chief_engineer", "m2")).toBe(false);
    expect(bridge.isAgentBusy("first_officer")).toBe(false);

    d.release("done");
    await idle();
    expect(bridge.isAgentBusy("chief_engineer")).toBe(false);
  });
});

describe("cancel", () => {
  it("a cancel during a turn is conveyed to the agent, and if it ends with cancelled, that is recorded", async () => {
    let release!: () => void;
    behaviors.push((_t, client) => new Promise((resolve) => {
      client.emit("chunk", "partway");
      release = () => resolve({ stopReason: "cancelled" });
    }));
    send("long work");
    await vi.waitFor(() => expect(clients[0]?.prompts.length).toBeGreaterThan(1));

    expect(bridge.cancelMessage("m1")).toBe(true);
    expect(clients[0].cancels).toEqual(["fake-session"]);
    release();
    await idle();

    const last = history().at(-1)!;
    expect(last).toMatchObject({ role: "first_officer", text: "partway", cancelled: true });
  });

  it("false if there is no turn", () => {
    expect(bridge.cancelMessage("m1")).toBe(false);
  });
});

describe("errors and auto-recovery", () => {
  it("an unrecoverable error is recorded as an error and ends", async () => {
    behaviors.push(async () => {
      throw new Error("boom");
    });
    send("do it");
    await idle();
    expect(history().at(-1)).toMatchObject({ role: "first_officer", text: "⚠️ Error: boom" });
    expect(clients).toHaveLength(1); // the session is not recreated
  });

  it("a temporary error (-32603) recreates the session, resends the captain's message, and on success notifies that", async () => {
    behaviors.push(async () => {
      throw new Error("RPC error -32603: Internal error");
    });
    behaviors.push(reply("succeeded on retry"));
    send("do it");
    await idle();

    expect(clients).toHaveLength(2);
    expect(clients[0].killed).toBe(true);
    // the retry's prompt contains that the previous attempt failed, and the original captain's message
    const retryPrompt = clients[1].prompts.at(-1)!.text;
    expect(retryPrompt).toContain("A server error (-32603) occurred");
    expect(retryPrompt).toContain("do it");
    expect(history().map((i) => i.text)).toEqual(["do it", "succeeded on retry", SERVER_MESSAGES.recovery_rerun]);
    // the notice is stored with its key, so the client can show it in the current language
    expect(history().at(-1)?.messageKey).toBe("recovery_rerun");
  });

  it("if recovery fails too, an error urging manual recovery is recorded", async () => {
    behaviors.push(async () => {
      throw new Error("RPC error -32603: Internal error");
    });
    behaviors.push(async () => {
      throw new Error("failed again");
    });
    send("do it");
    await idle();
    expect(history().at(-1)?.text).toBe(SERVER_MESSAGES.recovery_failed);
    expect(history().at(-1)?.messageKey).toBe("recovery_failed");
  });

  it("even if an error occurs again during recovery, it does not recover twice", async () => {
    behaviors.push(async () => {
      throw new Error("RPC error -32603: Internal error");
    });
    behaviors.push(async () => {
      throw new Error("RPC error -32603: Internal error");
    });
    send("do it");
    await idle();
    expect(clients).toHaveLength(2); // recreated only once
  });

  it("armErrorSimulation causes -32603 only the next one time and triggers recovery", async () => {
    bridge.armErrorSimulation();
    behaviors.push(reply("response after recovery"));
    send("1st time");
    await idle();
    expect(history().map((i) => i.text)).toContain("response after recovery");
    expect(clients).toHaveLength(2);

    behaviors.push(reply("ordinary response"));
    send("2nd time");
    await idle();
    expect(clients).toHaveLength(2); // the flag has been cleared after one time
  });

  it("if the response is silent for a long time, it is treated as a hang, cancelled, and recovered", async () => {
    makeBridge({ idleTimeoutMs: 30 });
    behaviors.push(() => new Promise(() => {})); // never returns
    behaviors.push(reply("response after recovery"));
    send("do it");
    await idle();
    expect(clients[0].cancels).toEqual(["fake-session"]);
    expect(history().map((i) => i.text)).toContain("response after recovery");
  });
});

describe("preamble of the mission's conversation", () => {
  it("from the second prompt on, the conversation so far (with the other side's display name) is prepended", async () => {
    behaviors.push(reply("first response"));
    send("first");
    await idle();

    behaviors.push(reply("second response"));
    send("second");
    await idle();

    const second = clients[0].prompts.at(-1)!.text;
    expect(second).toContain("This is the conversation so far in this mission");
    expect(second).toContain("Alex: first response");
    expect(second).toContain("second");
    // what was injected once is not sent again as a delta
    expect(second).not.toContain("Captain: first");
    // the past conversation may be in another language: remind the crew of the language in effect
    expect(second).toContain("Respond in English, even if the past conversation above is in another language");
  });

  it("the reminder after the past conversation follows the language in effect", async () => {
    language = "ja";
    behaviors.push(reply("first response"));
    send("first");
    await idle();
    behaviors.push(reply("second response"));
    send("second");
    await idle();
    expect(clients[0].prompts.at(-1)!.text).toContain("Respond in Japanese, even if the past conversation above is in another language");
  });

  it("conversations of other missions do not mix in", async () => {
    behaviors.push(reply("m1 response"));
    send("m1 message", "first_officer", "m1");
    await idle("m1");

    send("m2 message", "first_officer", "m2");
    await idle("m2");
    const m2Prompt = clients[1].prompts.at(-1)!.text;
    expect(m2Prompt).not.toContain("m1's");
  });
});

describe("recording a report", () => {
  function finishedTask(taskId: string): void {
    recordTaskStarted(taskId, "m1", "sam", "research", "look into it", undefined, "first_officer");
    recordTaskCompleted(taskId, "m1", "result");
  }

  it("a task returned by list_unreported_tasks during a turn becomes reported when the turn completes, and goes in reportMeta", async () => {
    finishedTask("sam_0001");
    behaviors.push(async (_t, client) => {
      bridge.recordUnreportedFetch({ agent: "first_officer", missionId: "m1" }, ["sam_0001"]);
      client.emit("chunk", "I will report");
      return { stopReason: "end_turn" };
    });
    expect(getUnreportedTasks("m1").map((t) => t.taskId)).toEqual(["sam_0001"]);

    send("report");
    await idle();

    expect(getUnreportedTasks("m1")).toEqual([]);
    const completed = history().find((i) => i.role === "first_officer")!;
    expect(completed.reportMeta).toEqual({ tasks: [{ agent: "sam", taskId: "sam_0001" }] });
  });

  it("a nonexistent taskId is not recorded (a measure against hallucination)", async () => {
    finishedTask("sam_0001");
    behaviors.push(async (_t, client) => {
      bridge.recordUnreportedFetch({ agent: "first_officer", missionId: "m1" }, ["sam_0001", "ghost_9999"]);
      client.emit("chunk", "report");
      return { stopReason: "end_turn" };
    });
    send("report");
    await idle();
    const completed = history().find((i) => i.role === "first_officer")!;
    expect(completed.reportMeta?.tasks.map((t) => t.taskId)).toEqual(["sam_0001"]);
  });

  it("a record whose caller crew member/mission does not match is ignored", async () => {
    finishedTask("sam_0001");
    behaviors.push(async (_t, client) => {
      bridge.recordUnreportedFetch({ agent: "chief_engineer", missionId: "m1" }, ["sam_0001"]); // another crew member
      bridge.recordUnreportedFetch({ agent: "first_officer", missionId: "m2" }, ["sam_0001"]); // another mission
      client.emit("chunk", "report");
      return { stopReason: "end_turn" };
    });
    send("report");
    await idle();
    expect(getUnreportedTasks("m1").map((t) => t.taskId)).toEqual(["sam_0001"]);
    expect(history().find((i) => i.role === "first_officer")!.reportMeta).toBeUndefined();
  });

  it("the record of a turn that ended in an error is discarded and does not become reported", async () => {
    finishedTask("sam_0001");
    behaviors.push(async () => {
      bridge.recordUnreportedFetch({ agent: "first_officer", missionId: "m1" }, ["sam_0001"]);
      throw new Error("boom");
    });
    send("report");
    await idle();
    expect(getUnreportedTasks("m1").map((t) => t.taskId)).toEqual(["sam_0001"]);
  });
});

describe("a failure after the outcome is recorded does not record a second outcome", () => {
  it("a stream file that cannot be removed after a completed turn leaves the completion as it is (no error row after it)", async () => {
    behaviors.push(reply("done"));
    vi.spyOn(turnStreams, "clear").mockRejectedValue(new Error("EPERM"));
    send("hello");
    await idle();
    const rows = history();
    expect(rows.at(-1)).toMatchObject({ role: "first_officer", text: "done" });
    expect(rows.some((r) => String(r.text).includes("Error"))).toBe(false);
  });
});

describe("stop (cancel) always takes effect at any stage", () => {
  it("it can be stopped even while waiting for the session to start: the startup is aborted, it ends as \"cancelled\" not as an error, and the mission is released", async () => {
    makeBridge({ hangStartup: true });
    send("hello");
    await vi.waitFor(() => expect(clients[0]?.initializeCalls).toBe(1)); // waiting for startup (does not respond)

    expect(bridge.isMissionBusy("m1")).toBe(true);
    expect(bridge.cancelMessage("m1")).toBe(true);
    await idle();

    expect(clients[0].killed).toBe(true);
    const last = history().at(-1)!;
    expect(last).toMatchObject({ role: "first_officer", cancelled: true });
    expect(last.text).not.toContain("Error");
    expect(bridge.isMissionBusy("m1")).toBe(false);
  });

  it("after a stop, one can send again in the same mission (it responds normally with a new client)", async () => {
    makeBridge({ hangStartup: true });
    send("hello");
    await vi.waitFor(() => expect(clients[0]?.initializeCalls).toBe(1));
    bridge.cancelMessage("m1");
    await idle();

    makeBridge(); // from here on, a provider that responds
    behaviors.push(reply("hi"));
    send("once more");
    await idle();
    expect(history().at(-1)).toMatchObject({ role: "first_officer", text: "hi" });
  });

  it("even if the other side does not honor the cancel (is hung), it is forcibly cut off after the grace period and ends as \"cancelled\"", async () => {
    makeBridge({ cancelGraceMs: 40 });
    const hung = deferred(); // still not responding
    behaviors.push(hung.behavior);
    send("hello");
    await hung.started;

    expect(bridge.cancelMessage("m1")).toBe(true);
    expect(clients[0].cancels).toHaveLength(1); // send the cancel first
    expect(bridge.isMissionBusy("m1")).toBe(true); // the other side does not comply, so it does not end yet

    await idle(); // it is forcibly cut off after the grace period
    expect(clients[0].killed).toBe(true);
    expect(history().at(-1)).toMatchObject({ role: "first_officer", cancelled: true });
    expect(bridge.isMissionBusy("m1")).toBe(false);
  });

  it("if sending the cancel itself fails (the agent's stdin is gone), the forced cut-off still happens", async () => {
    makeBridge({ cancelGraceMs: 40 });
    const hung = deferred();
    behaviors.push(hung.behavior);
    send("hello");
    await hung.started;
    clients[0].sendCancel = () => { throw new Error("ACP process stdin is not writable"); };

    expect(bridge.cancelMessage("m1")).toBe(true); // does not throw
    await idle();
    expect(clients[0].killed).toBe(true);
    expect(history().at(-1)).toMatchObject({ role: "first_officer", cancelled: true });
  });

  it("if the other side honors the cancel, there is no forced termination (the session stays alive)", async () => {
    makeBridge({ cancelGraceMs: 40 });
    const slow = deferred();
    behaviors.push(slow.behavior);
    send("hello");
    await slow.started;

    bridge.cancelMessage("m1");
    slow.release("partway"); // ends by complying with the cancel (deferred returns with end_turn)
    await idle();
    await new Promise((resolve) => setTimeout(resolve, 80)); // even past the grace period
    expect(clients[0].killed).toBe(false);
  });

  it("if there is no turn in progress, returns false (does nothing)", () => {
    expect(bridge.cancelMessage("m1")).toBe(false);
  });
});
