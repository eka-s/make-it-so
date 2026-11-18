import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrewManager } from "./crew-manager.js";
import { crewResultPath } from "./crew-paths.js";
import type { CrewRunner } from "./crew-runner.js";
import { taskSessionScope } from "./crew-runner.js";
import { connectCrewEvents } from "./crew-events.js";
import {
  closeDatabase,
  createMission,
  getTaskDetail,
  getTaskStarted,
  getUnreportedTasks,
  isTaskCancelled,
  initDatabase,
  recordTaskStarted,
} from "./database.js";
import { listPending, resolvePermission } from "./permission-registry.js";
import { addConnection, removeConnection } from "./sse-emitter.js";
import * as timeline from "./timeline.js";

// CrewRunner / CrewManager are fakes based on EventEmitter; events are fired and we look at what happens to the DB, the timeline, SSE,
// pending permissions, and result files. The DB is in-memory, and files are in a temporary directory.
let root: string;
let runner: EventEmitter;
let manager: EventEmitter;
let broadcast: ReturnType<typeof vi.fn>;
const activityLog = { recordCall: vi.fn(), recordOutput: vi.fn(), finish: vi.fn() };
/** The turn that issued the task, as the runner passes it in the "started" event (taken when the task was dispatched). */
let currentTurnId: string | null;
const touched: string[] = [];
const sseIds: string[] = [];

const roles: Record<string, string> = { sam: "chief_engineer", chief_engineer: "chief_engineer", first_officer: "first_officer" };

function resultFile(agent: string, taskId: string): string {
  return crewResultPath(root, agent, taskId);
}
function writeResult(agent: string, taskId: string, text: string): void {
  const file = resultFile(agent, taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Connects a fake connection to SSE's bridge channel and collects what is received. */
function listenSse(): { written: () => string } {
  let written = "";
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      written += chunk;
      return true;
    }),
    on: vi.fn(),
  } as unknown as Response;
  sseIds.push(addConnection(res, "bridge"));
  return { written: () => written };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mis-crewevents-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  initDatabase({ path: ":memory:", agentToRole: (agent) => roles[agent] ?? "first_officer" });
  createMission("m1", "Test");
  timeline.configureTimeline({ readTaskText: async () => "", readTurnText: async () => "" });
  activityLog.recordCall.mockClear(); activityLog.recordOutput.mockClear(); activityLog.finish.mockClear();
  runner = new EventEmitter();
  manager = new EventEmitter();
  broadcast = vi.fn();
  currentTurnId = "turn-1";
  connectCrewEvents({
    crewRunner: runner as unknown as CrewRunner,
    crewManager: manager as unknown as CrewManager,
    agentsDir: root,
    agentToRole: (agent) => roles[agent] ?? "first_officer",
    broadcast,
    activityLog,
  });
});
afterEach(() => {
  for (const id of touched.splice(0)) timeline.forget(id);
  for (const id of sseIds.splice(0)) removeConnection(id);
  for (const p of listPending()) resolvePermission(p.key);
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function start(taskId = "sam_0001", agent = "sam", instruction = "  fix it  "): void {
  touched.push(taskId);
  runner.emit("started", taskId, agent, "fix_bug", instruction, "m1", "first_officer", currentTurnId ?? undefined);
}

describe("issuing a task (started)", () => {
  it("leaves a permanent record (DB) and shows the running card in the timeline. Whitespace around the instruction is removed", () => {
    start();
    expect(getTaskStarted("sam_0001")).toMatchObject({
      agent: "sam",
      taskName: "fix_bug",
      instruction: "fix it",
      turnId: "turn-1",
      missionId: "m1",
    });
    expect(timeline.get("sam_0001")).toMatchObject({
      id: "sam_0001",
      missionId: "m1",
      role: "chief_engineer",
      text: "",
      status: "streaming",
      taskName: "fix_bug",
      instruction: "fix it",
      turnId: "turn-1",
    });
  });

  it("if there is no issuing turn, no turnId is attached", () => {
    currentTurnId = null;
    start();
    expect(getTaskStarted("sam_0001")?.turnId).toBeNull();
    expect(timeline.get("sam_0001")).not.toHaveProperty("turnId");
  });

  it("if the instruction is only whitespace, instruction is not put on the card", () => {
    start("sam_0001", "sam", "   ");
    expect(timeline.get("sam_0001")).not.toHaveProperty("instruction");
  });
});

describe("running display", () => {
  it("a chunk flows to SSE as a delta (it is not accumulated in memory)", () => {
    start();
    const sse = listenSse();
    runner.emit("chunk", "sam_0001", "sam", "in progress");
    expect(sse.written()).toContain("event: timeline:append");
    expect(sse.written()).toContain('"id":"sam_0001"');
    expect(sse.written()).toContain("in progress");
    expect(timeline.get("sam_0001")?.text).toBe("");
  });

  it("toolCall / toolCallUpdate are recorded in the activity log under the task id, and finish when the task ends or fails", () => {
    runner.emit("toolCall", "sam_0001", "sam", "Read file");
    runner.emit("toolCallUpdate", "sam_0001", "sam", "output");
    expect(activityLog.recordCall).toHaveBeenCalledWith("sam_0001", "Read file");
    expect(activityLog.recordOutput).toHaveBeenCalledWith("sam_0001", "output");
    runner.emit("error", "sam_0001", "sam", "boom");
    expect(activityLog.finish).toHaveBeenCalledWith("sam_0001");
  });
});

describe("task completion (done)", () => {
  it("records the contents of the result file in the DB, finalizes the card, and deletes the file", async () => {
    start();
    writeResult("sam", "sam_0001", "  fixed\n");
    runner.emit("done", "sam_0001", "sam", { credits: 0.5, turnDurationMs: 1200, unit: "usd" });

    await vi.waitFor(() => expect(getTaskDetail("sam_0001")?.status).toBe("done"));
    expect(getTaskDetail("sam_0001")).toMatchObject({
      text: "fixed",
      status: "done",
      taskName: "fix_bug",
      instruction: "fix it",
      credits: { credits: 0.5, turnDurationMs: 1200, unit: "usd" },
    });
    // the card is finalized and removed from live, and the result file is deleted
    await vi.waitFor(() => expect(fs.existsSync(resultFile("sam", "sam_0001"))).toBe(false));
    expect(timeline.get("sam_0001")).toBeUndefined();
    expect(getUnreportedTasks("m1").map((t) => t.taskId)).toEqual(["sam_0001"]);
  });

  it("a cancelled task keeps its partial output and is marked cancelled on the card and in the history", async () => {
    start();
    writeResult("sam", "sam_0001", "half of it\n");
    runner.emit("done", "sam_0001", "sam", undefined, true);

    await vi.waitFor(() => expect(getTaskDetail("sam_0001")?.status).toBe("done"));
    expect(getTaskDetail("sam_0001")).toMatchObject({ text: "half of it", cancelled: true });
    expect(isTaskCancelled("sam_0001")).toBe(true);
  });

  it("even without a running card (e.g. after a process restart), it can be restored from the record made at issue time and finalized", async () => {
    // a state where only the issue record is in the DB and there is nothing in the timeline's live
    recordTaskStarted("sam_0002", "m1", "sam", "after_restart", "instruction", "turn-9", "first_officer");
    writeResult("sam", "sam_0002", "result");
    runner.emit("done", "sam_0002", "sam");

    await vi.waitFor(() => expect(getTaskDetail("sam_0002")?.status).toBe("done"));
    expect(getTaskDetail("sam_0002")).toMatchObject({ text: "result", taskName: "after_restart" });
    expect(timeline.get("sam_0002")).toBeUndefined();
  });

  it("if there is no result file, it is recorded as an empty result (it does not get stuck)", async () => {
    start();
    runner.emit("done", "sam_0001", "sam");
    await vi.waitFor(() => expect(getTaskDetail("sam_0001")?.status).toBe("done"));
    expect(getTaskDetail("sam_0001")?.text).toBe("");
  });

  it("once the completion is recorded, a failure in showing it does not also record an error for the same task", async () => {
    start();
    writeResult("sam", "sam_0001", "fixed");
    vi.spyOn(timeline, "upsert").mockImplementation(() => { throw new Error("display broke"); });
    runner.emit("done", "sam_0001", "sam");

    await vi.waitFor(() => expect(getTaskDetail("sam_0001")?.status).toBe("done"));
    await new Promise((resolve) => setTimeout(resolve, 30)); // time for any (wrong) error row to be written
    expect(getTaskDetail("sam_0001")?.status).toBe("done");
    expect(getTaskDetail("sam_0001")?.text).toBe("fixed");
  });

  it("if reading the result fails, the card is not left stuck and it is recorded as an error", async () => {
    start();
    // put a directory at the result file's location to cause a read failure other than ENOENT
    fs.mkdirSync(resultFile("sam", "sam_0001"), { recursive: true });
    runner.emit("done", "sam_0001", "sam");

    await vi.waitFor(() => expect(getTaskDetail("sam_0001")?.status).toBe("error"));
    expect(getTaskDetail("sam_0001")?.text).toContain("⚠️ Error:");
    expect(timeline.get("sam_0001")).toBeUndefined();
  });
});

describe("task failure (error)", () => {
  it("saves what was output up to the failure, records the error, and deletes the file", async () => {
    start();
    writeResult("sam", "sam_0001", "got this far");
    runner.emit("error", "sam_0001", "sam", "timeout");

    await vi.waitFor(() => expect(getTaskDetail("sam_0001")?.status).toBe("error"));
    expect(getTaskDetail("sam_0001")?.text).toContain("⚠️ Error: timeout");
    await vi.waitFor(() => expect(fs.existsSync(resultFile("sam", "sam_0001"))).toBe(false));
    expect(timeline.get("sam_0001")).toBeUndefined();
  });

  it("even without a running card, the mission is restored from the record made at issue time and recorded", async () => {
    recordTaskStarted("sam_0003", "m1", "sam", "x", "i", undefined, "first_officer");
    runner.emit("error", "sam_0003", "sam", "failure");
    await vi.waitFor(() => expect(getTaskDetail("sam_0003")?.status).toBe("error"));
    expect(getUnreportedTasks("m1").map((t) => t.taskId)).toEqual(["sam_0003"]);
  });
});

describe("permission (during a running task)", () => {
  const request = { requestId: 5, sessionId: "s", toolName: "Write", toolInput: { a: 1 }, options: [] };

  it("registered as pending. The key contains the task marker, and the scope is for task running", () => {
    runner.emit("permissionRequest", "sam", request, "sam_0001", "m1");
    expect(listPending()).toHaveLength(1);
    expect(listPending()[0]).toMatchObject({
      key: "sam:task:m1:5",
      scope: "sam",
      missionId: taskSessionScope("m1"),
      ownerMissionId: "m1", // the real mission ID, not the scope string
      role: "chief_engineer", // even if it comes with an acp_agent name ("sam"), it is aligned to the role
      requestId: 5,
      taskId: "sam_0001",
      toolName: "Write",
    });
  });

  it("registered without being dropped even if the taskId is not settled", () => {
    runner.emit("permissionRequest", "sam", request, undefined, "m1");
    expect(listPending()).toHaveLength(1);
  });

  it("when the task process dies, only that crew member's requests for that mission are discarded", () => {
    runner.emit("permissionRequest", "sam", { ...request, requestId: 1 }, "t1", "m1");
    runner.emit("permissionRequest", "sam", { ...request, requestId: 2 }, "t2", "m2");
    runner.emit("permissionRequest", "jo", { ...request, requestId: 3 }, "t3", "m1");

    runner.emit("agentExited", "sam", "m1");

    expect(listPending().map((p) => p.key).sort()).toEqual(["jo:task:m1:3", "sam:task:m2:2"]);
  });
});

describe("crew state signal", () => {
  it("when the conversation session's starting/restarting changes, a signal is sent to the screen", () => {
    manager.emit("sessionStatusChanged", "chief_engineer", "m1");
    expect(broadcast).toHaveBeenCalledWith({ type: "crew:status_changed", data: { role: "chief_engineer", missionId: "m1" } });
  });
});

describe("permission (during a conversation)", () => {
  const request = { requestId: 7, sessionId: "s", toolName: "Edit", toolInput: {}, options: [] };

  it("registered as pending (the key does not collide with the task one)", () => {
    manager.emit("permissionRequest", "chief_engineer", request, "m1");
    expect(listPending()[0]).toMatchObject({ key: "chief_engineer:m1:7", scope: "chief_engineer", missionId: "m1", ownerMissionId: "m1", role: "chief_engineer", requestId: 7 });
  });

  it("a request with the task-running scope is not picked up here (the task side handles it)", () => {
    manager.emit("permissionRequest", "sam", request, taskSessionScope("m1"));
    expect(listPending()).toEqual([]);
  });

  it("when the conversation session dies, that crew member's and mission's requests are discarded", () => {
    manager.emit("permissionRequest", "chief_engineer", { ...request, requestId: 1 }, "m1");
    manager.emit("permissionRequest", "chief_engineer", { ...request, requestId: 2 }, "m2");

    manager.emit("agentExited", "chief_engineer", "m1");

    expect(listPending().map((p) => p.key)).toEqual(["chief_engineer:m2:2"]);
  });

  it("even if a task-running scope process dies, the conversation side does no discarding or notification", () => {
    manager.emit("agentExited", "sam", taskSessionScope("m1"));
    expect(broadcast).not.toHaveBeenCalled();
  });
});
