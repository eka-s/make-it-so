import { describe, expect, it } from "vitest";
import { crewGroupKey, groupCrewMessages, isCrewTaskMessage, splitAtGaps, type CrewGroup } from "./chat-grouping";
import type { Message } from "./types";

let seq = 0;
function msg(role: string, overrides: Partial<Message> = {}): Message {
  seq++;
  return { id: `m${seq}`, missionId: "bridge", role, text: `text${seq}`, timestamp: `2026-11-07T00:00:${String(seq).padStart(2, "0")}Z`, ...overrides };
}
const task = (role: string, turnId: string | undefined, taskName = "task_a") => msg(role, { taskName, ...(turnId ? { turnId } : {}) });

const ids = (items: Array<Message | CrewGroup>) => items.map((i) => ("type" in i ? `[${i.messages.map((m) => m.id).join(",")}]` : i.id));

describe("isCrewTaskMessage", () => {
  it("only crew messages with a taskName are tasks (treated as cards). The captain is excluded. No special-casing by role name (anyone can run a task)", () => {
    expect(isCrewTaskMessage(msg("chief_engineer", { taskName: "x" }))).toBe(true);
    expect(isCrewTaskMessage(msg("first_officer", { taskName: "x" }))).toBe(true);
    expect(isCrewTaskMessage(msg("captain", { taskName: "x" }))).toBe(false);
  });

  it("direct chat with a crew member (no taskName) is treated as an ordinary conversation, not a task", () => {
    expect(isCrewTaskMessage(msg("chief_engineer"))).toBe(false);
  });
});

describe("crewGroupKey", () => {
  it("the turnId if there is one, otherwise it falls back to taskName (for old history from before turnId)", () => {
    expect(crewGroupKey(msg("ensign", { taskName: "t", turnId: "turn-1" }))).toBe("turn-1");
    expect(crewGroupKey(msg("ensign", { taskName: "t" }))).toBe("t");
    expect(crewGroupKey(msg("ensign"))).toBeUndefined();
  });
});

describe("groupCrewMessages", () => {
  it("empty gives empty", () => {
    expect(groupCrewMessages([])).toEqual([]);
  });

  it("if there are no crew tasks, the order is returned as is", () => {
    const list = [msg("captain"), msg("first_officer"), msg("ensign")];
    expect(groupCrewMessages(list)).toEqual(list);
  });

  it("crew tasks of the same turn are gathered into one card (the name is the first task's)", () => {
    const [c, r] = [msg("captain"), msg("first_officer")];
    const a = task("chief_engineer", "turn-1", "fix_bug");
    const b = task("ensign", "turn-1", "write_docs");
    const result = groupCrewMessages([c, r, a, b]);
    expect(ids(result)).toEqual([c.id, r.id, `[${a.id},${b.id}]`]);
    expect((result[2] as CrewGroup).taskName).toBe("fix_bug");
  });

  it("a different turn is a different card", () => {
    const a = task("ensign", "turn-1");
    const b = task("ensign", "turn-2");
    expect(ids(groupCrewMessages([a, b]))).toEqual([`[${a.id}]`, `[${b.id}]`]);
  });

  it("even if a crew member's completion is logged before the commander's message, the card is placed right after the commander's message", () => {
    // A fast crew member completed before the commander's own issue text: captain → crew A → commander → crew B
    const c = msg("captain");
    const a = task("ensign", "turn-1");
    const r = msg("first_officer");
    const b = task("chief_engineer", "turn-1");
    expect(ids(groupCrewMessages([c, a, r, b]))).toEqual([c.id, r.id, `[${a.id},${b.id}]`]);
  });

  it("even if the commander's follow-up continues, the card is placed after it (at the end of the turn)", () => {
    const c = msg("captain");
    const r1 = msg("first_officer");
    const a = task("ensign", "turn-1");
    const r2 = msg("first_officer");
    const b = task("chief_engineer", "turn-1");
    // Fix the card right after the last non-member (r2) in the range
    expect(ids(groupCrewMessages([c, r1, a, r2, b]))).toEqual([c.id, r1.id, r2.id, `[${a.id},${b.id}]`]);
  });

  it("old history without turnId is grouped by taskName", () => {
    const a = task("ensign", undefined, "legacy");
    const b = task("chief_engineer", undefined, "legacy");
    expect(ids(groupCrewMessages([a, b]))).toEqual([`[${a.id},${b.id}]`]);
  });

  it("direct chat with a crew member (no taskName) is not made a card and stays as ordinary messages", () => {
    const c = msg("captain");
    const direct = msg("ensign", { turnId: "turn-1" });
    expect(ids(groupCrewMessages([c, direct]))).toEqual([c.id, direct.id]);
  });

  it("the relative order of messages outside the groups is preserved", () => {
    const c1 = msg("captain");
    const a = task("ensign", "turn-1");
    const c2 = msg("captain");
    const result = groupCrewMessages([c1, a, c2]);
    expect(ids(result).filter((x) => !x.startsWith("["))).toEqual([c1.id, c2.id]);
  });
});

describe("splitAtGaps", () => {
  const a = msg("captain"), b = msg("first_officer"), c = msg("captain"), d = msg("first_officer");

  it("no gaps: one segment with everything", () => {
    expect(splitAtGaps([a, b, c], [])).toEqual([{ messages: [a, b, c], gapBefore: null }]);
  });

  it("starts a new segment at the item right after each gap, carrying the gap", () => {
    const g1 = { afterId: b.id, beforeId: c.id };
    expect(splitAtGaps([a, b, c, d], [g1])).toEqual([
      { messages: [a, b], gapBefore: null },
      { messages: [c, d], gapBefore: g1 },
    ]);
  });

  it("handles several gaps and an empty list", () => {
    const g1 = { afterId: a.id, beforeId: b.id };
    const g2 = { afterId: c.id, beforeId: d.id };
    expect(splitAtGaps([a, b, c, d], [g1, g2]).map((s) => s.messages.length)).toEqual([1, 2, 1]);
    expect(splitAtGaps([], [])).toEqual([]);
  });
});
