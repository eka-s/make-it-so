import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createMission, getTaskDetail, getTimelineEventsHistory, initDatabase, recordCaptainMessage, recordTaskCompleted, recordTaskStarted, recordTurnCompleted, recordTurnError, recordTurnStarted } from "./database.js";
import { findInterruptedWork, recordInterruptedWork } from "./recover-interrupted.js";
import { SERVER_MESSAGES } from "./messages.js";
import { createTurnStreams } from "./turn-stream.js";
import { clearFileStream, readFileStream } from "./file-stream.js";

let root: string;
let turnStreams: ReturnType<typeof createTurnStreams>;
const taskFile = (agent: string, taskId: string) => path.join(root, "agents", agent, `${taskId}.md`);
const logs: string[] = [];

/** What a start does: look up before binding the port, record after. */
const recover = () => recordInterruptedWork(findInterruptedWork(turnStreams), deps());

const deps = () => ({
  turnStreams,
  taskFiles: { read: (a: string, t: string) => readFileStream(taskFile(a, t)), clear: (a: string, t: string) => clearFileStream(taskFile(a, t)) },
  log: (m: string) => logs.push(m),
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mis-recover-"));
  turnStreams = createTurnStreams(path.join(root, "turns"));
  initDatabase({ path: ":memory:", agentToRole: (agent) => agent });
  createMission("m1", "Test");
  logs.length = 0;
});
afterEach(() => {
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

async function leaveTurnFile(turnId: string, text: string): Promise<void> {
  await using stream = turnStreams.open(turnId);
  stream.write(text);
}

describe("recordInterruptedWork: turns", () => {
  it("a turn cut off while it streamed is recorded as interrupted, keeping what was written, and its file is removed", async () => {
    recordCaptainMessage("do it", "m1");
    recordTurnStarted("t1", "m1", "first_officer");
    await leaveTurnFile("t1", "half an answ");

    expect(await recover()).toEqual({ turns: 1, tasks: 0 });

    const last = getTimelineEventsHistory({ missionId: "m1" }).items.at(-1)!;
    expect(last).toMatchObject({ id: "t1", role: "first_officer", messageKey: "interrupted", text: SERVER_MESSAGES.interrupted });
    expect(turnStreams.exists("t1")).toBe(false);
    // doing it again finds nothing: the outcome is recorded
    expect(await recover()).toEqual({ turns: 0, tasks: 0 });
  });

  it("a turn that ended without a shown reply on purpose (empty response: no outcome, no file) is left alone", async () => {
    recordTurnStarted("t-empty", "m1", "first_officer");
    expect(await recover()).toEqual({ turns: 0, tasks: 0 });
    expect(getTimelineEventsHistory({ missionId: "m1" }).items).toEqual([]);
  });

  it("a turn that completed is left alone, whatever file is around", async () => {
    recordTurnStarted("t2", "m1", "first_officer");
    recordTurnCompleted("t2", "m1", "answer", undefined, undefined, "first_officer");
    await leaveTurnFile("t2", "stale");
    expect(await recover()).toEqual({ turns: 0, tasks: 0 });
  });
});

describe("recordInterruptedWork: crew tasks", () => {
  it("a task that started and has no outcome is recorded as an error with its partial output, so it does not vanish", async () => {
    recordTaskStarted("sam_0001", "m1", "sam", "fix_bug", "fix it", undefined, "first_officer");
    fs.mkdirSync(path.dirname(taskFile("sam", "sam_0001")), { recursive: true });
    fs.writeFileSync(taskFile("sam", "sam_0001"), "found the cause\n");

    expect(await recover()).toEqual({ turns: 0, tasks: 1 });

    expect(getTaskDetail("sam_0001")).toMatchObject({ status: "error", text: expect.stringContaining("Interrupted") });
    expect(fs.existsSync(taskFile("sam", "sam_0001"))).toBe(false);
  });

  it("a task with no file at all (cut off while its session was starting) is recorded too", async () => {
    recordTaskStarted("sam_0002", "m1", "sam", "x", "y", undefined, "first_officer");
    expect(await recover()).toEqual({ turns: 0, tasks: 1 });
  });

  it("a completed task is left alone", async () => {
    recordTaskStarted("sam_0003", "m1", "sam", "x", "y", undefined, "first_officer");
    recordTaskCompleted("sam_0003", "m1", "done");
    expect(await recover()).toEqual({ turns: 0, tasks: 0 });
  });
});

describe("what is looked up before the port is bound", () => {
  it("a turn that starts after the look-up is not taken for an interrupted one (the look-up is a snapshot)", async () => {
    recordTurnStarted("t-old", "m1", "first_officer");
    await leaveTurnFile("t-old", "cut off");
    const work = findInterruptedWork(turnStreams);

    // a new turn begins while the old one is being recorded
    recordTurnStarted("t-new", "m1", "first_officer");
    await leaveTurnFile("t-new", "live");

    expect(await recordInterruptedWork(work, deps())).toEqual({ turns: 1, tasks: 0 });
    expect(turnStreams.exists("t-new")).toBe(true); // untouched
    expect(turnStreams.exists("t-old")).toBe(false);
  });

  it("looking up changes nothing (a process that then fails to bind leaves the running ship alone)", async () => {
    recordTurnStarted("t-live", "m1", "first_officer");
    await leaveTurnFile("t-live", "streaming");
    recordTaskStarted("sam_0009", "m1", "sam", "x", "y", undefined, "first_officer");
    findInterruptedWork(turnStreams); // and then the bind fails: nothing is recorded
    expect(turnStreams.exists("t-live")).toBe(true);
    expect(getTaskDetail("sam_0009")?.status).not.toBe("error");
  });
});

describe("what the captain sees after an interruption", () => {
  it("the text written so far is shown with the card (a turn), so that 'what was written is kept' is true on screen", async () => {
    recordTurnStarted("t-show", "m1", "first_officer");
    await leaveTurnFile("t-show", "half an answ");
    await recover();
    const item = getTimelineEventsHistory({ missionId: "m1" }).items.find((i) => i.id === "t-show")!;
    expect(item).toMatchObject({ messageKey: "interrupted", partialText: "half an answ" });
  });

  it("the same for a crew task", async () => {
    recordTaskStarted("sam_0042", "m1", "sam", "x", "y", undefined, "first_officer");
    fs.mkdirSync(path.dirname(taskFile("sam", "sam_0042")), { recursive: true });
    fs.writeFileSync(taskFile("sam", "sam_0042"), "found it\n");
    await recover();
    const item = getTimelineEventsHistory({ missionId: "m1" }).items.find((i) => i.id === "sam_0042")!;
    expect(item.partialText).toBe("found it");
  });

  it("an ordinary error does not carry partial text (as before)", () => {
    recordTurnStarted("t-err", "m1", "first_officer");
    recordTurnError("t-err", "m1", "some partial", "⚠️ Error: boom", "first_officer");
    const item = getTimelineEventsHistory({ missionId: "m1" }).items.find((i) => i.id === "t-err")!;
    expect(item).not.toHaveProperty("partialText");
  });
});
