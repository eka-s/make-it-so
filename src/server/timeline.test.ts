import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MISSION_ID, closeDatabase, createMission, initDatabase, recordCaptainMessage, recordTaskStarted } from "./database.js";
import { addConnection, removeConnection } from "./sse-emitter.js";
import { configureTimeline, forget, getSnapshot, notifyActivity, remove, upsert, get } from "./timeline.js";
import type { TimelineItem } from "./types.js";

// History is an in-memory database and the way of reading in-progress text is prepared as an injected fake,
// so no files or ship config are needed.
const readTaskText = vi.fn<(agent: string, taskId: string) => Promise<string>>();
const readTurnText = vi.fn<(turnId: string) => Promise<string>>();

const liveIds: string[] = [];
function live(item: Partial<TimelineItem> & { id: string }): TimelineItem {
  const full: TimelineItem = {
    missionId: DEFAULT_MISSION_ID,
    role: "chief_engineer",
    text: "",
    timestamp: new Date().toISOString(),
    status: "streaming",
    ...item,
  };
  liveIds.push(full.id);
  upsert(full);
  return full;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  initDatabase({ path: ":memory:", agentToRole: () => "first_officer" });
  readTaskText.mockReset().mockResolvedValue("");
  readTurnText.mockReset().mockResolvedValue("");
  configureTimeline({ readTaskText, readTurnText });
});

afterEach(() => {
  for (const id of liveIds.splice(0)) forget(id);
  closeDatabase();
  vi.restoreAllMocks();
});

describe("getSnapshot", () => {
  it("returns the persisted history and the in-progress items together", async () => {
    recordCaptainMessage("hello", DEFAULT_MISSION_ID);
    live({ id: "turn-1", text: "(in progress)" });
    readTurnText.mockResolvedValue("content so far");

    const { items } = await getSnapshot(20, DEFAULT_MISSION_ID);
    expect(items.map((i) => i.text)).toEqual(["hello", "content so far"]);
  });

  it("a streaming turn returns what was read from the stream, not the live text", async () => {
    live({ id: "turn-1", text: "old" });
    readTurnText.mockResolvedValue("new");
    const { items } = await getSnapshot(20, DEFAULT_MISSION_ID);
    expect(readTurnText).toHaveBeenCalledWith("turn-1");
    expect(items[0].text).toBe("new");
  });

  it("a task via dispatch_task reads the result file with the agent of the issue record", async () => {
    recordTaskStarted("sam_0001", DEFAULT_MISSION_ID, "sam", "research", "look into it", undefined, "first_officer");
    live({ id: "sam_0001" });
    readTaskText.mockResolvedValue("research in progress");

    const { items } = await getSnapshot(20, DEFAULT_MISSION_ID);
    expect(readTaskText).toHaveBeenCalledWith("sam", "sam_0001");
    expect(readTurnText).not.toHaveBeenCalled();
    expect(items[0].text).toBe("research in progress");
  });

  it("if what was read is empty, falls back to the live item's own text", async () => {
    live({ id: "turn-1", text: "live text" });
    readTurnText.mockResolvedValue("");
    const { items } = await getSnapshot(20, DEFAULT_MISSION_ID);
    expect(items[0].text).toBe("live text");
  });

  it("even if reading fails, the whole snapshot does not fail; it is logged and falls back", async () => {
    live({ id: "turn-1", text: "live text" });
    readTurnText.mockRejectedValue(new Error("disk error"));
    const { items } = await getSnapshot(20, DEFAULT_MISSION_ID);
    expect(items[0].text).toBe("live text");
    expect(console.error).toHaveBeenCalled();
  });

  it("the captain's message (captain) is returned as is without reading the stream", async () => {
    live({ id: "c-1", role: "captain", text: "captain's message", status: "streaming" });
    const { items } = await getSnapshot(20, DEFAULT_MISSION_ID);
    expect(items[0].text).toBe("captain's message");
    expect(readTurnText).not.toHaveBeenCalled();
  });

  it("a non-streaming item is also returned as is without reading the stream", async () => {
    live({ id: "turn-1", text: "completed", status: "done" });
    const { items } = await getSnapshot(20, DEFAULT_MISSION_ID);
    expect(items[0].text).toBe("completed");
    expect(readTurnText).not.toHaveBeenCalled();
  });

  it("narrowed by mission: in-progress items of another mission do not mix in", async () => {
    createMission("m1", "x");
    live({ id: "turn-bridge", text: "bridge" });
    live({ id: "turn-m1", text: "m1", missionId: "m1" });
    readTurnText.mockImplementation(async (id) => id);

    expect((await getSnapshot(20, "m1")).items.map((i) => i.id)).toEqual(["turn-m1"]);
    expect((await getSnapshot(20, DEFAULT_MISSION_ID)).items.map((i) => i.id)).toEqual(["turn-bridge"]);
  });

  it("several in-progress items are each resolved without being affected by the failure of one", async () => {
    live({ id: "a", text: "a-live" });
    live({ id: "b", text: "b-live" });
    readTurnText.mockImplementation(async (id) => {
      if (id === "a") throw new Error("boom");
      return "b-file";
    });
    const { items } = await getSnapshot(20, DEFAULT_MISSION_ID);
    expect(Object.fromEntries(items.map((i) => [i.id, i.text]))).toEqual({ a: "a-live", b: "b-file" });
  });

  it("if configureTimeline has not been called, a clear exception", async () => {
    // To reproduce an unconfigured state only inside this test, so as not to affect other tests,
    // the module is reloaded
    vi.resetModules();
    const fresh = await import("./timeline.js");
    await expect(fresh.getSnapshot()).rejects.toThrow(/not configured/);
  });
});

describe("management of live items", () => {
  it("registered with upsert, removed with remove, and forget removes without notifying", () => {
    live({ id: "x" });
    expect(get("x")).toBeDefined();
    remove("x");
    expect(get("x")).toBeUndefined();

    live({ id: "y" });
    forget("y");
    expect(get("y")).toBeUndefined();
  });
});

describe("the operations of an item (activity)", () => {
  const recorded = { id: "turn-1", operations: [{ title: "Bash: ls", output: "x" }], isActive: false, timestamp: "t" };

  it("a streaming item carries them as still coming in, and a finished one as done", async () => {
    configureTimeline({ readTaskText, readTurnText, readActivity: (id) => (id === "turn-1" ? recorded : undefined) });
    live({ id: "turn-1" });
    const running = (await getSnapshot(20, DEFAULT_MISSION_ID)).items[0];
    expect(running.activity).toEqual({ ...recorded, isActive: true });

    upsert({ ...running, status: "done" });
    const finished = (await getSnapshot(20, DEFAULT_MISSION_ID)).items[0];
    expect(finished.activity?.isActive).toBe(false);
  });

  it("an item with nothing recorded, and a captain message, carry none", async () => {
    configureTimeline({ readTaskText, readTurnText, readActivity: () => recorded });
    recordCaptainMessage("hello", DEFAULT_MISSION_ID);
    const { items } = await getSnapshot(20, DEFAULT_MISSION_ID);
    expect(items[0].activity).toBeUndefined();
    configureTimeline({ readTaskText, readTurnText, readActivity: () => undefined });
    live({ id: "turn-2" });
    expect((await getSnapshot(20, DEFAULT_MISSION_ID)).items.at(-1)?.activity).toBeUndefined();
  });
});

describe("notifyActivity", () => {
  const recorded = { id: "turn-1", operations: [{ title: "Bash: ls", output: "x" }], isActive: false, timestamp: "t" };
  const events: string[] = [];
  let id: string;

  async function listen() {
    const res = { writeHead: vi.fn(), write: vi.fn((chunk: string) => { events.push(chunk); return true; }), on: vi.fn() };
    id = addConnection(res as never, "bridge");
    return () => removeConnection(id);
  }

  it("tells the screens the operations of a streaming item, once for a burst of changes, and only the operations", async () => {
    vi.useFakeTimers();
    events.length = 0;
    const stop = await listen();
    configureTimeline({ readTaskText, readTurnText, readActivity: () => recorded });
    live({ id: "turn-1" });
    events.length = 0;
    notifyActivity("turn-1");
    notifyActivity("turn-1");
    notifyActivity("turn-1");
    vi.advanceTimersByTime(1000);
    const sent = events.filter((e) => e.includes("timeline:activity"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"isActive":true');
    expect(sent[0]).not.toContain('"text"');
    stop();
    vi.useRealTimers();
  });

  it("says nothing for an item that has ended in the meantime", async () => {
    vi.useFakeTimers();
    const stop = await listen();
    configureTimeline({ readTaskText, readTurnText, readActivity: () => recorded });
    live({ id: "turn-2" });
    events.length = 0;
    notifyActivity("turn-2");
    forget("turn-2");
    vi.advanceTimersByTime(1000);
    expect(events.filter((e) => e.includes("timeline:activity"))).toHaveLength(0);
    stop();
    vi.useRealTimers();
  });
});
