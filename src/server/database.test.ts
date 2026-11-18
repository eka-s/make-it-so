import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MISSION_ID,
  closeDatabase,
  createMission,
  createPinnedMessage,
  deletePinnedMessage,
  getMissionTranscript,
  getProviderCommands,
  getTaskDetail,
  searchTimeline,
  type SearchQuery,
  saveProviderCommands,
  getPinnedMessages,
  getTaskHistory,
  getTaskOutcome,
  recordTurnCancelled,
  recordTurnRecoveryStarted,
  recordTurnStarted,
  getTaskStarted,
  getTimelineEventsHistory,
  getTimelineRange,
  findTimelineKey,
  getUnreportedTasks,
  initDatabase,
  getCrewModelOverride,
  setCrewModelOverride,
  getProviderModelOptions,
  saveProviderModelOptions,
  getSetting,
  setSetting,
  recordSystemNotice,
  recordTurnError,
  listMissions,
  missionExists,
  nextTaskId,
  recordCaptainMessage,
  recordTaskCompleted,
  recordTaskError,
  recordTaskStarted,
  recordTurnCompleted,
  setMissionArchived,
} from "./database.js";

// The database is in-memory, and each test starts from a blank state. Resolving role names
// depends on the ship's composition, so a mapping for tests is passed in.
const roles: Record<string, string> = { sam: "chief_engineer", data: "logic_officer" };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initDatabase({ path: ":memory:", agentToRole: (agent) => roles[agent] ?? "first_officer" });
});
afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("initialization", () => {
  it("using it before initialization gives a clear exception", () => {
    closeDatabase();
    expect(() => listMissions()).toThrow(/not initialized/);
  });

  it("the default mission (bridge) exists from the start", () => {
    expect(missionExists(DEFAULT_MISSION_ID)).toBe(true);
    expect(listMissions().map((m) => m.id)).toContain(DEFAULT_MISSION_ID);
  });

  it("initializing again switches to a blank database", () => {
    createMission("m1", "Test");
    expect(missionExists("m1")).toBe(true);
    initDatabase({ path: ":memory:", agentToRole: () => "first_officer" });
    expect(missionExists("m1")).toBe(false);
  });
});

describe("missions", () => {
  it("can be created, listed, and checked for existence", () => {
    const mission = createMission("m1", "Test mission");
    expect(mission).toMatchObject({ id: "m1", name: "Test mission" });
    expect(mission.archivedAt).toBeNull();
    expect(missionExists("m1")).toBe(true);
    expect(missionExists("nope")).toBe(false);
  });

  it("archive/restore is not a deletion; archivedAt toggles while it stays in the list", () => {
    createMission("m1", "x");
    expect(setMissionArchived("m1", true)?.archivedAt).not.toBeNull();
    expect(listMissions().map((m) => m.id)).toContain("m1");
    expect(setMissionArchived("m1", false)?.archivedAt).toBeNull();
  });

  it("archiving a nonexistent mission is undefined (the caller turns it into a 404)", () => {
    expect(setMissionArchived("nope", true)).toBeUndefined();
  });
});

describe("nextTaskId", () => {
  it("assigns a 4-digit zero-padded sequence number per crew member", () => {
    expect(nextTaskId("sam")).toBe("sam_0001");
    expect(nextTaskId("sam")).toBe("sam_0002");
    expect(nextTaskId("sam")).toBe("sam_0003");
  });

  it("independent of another crew member's sequence", () => {
    nextTaskId("sam");
    nextTaskId("sam");
    expect(nextTaskId("jo")).toBe("jo_0001");
    expect(nextTaskId("sam")).toBe("sam_0003");
  });

  it("IDs do not collide even for a run of the same synchronous calls", () => {
    const ids = Array.from({ length: 50 }, () => nextTaskId("sam"));
    expect(new Set(ids).size).toBe(50);
  });
});

describe("messages the server writes itself", () => {
  it("a notice and a turn error keep their message key; free text has none", async () => {
    recordSystemNotice("ℹ️ Re-run automatically after a recovery", DEFAULT_MISSION_ID, "first_officer", "recovery_rerun");
    await sleep(3);
    recordTurnError("turn-1", DEFAULT_MISSION_ID, null, "❌ Automatic recovery failed", "first_officer", "recovery_failed");
    await sleep(3);
    recordTurnError("turn-2", DEFAULT_MISSION_ID, null, "⚠️ Error: boom", "first_officer");

    const { items } = getTimelineEventsHistory({ missionId: DEFAULT_MISSION_ID });
    expect(items.map((i) => [i.text, i.messageKey])).toEqual([
      ["ℹ️ Re-run automatically after a recovery", "recovery_rerun"],
      ["❌ Automatic recovery failed", "recovery_failed"],
      ["⚠️ Error: boom", undefined],
    ]);
  });
});

describe("timeline history", () => {
  it("the captain's messages and the crew's responses are returned in chronological order, and the role is resolved with the injected mapping", async () => {
    recordCaptainMessage("good morning", DEFAULT_MISSION_ID);
    await sleep(3);
    recordTurnCompleted("turn-1", DEFAULT_MISSION_ID, "good morning to you", undefined, undefined, "sam");

    const { items, hasMore } = getTimelineEventsHistory({ missionId: DEFAULT_MISSION_ID });
    expect(hasMore).toBe(false);
    expect(items.map((i) => [i.role, i.text])).toEqual([
      ["captain", "good morning"],
      ["chief_engineer", "good morning to you"],
    ]);
    expect(items.every((i) => i.missionId === DEFAULT_MISSION_ID)).toBe(true);
  });

  it("an agent not in the mapping is treated as first_officer", () => {
    recordTurnCompleted("turn-1", DEFAULT_MISSION_ID, "x", undefined, undefined, "someone-unknown");
    expect(getTimelineEventsHistory().items[0].role).toBe("first_officer");
  });

  it("can be narrowed by mission (conversations of other missions do not mix in). If omitted, across all missions", () => {
    createMission("m1", "x");
    recordCaptainMessage("bridge message", DEFAULT_MISSION_ID);
    recordCaptainMessage("m1 message", "m1");

    expect(getTimelineEventsHistory({ missionId: "m1" }).items.map((i) => i.text)).toEqual(["m1 message"]);
    expect(getTimelineEventsHistory({ missionId: DEFAULT_MISSION_ID }).items.map((i) => i.text)).toEqual(["bridge message"]);
    expect(getTimelineEventsHistory().items).toHaveLength(2);
  });

  it("beyond limit, the newest `limit` are returned in chronological order, and hasMore is true", async () => {
    for (const text of ["1", "2", "3"]) {
      recordCaptainMessage(text, DEFAULT_MISSION_ID);
      await sleep(3);
    }
    const page = getTimelineEventsHistory({ limit: 2 });
    expect(page.items.map((i) => i.text)).toEqual(["2", "3"]);
    expect(page.hasMore).toBe(true);
  });

  it("if before is given, only what is before it is returned (paging)", async () => {
    for (const text of ["1", "2", "3"]) {
      recordCaptainMessage(text, DEFAULT_MISSION_ID);
      await sleep(3);
    }
    const newest = getTimelineEventsHistory({ limit: 1 }).items[0];
    const older = getTimelineEventsHistory({ before: findTimelineKey(newest.id, DEFAULT_MISSION_ID)!, limit: 10 });
    expect(older.items.map((i) => i.text)).toEqual(["1", "2"]);
    expect(older.hasMore).toBe(false);
  });

  it("paging back loses nothing when several events share one millisecond (the position is time and id, not time alone)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z")); // every message below gets the same occurred_at
      for (const n of [1, 2, 3, 4, 5]) recordCaptainMessage(`m${n}`, DEFAULT_MISSION_ID);
    } finally {
      vi.useRealTimers();
    }
    const newest = getTimelineEventsHistory({ limit: 2 }); // m4, m5
    expect(newest.items.map((i) => i.text)).toEqual(["m4", "m5"]);
    const second = getTimelineEventsHistory({ limit: 2, before: findTimelineKey(newest.items[0].id, DEFAULT_MISSION_ID)! });
    expect(second.items.map((i) => i.text)).toEqual(["m2", "m3"]);
    const third = getTimelineEventsHistory({ limit: 2, before: findTimelineKey(second.items[0].id, DEFAULT_MISSION_ID)! });
    expect(third.items.map((i) => i.text)).toEqual(["m1"]);
    expect(third.hasMore).toBe(false);
  });

  it("a limit that is not a positive whole number falls back to the default instead of failing", () => {
    recordCaptainMessage("a", DEFAULT_MISSION_ID);
    for (const limit of [Number.NaN, 0, -1, 1.5]) {
      expect(getTimelineEventsHistory({ limit }).items.map((i) => i.text), String(limit)).toEqual(["a"]);
    }
  });
});

describe("crew tasks", () => {
  it("the issue-time information (agent, name, instruction, mission) can be looked up later", () => {
    createMission("m1", "x");
    recordTaskStarted("sam_0001", "m1", "sam", "research", "look into it", "turn-1", "first_officer");
    expect(getTaskStarted("sam_0001")).toMatchObject({
      agent: "sam",
      taskName: "research",
      instruction: "look into it",
      turnId: "turn-1",
      missionId: "m1",
    });
    expect(getTaskStarted("nope")).toBeNull();
  });

  it("unreported tasks are, among those that reached a terminal state by completing/erroring, only those not yet reported", () => {
    recordTaskStarted("sam_0001", DEFAULT_MISSION_ID, "sam", "the completed one", "i", undefined, "first_officer");
    recordTaskStarted("sam_0002", DEFAULT_MISSION_ID, "sam", "the one that errored", "i", undefined, "first_officer");
    recordTaskStarted("sam_0003", DEFAULT_MISSION_ID, "sam", "the running one", "i", undefined, "first_officer");
    recordTaskCompleted("sam_0001", DEFAULT_MISSION_ID, "result");
    recordTaskError("sam_0002", DEFAULT_MISSION_ID, null, "failure");

    expect(getUnreportedTasks().map((t) => t.taskId).sort()).toEqual(["sam_0001", "sam_0002"]);
  });

  it("a task that a turn reported is no longer unreported", () => {
    recordTaskStarted("sam_0001", DEFAULT_MISSION_ID, "sam", "a", "i", undefined, "first_officer");
    recordTaskStarted("sam_0002", DEFAULT_MISSION_ID, "sam", "b", "i", undefined, "first_officer");
    recordTaskCompleted("sam_0001", DEFAULT_MISSION_ID, "r");
    recordTaskCompleted("sam_0002", DEFAULT_MISSION_ID, "r");

    recordTurnCompleted("turn-1", DEFAULT_MISSION_ID, "I will report", undefined, ["sam_0001"], "first_officer");

    expect(getUnreportedTasks().map((t) => t.taskId)).toEqual(["sam_0002"]);
  });

  it("unreported tasks can be narrowed by mission", () => {
    createMission("m1", "x");
    recordTaskStarted("sam_0001", DEFAULT_MISSION_ID, "sam", "a", "i", undefined, "first_officer");
    recordTaskStarted("sam_0002", "m1", "sam", "b", "i", undefined, "first_officer");
    recordTaskCompleted("sam_0001", DEFAULT_MISSION_ID, "r");
    recordTaskCompleted("sam_0002", "m1", "r");

    expect(getUnreportedTasks("m1").map((t) => t.taskId)).toEqual(["sam_0002"]);
    expect(getUnreportedTasks(DEFAULT_MISSION_ID).map((t) => t.taskId)).toEqual(["sam_0001"]);
    expect(getUnreportedTasks()).toHaveLength(2);
  });
});

describe("per-mission model overrides for crew members", () => {
  it("can be saved, updated, and removed, and are independent per mission and role", () => {
    expect(getCrewModelOverride("m1", "chief_engineer")).toBeUndefined();
    setCrewModelOverride("m1", "chief_engineer", "haiku");
    setCrewModelOverride("m2", "chief_engineer", "opus");
    expect(getCrewModelOverride("m1", "chief_engineer")).toBe("haiku");
    expect(getCrewModelOverride("m2", "chief_engineer")).toBe("opus");
    expect(getCrewModelOverride("m1", "first_officer")).toBeUndefined();

    setCrewModelOverride("m1", "chief_engineer", "sonnet");
    expect(getCrewModelOverride("m1", "chief_engineer")).toBe("sonnet");

    setCrewModelOverride("m1", "chief_engineer", null);
    expect(getCrewModelOverride("m1", "chief_engineer")).toBeUndefined();
    expect(getCrewModelOverride("m2", "chief_engineer")).toBe("opus");
  });
});

describe("cache of each provider's selectable model list", () => {
  it("saving, overwriting, reading. Empty if none", () => {
    expect(getProviderModelOptions("claude")).toEqual([]);
    saveProviderModelOptions("claude", [{ value: "opus", name: "Opus" }]);
    expect(getProviderModelOptions("claude")).toEqual([{ value: "opus", name: "Opus" }]);
    saveProviderModelOptions("claude", [{ value: "haiku", name: "Haiku" }]);
    expect(getProviderModelOptions("claude")).toEqual([{ value: "haiku", name: "Haiku" }]);
    expect(getProviderModelOptions("kiro")).toEqual([]);
  });
});

describe("app settings", () => {
  it("saves, overwrites and reads a setting; unknown keys are undefined", () => {
    expect(getSetting("language")).toBeUndefined();
    setSetting("language", "ja");
    expect(getSetting("language")).toBe("ja");
    setSetting("language", "en");
    expect(getSetting("language")).toBe("en");
    expect(getSetting("other")).toBeUndefined();
  });
});

describe("timeline range (jumping to an old item and filling gaps)", () => {
  const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 6 items in the default mission: c1 (captain), t1 (turn), c2, t2, c3, t3. Returns their ids in order. */
  async function history(): Promise<string[]> {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const c = recordCaptainMessage(`captain ${n}`, DEFAULT_MISSION_ID);
      ids.push(c.id);
      await sleepMs(3);
      recordTurnCompleted(`turn-${n}`, DEFAULT_MISSION_ID, `reply ${n}`, undefined, undefined, "first_officer");
      ids.push(`turn-${n}`);
      await sleepMs(3);
    }
    return ids;
  }
  const key = (id: string) => findTimelineKey(id, DEFAULT_MISSION_ID)!;
  const texts = (r: { items: Array<{ text: string }> }) => r.items.map((i) => i.text);

  it("finds the position of an item by event id and by turn id; unknown ids and other missions are null", async () => {
    const ids = await history();
    expect(key(ids[0]).seq).toBeLessThan(key(ids[1]).seq);
    expect(key("turn-2")).not.toBeNull();
    expect(findTimelineKey("turn-99", DEFAULT_MISSION_ID)).toBeNull();
    expect(findTimelineKey("event-99999", DEFAULT_MISSION_ID)).toBeNull();
    createMission("other", "other");
    expect(findTimelineKey("turn-2", "other")).toBeNull();
  });

  it("asc takes the oldest items right after `after`; inclusive starts at the item itself", async () => {
    const ids = await history();
    const base = { missionId: DEFAULT_MISSION_ID, dir: "asc" as const };
    expect(texts(getTimelineRange({ ...base, after: key(ids[1]), limit: 2 }))).toEqual(["captain 2", "reply 2"]);
    expect(texts(getTimelineRange({ ...base, after: key(ids[1]), afterInclusive: true, limit: 2 }))).toEqual(["reply 1", "captain 2"]);
  });

  it("desc takes the newest items right before `before`, in chronological order", async () => {
    const ids = await history();
    const r = getTimelineRange({ missionId: DEFAULT_MISSION_ID, before: key(ids[4]), dir: "desc", limit: 2 });
    expect(texts(r)).toEqual(["captain 2", "reply 2"]);
  });

  it("is complete only when the whole range fits in the limit", async () => {
    const ids = await history();
    const between = { missionId: DEFAULT_MISSION_ID, after: key(ids[0]), before: key(ids[4]), dir: "asc" as const };
    // between c1 and c3 there are 3 items: reply 1, captain 2, reply 2
    expect(getTimelineRange({ ...between, limit: 2 }).complete).toBe(false);
    expect(getTimelineRange({ ...between, limit: 3 }).complete).toBe(true);
    expect(texts(getTimelineRange({ ...between, limit: 3 }))).toEqual(["reply 1", "captain 2", "reply 2"]);
    expect(getTimelineRange({ ...between, limit: 3, dir: "desc" }).complete).toBe(true);
  });

  it("a range with nothing in it is complete and empty", async () => {
    const ids = await history();
    const r = getTimelineRange({ missionId: DEFAULT_MISSION_ID, after: key(ids[0]), before: key(ids[1]), dir: "asc", limit: 5 });
    expect(r).toEqual({ items: [], complete: true });
  });

  it("stays inside the mission", async () => {
    const ids = await history();
    createMission("other", "other");
    recordCaptainMessage("other mission", "other");
    const r = getTimelineRange({ missionId: DEFAULT_MISSION_ID, after: key(ids[0]), dir: "asc", limit: 50 });
    expect(texts(r)).not.toContain("other mission");
    expect(r.complete).toBe(true);
  });
});

describe("pinning", () => {
  const pin = (messageId: string, missionId = DEFAULT_MISSION_ID) =>
    createPinnedMessage({ message_id: messageId, role: "captain", text: `body-${messageId}`, timestamp: "2026-11-13T00:00:00.000Z", mission_id: missionId });

  it("the pin that was made returns the row that was made as is, and they are in the order pinned", async () => {
    const first = pin("event-1");
    await sleep(5);
    pin("event-2");
    expect(first).toMatchObject({ message_id: "event-1", role: "captain", text: "body-event-1", mission_id: DEFAULT_MISSION_ID });
    expect(getPinnedMessages().map((p) => p.message_id)).toEqual(["event-1", "event-2"]);
  });

  it("if a mission is specified, only that mission's pins are returned. If omitted, all missions", () => {
    createMission("m1", "Test");
    pin("event-1");
    pin("event-2", "m1");
    expect(getPinnedMessages({ missionId: "m1" }).map((p) => p.message_id)).toEqual(["event-2"]);
    expect(getPinnedMessages().map((p) => p.message_id).sort()).toEqual(["event-1", "event-2"]);
  });

  it("trying to pin the same message twice fails (message_id is unique)", () => {
    pin("event-1");
    expect(() => pin("event-1")).toThrow();
  });

  it("true if it could be deleted, false for a nonexistent id", () => {
    pin("event-1");
    expect(deletePinnedMessage("event-1")).toBe(true);
    expect(getPinnedMessages()).toEqual([]);
    expect(deletePinnedMessage("event-1")).toBe(false);
  });
});

describe("turn records (start, cancel, recovery start)", () => {
  it("the start and the recovery start do not by themselves create a chat item for display", () => {
    recordTurnStarted("t1", DEFAULT_MISSION_ID, "first_officer");
    recordTurnRecoveryStarted("t1", DEFAULT_MISSION_ID, "auto-recovering", "first_officer");
    expect(getTimelineEventsHistory({ missionId: DEFAULT_MISSION_ID }).items).toEqual([]);
  });

  it("a cancel shows the text up to that point as the response, and is separated per mission", () => {
    createMission("m1", "Test");
    recordTurnStarted("t1", "m1", "sam");
    recordTurnCancelled("t1", "m1", "partway", undefined, "sam");
    const items = getTimelineEventsHistory({ missionId: "m1" }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ role: "chief_engineer", text: "partway" });
    expect(getTimelineEventsHistory({ missionId: DEFAULT_MISSION_ID }).items).toEqual([]);
  });

  it("returns the recorded time", () => {
    const { timestamp } = recordTurnStarted("t1", DEFAULT_MISSION_ID, "first_officer");
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
  });
});

describe("fetching for the conversation preamble (getMissionTranscript)", () => {
  it("returns only the captain's messages and responses in chronological order. The responder's role is resolved from the agent name", () => {
    recordCaptainMessage("question", DEFAULT_MISSION_ID);
    recordTurnStarted("t1", DEFAULT_MISSION_ID, "sam");
    recordTurnCompleted("t1", DEFAULT_MISSION_ID, "answer", undefined, undefined, "sam");
    const { entries } = getMissionTranscript(DEFAULT_MISSION_ID, 0, 10);
    expect(entries.map((e) => [e.role, e.text])).toEqual([["captain", "question"], ["chief_engineer", "answer"]]);
  });

  it("returns only the delta after afterSeq. maxSeq advances to the latest event", () => {
    recordCaptainMessage("first", DEFAULT_MISSION_ID);
    const { maxSeq } = getMissionTranscript(DEFAULT_MISSION_ID, 0, 10);
    recordCaptainMessage("second", DEFAULT_MISSION_ID);
    const diff = getMissionTranscript(DEFAULT_MISSION_ID, maxSeq, 10);
    expect(diff.entries.map((e) => e.text)).toEqual(["second"]);
    expect(diff.maxSeq).toBeGreaterThan(maxSeq);
  });

  it("what exceeds limit is cut from the older side, but the reference point (maxSeq) advances to the latest", () => {
    for (const text of ["a", "b", "c"]) recordCaptainMessage(text, DEFAULT_MISSION_ID);
    const all = getMissionTranscript(DEFAULT_MISSION_ID, 0, 10);
    const limited = getMissionTranscript(DEFAULT_MISSION_ID, 0, 2);
    expect(limited.entries.map((e) => e.text)).toEqual(["b", "c"]);
    expect(limited.maxSeq).toBe(all.maxSeq);
  });

  it("conversations of other missions are not included. If there is no conversation, the reference point stays at afterSeq", () => {
    createMission("m1", "Test");
    recordCaptainMessage("m1 message", "m1");
    expect(getMissionTranscript(DEFAULT_MISSION_ID, 7, 10)).toEqual({ entries: [], maxSeq: 7 });
  });

  it("the result of a delegated task is not included in the conversation context", () => {
    recordTaskStarted("sam_0001", DEFAULT_MISSION_ID, "sam", "research", "instruction", undefined, "first_officer");
    recordTaskCompleted("sam_0001", DEFAULT_MISSION_ID, "result");
    expect(getMissionTranscript(DEFAULT_MISSION_ID, 0, 10).entries).toEqual([]);
  });
});

describe("task history and results", () => {
  const finish = (taskId: string, agent: string, missionId: string, outcome: "done" | "error") => {
    recordTaskStarted(taskId, missionId, agent, `name-${taskId}`, "instruction", undefined, "first_officer");
    if (outcome === "done") recordTaskCompleted(taskId, missionId, `report-${taskId}`);
    else recordTaskError(taskId, missionId, null, `failure-${taskId}`);
  };

  it("only tasks that reached a terminal state are returned, newest first (done for completed, error for errors)", () => {
    finish("sam_0001", "sam", DEFAULT_MISSION_ID, "done");
    finish("sam_0002", "sam", DEFAULT_MISSION_ID, "error");
    recordTaskStarted("sam_0003", DEFAULT_MISSION_ID, "sam", "running", "instruction", undefined, "first_officer");
    const { items, hasMore } = getTaskHistory("sam", 10);
    expect(items.map((i) => [i.taskId, i.status])).toEqual([["sam_0002", "error"], ["sam_0001", "done"]]);
    expect(hasMore).toBe(false);
  });

  it("if it exceeds limit, hasMore is true and only `limit` are returned. Can be narrowed by crew member and mission", () => {
    createMission("m1", "Test");
    finish("sam_0001", "sam", DEFAULT_MISSION_ID, "done");
    finish("sam_0002", "sam", "m1", "done");
    finish("sam_0003", "sam", "m1", "done");
    finish("jo_0001", "jo", "m1", "done");
    const page = getTaskHistory("sam", 2);
    expect(page.items.map((i) => i.taskId)).toEqual(["sam_0003", "sam_0002"]);
    expect(page.hasMore).toBe(true);
    expect(getTaskHistory("sam", 10, "m1").items.map((i) => i.taskId)).toEqual(["sam_0003", "sam_0002"]);
    expect(getTaskHistory("jo", 10, DEFAULT_MISSION_ID).items).toEqual([]);
  });

  it("the result is the report text if completed, the error text if errored. null for an incomplete or nonexistent id", () => {
    finish("sam_0001", "sam", DEFAULT_MISSION_ID, "done");
    finish("sam_0002", "sam", DEFAULT_MISSION_ID, "error");
    recordTaskStarted("sam_0003", DEFAULT_MISSION_ID, "sam", "running", "instruction", undefined, "first_officer");
    expect(getTaskOutcome("sam_0001")).toBe("report-sam_0001");
    expect(getTaskOutcome("sam_0002")).toBe("failure-sam_0002");
    expect(getTaskOutcome("sam_0003")).toBeNull();
    expect(getTaskOutcome("nothing")).toBeNull();
  });
});

describe("cache of each provider's slash commands", () => {
  it("the saved list can be read back per provider. Empty if none. Can be overwritten", () => {
    expect(getProviderCommands("claude")).toEqual([]);
    saveProviderCommands("claude", [{ name: "context", description: "d", hint: "[x]" }]);
    saveProviderCommands("kiro", [{ name: "usage", description: "u" }]);
    expect(getProviderCommands("claude")).toEqual([{ name: "context", description: "d", hint: "[x]" }]);
    expect(getProviderCommands("kiro")).toEqual([{ name: "usage", description: "u" }]);

    saveProviderCommands("claude", [{ name: "compact", description: "c" }]);
    expect(getProviderCommands("claude")).toEqual([{ name: "compact", description: "c" }]);
  });
});

describe("conversation search (searchTimeline)", () => {
  const base = (over: Partial<SearchQuery> = {}): SearchQuery => ({
    terms: ["検証"], missionIds: null, includeCaptain: true, includeReplies: true, includeTasks: true, limit: 100, ...over,
  });

  // Stack the captain's messages, replies, and tasks into the default mission and another mission
  function seed() {
    createMission("m2", "別の件");
    recordCaptainMessage("ログインの検証をお願い", DEFAULT_MISSION_ID); // captain
    recordTurnCompleted("t1", DEFAULT_MISSION_ID, "検証しました。問題ありません", undefined, undefined, "sam"); // reply
    recordTaskStarted("sam_0001", DEFAULT_MISSION_ID, "sam", "check", "入力の検証を見て", undefined, "first_officer");
    recordTaskCompleted("sam_0001", DEFAULT_MISSION_ID, "異常はありません"); // only the instruction has "検証"
    recordTaskStarted("jo_0001", "m2", "jo", "other", "別の依頼", undefined, "first_officer");
    recordTaskCompleted("jo_0001", "m2", "検証の報告です"); // the report has "検証"
    recordCaptainMessage("別のミッションの検証", "m2");
  }

  it("returns the captain's messages, replies, and tasks, newest first. The jump target id, mission name, and handler are attached too", () => {
    seed();
    const { total, rows } = searchTimeline(base());
    expect(total).toBe(5);
    expect(rows.map((r) => r.kind)).toEqual(["captain", "task", "task", "reply", "captain"]);
    expect(rows[0]).toMatchObject({ mission_id: "m2", mission_name: "別の件", agent: null });
    expect(rows[0].item_id).toMatch(/^event-\d+$/);
    expect(rows.find((r) => r.kind === "reply")).toMatchObject({ item_id: "t1", agent: "sam" });
    expect(rows.find((r) => r.item_id === "sam_0001")).toMatchObject({ kind: "task", text: "異常はありません", instruction: "入力の検証を見て" });
  });

  it("a task is found if a term is in either the report or the instruction. Per term, being in either is enough (AND)", () => {
    seed();
    expect(searchTimeline(base({ terms: ["検証"], includeCaptain: false, includeReplies: false })).rows.map((r) => r.item_id)).toEqual(["jo_0001", "sam_0001"]);
    // "入力" is in the instruction and "異常" is in the report = even in separate places within one task, they match by AND
    expect(searchTimeline(base({ terms: ["入力", "異常"] })).rows.map((r) => r.item_id)).toEqual(["sam_0001"]);
  });

  it("the kinds to include can be chosen: the captain's messages, the crew's replies, and the task instructions and reports", () => {
    seed();
    expect(searchTimeline(base({ includeCaptain: false })).rows.map((r) => r.kind).sort()).toEqual(["reply", "task", "task"]);
    expect(searchTimeline(base({ includeReplies: false, includeTasks: false })).rows.map((r) => r.kind)).toEqual(["captain", "captain"]);
    expect(searchTimeline(base({ includeCaptain: false, includeReplies: false, includeTasks: false }))).toEqual({ total: 0, rows: [] });
  });

  it("can be narrowed by target missions. An empty specification returns nothing", () => {
    seed();
    expect(searchTimeline(base({ missionIds: ["m2"] })).rows.every((r) => r.mission_id === "m2")).toBe(true);
    expect(searchTimeline(base({ missionIds: [DEFAULT_MISSION_ID] })).total).toBe(3);
    expect(searchTimeline(base({ missionIds: [] }))).toEqual({ total: 0, rows: [] });
  });

  it("can be narrowed by period (includes from, excludes to)", () => {
    seed();
    const all = searchTimeline(base()).rows;
    const times = all.map((r) => r.occurred_at).sort();
    const newest = times.at(-1)!;
    expect(searchTimeline(base({ from: newest })).rows.every((r) => r.occurred_at >= newest)).toBe(true);
    expect(searchTimeline(base({ to: times[0] })).total).toBe(0); // does not include to
    expect(searchTimeline(base({ from: "2999-01-01T00:00:00.000Z" })).total).toBe(0);
  });

  it("several terms are AND. Case-insensitive. Japanese is also found by partial match", () => {
    recordCaptainMessage("Login テスト と 検証", DEFAULT_MISSION_ID);
    recordCaptainMessage("Login だけ", DEFAULT_MISSION_ID);
    expect(searchTimeline(base({ terms: ["login", "検証"] })).total).toBe(1);
    expect(searchTimeline(base({ terms: ["LOGIN"] })).total).toBe(2);
    expect(searchTimeline(base({ terms: ["テス"] })).total).toBe(1);
  });

  it("the LIKE special characters are searched as the characters themselves (% or _ does not match everything)", () => {
    recordCaptainMessage("達成率は100%です", DEFAULT_MISSION_ID);
    recordCaptainMessage("a_b と a.b", DEFAULT_MISSION_ID);
    recordCaptainMessage("関係ない発言", DEFAULT_MISSION_ID);
    expect(searchTimeline(base({ terms: ["%"] })).rows.map((r) => r.text)).toEqual(["達成率は100%です"]);
    expect(searchTimeline(base({ terms: ["a_b"] })).rows.map((r) => r.text)).toEqual(["a_b と a.b"]);
    expect(searchTimeline(base({ terms: ["_"] })).total).toBe(1);
  });

  it("even beyond the upper limit on the count, total is the total number of matches. What is returned is the newest, up to the limit", () => {
    for (let i = 0; i < 5; i++) recordCaptainMessage(`検証 ${i}`, DEFAULT_MISSION_ID);
    const { total, rows } = searchTimeline(base({ limit: 2 }));
    expect(total).toBe(5);
    expect(rows.map((r) => r.text)).toEqual(["検証 4", "検証 3"]);
  });

  it("if the search terms are empty, nothing is returned", () => {
    recordCaptainMessage("検証", DEFAULT_MISSION_ID);
    expect(searchTimeline(base({ terms: [] }))).toEqual({ total: 0, rows: [] });
  });
});

describe("task details (getTaskDetail): the mission and time used to jump to the conversation", () => {
  it("a completed task has the mission it belongs to and the completion time (the time of the card in the timeline)", () => {
    createMission("m1", "another matter");
    recordTaskStarted("sam_0001", "m1", "sam", "check", "look into it", undefined, "first_officer");
    const { timestamp } = recordTaskCompleted("sam_0001", "m1", "no problem found");
    expect(getTaskDetail("sam_0001")).toMatchObject({ status: "done", text: "no problem found", missionId: "m1", timestamp });
  });

  it("a task that errored also has the mission and the time of the error. A nonexistent task is null", () => {
    createMission("m2", "another matter 2");
    recordTaskStarted("jo_0001", "m2", "jo", "x", "i", undefined, "first_officer");
    const { timestamp } = recordTaskError("jo_0001", "m2", null, "⚠️ Error: boom");
    expect(getTaskDetail("jo_0001")).toMatchObject({ status: "error", missionId: "m2", timestamp });
    expect(getTaskDetail("nope_0001")).toBeNull();
  });
});

describe("closeDatabase: the file alone holds everything afterwards", () => {
  it("a file database copied after closeDatabase() has the data (the write-ahead log is folded in)", async () => {
    const fsm = await import("node:fs");
    const osm = await import("node:os");
    const pathm = await import("node:path");
    const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "mis-wal-"));
    try {
      const file = pathm.join(dir, "bridge.db");
      closeDatabase();
      initDatabase({ path: file, agentToRole: (agent) => agent });
      createMission("keepme", "Mission that must survive");
      closeDatabase();
      fsm.copyFileSync(file, pathm.join(dir, "copy.db")); // only the main file, as the backup guide says
      initDatabase({ path: pathm.join(dir, "copy.db"), agentToRole: (agent) => agent });
      expect(listMissions().map((m) => m.id)).toContain("keepme");
    } finally {
      closeDatabase();
      fsm.rmSync(dir, { recursive: true, force: true });
    }
  });
});
