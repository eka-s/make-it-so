import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState, type ChatAction, type ChatState } from "./chat-state";
import type { Message, ThinkingEntry } from "./types";

// Pins the screen's state update rules to the current behavior. The reducer is a pure function, so it is enough to pass a state and an action and look at the result.
const M = "bridge"; // the mission open now
let seq = 0;
function msg(role: string, overrides: Partial<Message> = {}): Message {
  seq++;
  return { id: `m${seq}`, missionId: M, role, text: "", timestamp: `2026-11-07T00:00:${String(seq).padStart(2, "0")}Z`, ...overrides };
}
function state(overrides: Partial<ChatState> = {}): ChatState {
  return { ...initialChatState, ...overrides };
}
const reduce = (s: ChatState, a: ChatAction) => chatReducer(s, a);
const active = (id: string): ThinkingEntry => ({ id, operations: [{ title: "op", output: "" }], isActive: true, timestamp: "t" });
const upsert = (item: Message, activeMissionId = M): ChatAction => ({ type: "timeline-upsert", item, activeMissionId });

describe("crew-status-changed", () => {
  it("advances the signal that prompts re-fetching the crew status (does not touch the conversation or screen state)", () => {
    const before = state();
    const next = reduce(before, { type: "crew-status-changed", role: "chief_engineer" });
    expect(next.crewActivitySignal).toEqual({ role: "chief_engineer", tick: before.crewActivitySignal.tick + 1 });
    expect({ ...next, crewActivitySignal: before.crewActivitySignal }).toEqual(before);
  });
});

describe("snapshot-loaded", () => {
  it("emits the crew status re-fetch signal (a measure against what is missed after an SSE reconnection)", () => {
    const before = state().crewActivitySignal.tick;
    const next = reduce(state(), { type: "snapshot-loaded", openUiItemId: null, items: [], hasMore: false, resolveSending: true });
    expect(next.crewActivitySignal).toEqual({ role: null, tick: before + 1 });
  });

  it("replaces with the fetched items", () => {
    const items = [msg("captain"), msg("first_officer")];
    const next = reduce(state(), { type: "snapshot-loaded", openUiItemId: null, items, hasMore: true, resolveSending: true });
    expect(next.messages).toEqual(items);
    expect(next.hasMore).toBe(true);
  });

  it("older pages that had already been loaded by scrolling back are kept (duplicates removed by id)", () => {
    const older = msg("captain", { timestamp: "2026-01-01T00:00:00Z" });
    const dup = msg("first_officer", { id: "same", timestamp: "2026-11-01T00:00:00Z" });
    const snapshotItems = [{ ...dup, text: "new" }, msg("captain", { timestamp: "2026-11-02T00:00:00Z" })];
    const next = reduce(state({ messages: [older, dup], hasMore: true }), {
      type: "snapshot-loaded", openUiItemId: null,
      items: snapshotItems,
      hasMore: false,
      resolveSending: true,
    });
    expect(next.messages.map((m) => m.id)).toEqual([older.id, "same", snapshotItems[1].id]);
    expect(next.messages[1].text).toBe("new");
  });

  it("while older pages are held, the snapshot's hasMore is not trusted", () => {
    const older = msg("captain", { timestamp: "2026-01-01T00:00:00Z" });
    const next = reduce(state({ messages: [older], hasMore: true }), {
      type: "snapshot-loaded", openUiItemId: null,
      items: [msg("captain", { timestamp: "2026-11-02T00:00:00Z" })],
      hasMore: false,
      resolveSending: true,
    });
    expect(next.hasMore).toBe(true);
  });

  it("even if the items are empty, existing messages (ones not in the snapshot) remain", () => {
    const keep = msg("captain");
    const next = reduce(state({ messages: [keep] }), { type: "snapshot-loaded", openUiItemId: null, items: [], hasMore: false, resolveSending: true });
    expect(next.messages).toEqual([keep]);
  });

  it("if there is no send request in flight, isSending is decided by whether a turn of the conversation with the captain is streaming (the same for a turn with anyone)", () => {
    const streaming = [msg("first_officer", { status: "streaming" })];
    expect(reduce(state(), { type: "snapshot-loaded", openUiItemId: null, items: streaming, hasMore: false, resolveSending: true }).isSending).toBe(true);
    const done = [msg("first_officer", { status: "done" })];
    expect(reduce(state({ isSending: true }), { type: "snapshot-loaded", openUiItemId: null, items: done, hasMore: false, resolveSending: true }).isSending).toBe(false);
  });

  it("while there is a send request in flight, isSending is not overwritten with the server's state", () => {
    const next = reduce(state({ isSending: true }), { type: "snapshot-loaded", openUiItemId: null, items: [], hasMore: false, resolveSending: false });
    expect(next.isSending).toBe(true);
  });

  it("streaming of a crew task (with taskName) does not affect isSending", () => {
    const items = [msg("ensign", { status: "streaming", taskName: "t" })];
    expect(reduce(state(), { type: "snapshot-loaded", openUiItemId: null, items, hasMore: false, resolveSending: true }).isSending).toBe(false);
  });

  it("if a turn of a direct chat with a crew member (no taskName) is streaming, it is in the sending state even after a reload", () => {
    const items = [msg("ensign", { status: "streaming" })];
    expect(reduce(state(), { type: "snapshot-loaded", openUiItemId: null, items, hasMore: false, resolveSending: true }).isSending).toBe(true);
  });
});

describe("mission-switched", () => {
  it("discards the conversation and the presence of history, and prompts re-fetching the crew status. The sending state is not changed", () => {
    const next = reduce(
      state({
        messages: [msg("captain")],
        hasMore: true,
        isSending: true,
        crewActivitySignal: { role: "ensign", tick: 4 },
      }),
      { type: "mission-switched" },
    );
    expect(next.messages).toEqual([]);
    expect(next.hasMore).toBe(false);
    expect(next.crewActivitySignal).toEqual({ role: null, tick: 5 });
    expect(next.isSending).toBe(true);
  });
});

describe("loading past history", () => {
  it("toggles the loading flag", () => {
    expect(reduce(state(), { type: "older-loading-started" }).isLoadingOlder).toBe(true);
    expect(reduce(state({ isLoadingOlder: true }), { type: "older-loading-finished" }).isLoadingOlder).toBe(false);
  });

  it("when fetched, it is added at the front and hasMore is updated", () => {
    const existing = msg("captain");
    const older = [msg("captain"), msg("first_officer")];
    const next = reduce(state({ messages: [existing] }), { type: "older-loaded", items: older, hasMore: true });
    expect(next.messages).toEqual([...older, existing]);
    expect(next.hasMore).toBe(true);
  });

  it("if empty, there is no more past (the messages do not change)", () => {
    const existing = msg("captain");
    const next = reduce(state({ messages: [existing], hasMore: true }), { type: "older-loaded", items: [], hasMore: true });
    expect(next.messages).toEqual([existing]);
    expect(next.hasMore).toBe(false);
  });
});

describe("timeline-activity", () => {
  it("replaces the operations of an item that is still being worked on", () => {
    const a = msg("first_officer", { id: "x", status: "streaming", activity: active("x") });
    const next = { ...active("x"), operations: [{ title: "op", output: "" }, { title: "Edit", output: "done" }] };
    const s = reduce(state({ messages: [a] }), { type: "timeline-activity", id: "x", activity: next });
    expect(s.messages[0].activity).toEqual(next);
    expect(s.messages[0].text).toBe(a.text); // only the operations change
  });

  it("an unknown item, or one that has already ended, is left alone (its final upsert carries its final operations)", () => {
    const ended = msg("first_officer", { id: "x", status: "done" });
    const before = state({ messages: [ended] });
    expect(reduce(before, { type: "timeline-activity", id: "x", activity: active("x") })).toBe(before);
    expect(reduce(before, { type: "timeline-activity", id: "nope", activity: active("x") })).toBe(before);
  });
});

describe("timeline-upsert", () => {
  it("a new item is added at the end, and the same id is replaced wholesale", () => {
    const a = msg("first_officer", { status: "streaming" });
    let s = reduce(state(), upsert(a));
    expect(s.messages).toEqual([a]);
    const replaced = { ...a, text: "final", status: "done" as const };
    s = reduce(s, upsert(replaced));
    expect(s.messages).toEqual([replaced]);
  });

  describe("events of another mission", () => {
    it("are not mixed into the screen (neither the messages nor the sending state change)", () => {
      const before = state({ isSending: true });
      const next = reduce(before, upsert(msg("first_officer", { missionId: "other", status: "done" })));
      expect(next.messages).toEqual([]);
      expect(next.isSending).toBe(true);
    });

    it("however, only the crew status update signal is emitted for events of anyone other than the captain (the role, whoever's event it is)", () => {
      const crew = reduce(state(), upsert(msg("ensign", { missionId: "other" })));
      expect(crew.crewActivitySignal).toEqual({ role: "ensign", tick: 1 });
      const lead = reduce(crew, upsert(msg("first_officer", { missionId: "other" })));
      expect(lead.crewActivitySignal).toEqual({ role: "first_officer", tick: 2 });
    });

    it("the captain's message does not emit a signal either", () => {
      const before = state();
      expect(reduce(before, upsert(msg("captain", { missionId: "other" })))).toBe(before);
    });
  });

  describe("crew status update signal (the current mission)", () => {
    it("emitted by an upsert of anyone other than the captain. Not emitted by the captain's upsert", () => {
      expect(reduce(state(), upsert(msg("ensign", { taskName: "t", status: "streaming" }))).crewActivitySignal).toEqual({ role: "ensign", tick: 1 });
      expect(reduce(state(), upsert(msg("first_officer", { status: "streaming" }))).crewActivitySignal).toEqual({ role: "first_officer", tick: 1 });
      expect(reduce(state(), upsert(msg("captain"))).crewActivitySignal).toEqual({ role: null, tick: 0 });
    });
  });

  describe("turn (a message that is not a task. The same with anyone)", () => {
    it("a streaming upsert does not change the sending state", () => {
      const next = reduce(state({ isSending: true }), upsert(msg("first_officer", { status: "streaming" })));
      expect(next.isSending).toBe(true);
    });

    it("anything other than streaming (completion, error, cancellation, recovery notice) ends the turn: it cancels the wait for sending", () => {
      for (const status of ["done", "error"] as const) {
        const next = reduce(state({ isSending: true }), upsert(msg("first_officer", { status })));
        expect(next.isSending).toBe(false);
      }
      // the same for a persisted item with no status
      expect(reduce(state({ isSending: true }), upsert(msg("first_officer"))).isSending).toBe(false);
    });
  });

  describe("crew task (with taskName)", () => {
    it("start and completion/error do not change the sending state (asynchronous, independent of the captain's own send)", () => {
      expect(reduce(state({ isSending: true }), upsert(msg("ensign", { taskName: "t", status: "streaming" }))).isSending).toBe(true);
      expect(reduce(state({ isSending: true }), upsert(msg("ensign", { taskName: "t", status: "done" }))).isSending).toBe(true);
    });
  });

  describe("direct chat with a crew member (no taskName)", () => {
    it("the start of a turn (streaming), with anyone, does not touch the sending state", () => {
      const next = reduce(state({ isSending: true }), upsert(msg("ensign", { status: "streaming" })));
      expect(next.isSending).toBe(true);
    });

    it("completion/error is the response to the captain's own send, so it cancels the wait for sending and returns the send button's hourglass", () => {
      const next = reduce(state({ isSending: true }), upsert(msg("ensign", { status: "done" })));
      expect(next.isSending).toBe(false);
    });
  });

  it("an upsert of the captain's message does not touch the sending state", () => {
    const next = reduce(state({ isSending: true }), upsert(msg("captain")));
    expect(next.isSending).toBe(true);
    expect(next.messages).toHaveLength(1);
  });
});

describe("timeline-append", () => {
  it("appends the delta to the text of the matching item", () => {
    const a = msg("first_officer", { text: "hel", id: "x" });
    const s = reduce(state({ messages: [a, msg("captain")] }), { type: "timeline-append", id: "x", text: "lo" });
    expect(s.messages[0].text).toBe("hello");
  });

  it("an unknown id is ignored (the state does not change)", () => {
    const before = state({ messages: [msg("captain")] });
    expect(reduce(before, { type: "timeline-append", id: "none", text: "x" })).toBe(before);
  });
});

describe("timeline-remove", () => {
  it("removes the item, and as the end of the turn cancels the wait for sending", () => {
    const a = msg("first_officer", { id: "x" });
    const keep = msg("captain");
    const s = reduce(state({ messages: [a, keep], isSending: true }), { type: "timeline-remove", id: "x" });
    expect(s.messages).toEqual([keep]);
    expect(s.isSending).toBe(false);
  });
});

describe("local send", () => {
  it("message-sent: adds the captain's message, and starts waiting for the response", () => {
    const captain = msg("captain", { text: "report" });
    const s = reduce(state(), { type: "message-sent", message: captain });
    expect(s.messages).toEqual([captain]);
    expect(s.isSending).toBe(true);
  });

  it("send-failed: cancels the wait for the response and adds the error to the conversation", () => {
    const error = msg("first_officer", { text: "⚠️ Error: x" });
    const s = reduce(state({ isSending: true, messages: [msg("captain")] }), { type: "send-failed", message: error });
    expect(s.isSending).toBe(false);
    expect(s.messages.at(-1)).toEqual(error);
    expect(s.messages).toHaveLength(2);
  });
});

describe("properties of the reducer", () => {
  it("does not rewrite the original state (immutable)", () => {
    const before = state({ messages: [msg("first_officer", { id: "x", text: "a" })] });
    const snapshot = JSON.stringify(before);
    reduce(before, { type: "timeline-append", id: "x", text: "b" });
    reduce(before, { type: "timeline-activity", id: "x", activity: active("x") });
    reduce(before, { type: "timeline-remove", id: "x" });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("holes in the history (jumping to an old item)", () => {
  /** The ids "p1".."p9" are older history items; "r1".. the recent window. */
  const item = (id: string, timestamp: string): Message => ({ id, missionId: M, role: "first_officer", text: id, timestamp });
  const recent = [item("r1", "2026-11-07T10:00:01Z"), item("r2", "2026-11-07T10:00:02Z")];
  const ids = (s: ChatState) => s.messages.map((m) => m.id);

  it("a jump chunk that reaches the loaded history without a hole is prepended and leaves no gap", () => {
    const next = reduce(state({ messages: recent, hasMore: false }), { type: "chunk-jump-loaded", items: [item("p1", "t1"), item("p2", "t2")], complete: true, beforeId: "r1" });
    expect(ids(next)).toEqual(["p1", "p2", "r1", "r2"]);
    expect(next.gaps).toEqual([]);
    expect(next.hasMore).toBe(true); // older history may exist above the chunk
  });

  it("a jump chunk that stops short leaves a hole between the chunk and the loaded history", () => {
    const next = reduce(state({ messages: recent }), { type: "chunk-jump-loaded", items: [item("p1", "t1"), item("p2", "t2")], complete: false, beforeId: "r1" });
    expect(ids(next)).toEqual(["p1", "p2", "r1", "r2"]);
    expect(next.gaps).toEqual([{ afterId: "p2", beforeId: "r1" }]);
  });

  it("a jump into the middle splits the existing hole in two (above and below the chunk)", () => {
    const base = state({ messages: [item("p1", "t1"), item("r1", "t9")], gaps: [{ afterId: "p1", beforeId: "r1" }] });
    const next = reduce(base, { type: "chunk-jump-loaded", items: [item("q1", "t4"), item("q2", "t5")], complete: false, beforeId: "r1" });
    expect(ids(next)).toEqual(["p1", "q1", "q2", "r1"]);
    expect(next.gaps).toEqual(expect.arrayContaining([{ afterId: "p1", beforeId: "q1" }, { afterId: "q2", beforeId: "r1" }]));
    expect(next.gaps).toHaveLength(2);
  });

  it("filling a gap from its top end inserts after the item above and moves the gap's upper edge", () => {
    const base = state({ messages: [item("p1", "t1"), item("r1", "t9")], gaps: [{ afterId: "p1", beforeId: "r1" }] });
    const next = reduce(base, { type: "gap-filled", afterId: "p1", beforeId: "r1", side: "top", items: [item("p2", "t2"), item("p3", "t3")], complete: false });
    expect(ids(next)).toEqual(["p1", "p2", "p3", "r1"]);
    expect(next.gaps).toEqual([{ afterId: "p3", beforeId: "r1" }]);
  });

  it("filling a gap from its bottom end inserts before the item below and moves the gap's lower edge", () => {
    const base = state({ messages: [item("p1", "t1"), item("r1", "t9")], gaps: [{ afterId: "p1", beforeId: "r1" }] });
    const next = reduce(base, { type: "gap-filled", afterId: "p1", beforeId: "r1", side: "bottom", items: [item("p8", "t7"), item("p9", "t8")], complete: false });
    expect(ids(next)).toEqual(["p1", "p8", "p9", "r1"]);
    expect(next.gaps).toEqual([{ afterId: "p1", beforeId: "p8" }]);
  });

  it("a fill that returns the whole range closes the gap", () => {
    const base = state({ messages: [item("p1", "t1"), item("r1", "t9")], gaps: [{ afterId: "p1", beforeId: "r1" }] });
    const next = reduce(base, { type: "gap-filled", afterId: "p1", beforeId: "r1", side: "top", items: [item("p2", "t2")], complete: true });
    expect(ids(next)).toEqual(["p1", "p2", "r1"]);
    expect(next.gaps).toEqual([]);
  });

  it("an empty fill closes the gap (nothing is left to load)", () => {
    const base = state({ messages: [item("p1", "t1"), item("r1", "t9")], gaps: [{ afterId: "p1", beforeId: "r1" }] });
    expect(reduce(base, { type: "gap-filled", afterId: "p1", beforeId: "r1", side: "bottom", items: [], complete: false }).gaps).toEqual([]);
  });

  it("a fill for a gap that no longer exists is ignored; items already loaded are not duplicated", () => {
    const base = state({ messages: [item("p1", "t1"), item("r1", "t9")], gaps: [{ afterId: "p1", beforeId: "r1" }] });
    expect(reduce(base, { type: "gap-filled", afterId: "zz", beforeId: "r1", side: "top", items: [item("x", "t")], complete: true })).toBe(base);
    const dup = reduce(base, { type: "gap-filled", afterId: "p1", beforeId: "r1", side: "top", items: [item("p1", "t1"), item("p2", "t2")], complete: true });
    expect(ids(dup)).toEqual(["p1", "p2", "r1"]);
  });

  it("loading flags are set and cleared on the gap", () => {
    const base = state({ messages: [item("p1", "t1"), item("r1", "t9")], gaps: [{ afterId: "p1", beforeId: "r1" }] });
    const started = reduce(base, { type: "gap-loading-started", afterId: "p1", beforeId: "r1", side: "top" });
    expect(started.gaps[0].loading).toBe("top");
    expect(reduce(started, { type: "gap-loading-finished", afterId: "p1", beforeId: "r1" }).gaps[0].loading).toBeUndefined();
  });

  it("a snapshot reload keeps a gap while its two items are still neighbours", () => {
    const base = state({ messages: [item("p1", "2026-11-01T00:00:00Z"), item("r1", "2026-11-07T10:00:01Z")], gaps: [{ afterId: "p1", beforeId: "r1" }] });
    const next = reduce(base, { type: "snapshot-loaded", openUiItemId: null, items: [item("r1", "2026-11-07T10:00:01Z"), item("r2", "2026-11-07T10:00:02Z")], hasMore: true, resolveSending: false });
    expect(ids(next)).toEqual(["p1", "r1", "r2"]);
    expect(next.gaps).toEqual([{ afterId: "p1", beforeId: "r1" }]);
  });

  it("switching missions drops the holes together with the messages", () => {
    const base = state({ messages: recent, gaps: [{ afterId: "r1", beforeId: "r2" }] });
    expect(reduce(base, { type: "mission-switched" }).gaps).toEqual([]);
  });
});

describe("the form waiting for the captain (openUiItemId)", () => {
  const form = (state: "open" | "answered" | "dismissed"): Message["a2ui"] => ({ state, messages: [], ...(state === "open" ? { locksInput: true as const } : {}) });

  it("comes with the snapshot (the form can be outside the loaded items), and is cleared when the mission is switched", () => {
    const loaded = reduce(state(), { type: "snapshot-loaded", items: [], hasMore: false, resolveSending: true, openUiItemId: "turn-7" });
    expect(loaded.openUiItemId).toBe("turn-7");
    expect(reduce(loaded, { type: "mission-switched" }).openUiItemId).toBeNull();
  });

  it("an upsert of a reply with a form that locks the input sets it; the same reply answered or closed releases it", () => {
    const reply = msg("chief_engineer", { id: "turn-7", a2ui: form("open") });
    const opened = reduce(state(), upsert(reply));
    expect(opened.openUiItemId).toBe("turn-7");
    expect(reduce(opened, upsert({ ...reply, a2ui: form("answered") })).openUiItemId).toBeNull();
    expect(reduce(opened, upsert({ ...reply, a2ui: form("dismissed") })).openUiItemId).toBeNull();
  });

  it("an upsert about another reply leaves it alone", () => {
    const opened = state({ openUiItemId: "turn-7" });
    expect(reduce(opened, upsert(msg("chief_engineer", { id: "turn-8", a2ui: form("answered") }))).openUiItemId).toBe("turn-7");
    expect(reduce(opened, upsert(msg("chief_engineer", { id: "turn-9" }))).openUiItemId).toBe("turn-7");
  });
});

describe("a2ui-failed", () => {
  it("adds the error to the conversation without touching the waiting state (no send is in progress)", () => {
    const error = msg("captain", { text: "⚠️ Error: nope" });
    const next = reduce(state({ isSending: true }), { type: "a2ui-failed", message: error });
    expect(next.messages).toEqual([error]);
    expect(next.isSending).toBe(true);
  });
});
