import type { Gap } from "./chat-state";
import type { Message } from "./types";

// Rearranges the chat message list into the shape to render on screen (crew tasks are gathered into cards).

export type CrewGroup = { type: "crew-group"; taskName: string; messages: Message[] };
export type RenderItem = Message | CrewGroup;

// Only crew messages in the "task" shape issued via dispatch_task are treated as
// CrewReportGroup cards (taskName is always set at issue time;
// task_started_events.task_name in database.ts is NOT NULL). Direct chat
// with a crew member is an ordinary "turn" with no taskName, so it is shown as is as a ChatMessage
// speech bubble, like the commander's own messages — it is a conversation, not task delegation or reporting.
export function isCrewTaskMessage(m: Message): boolean {
  return m.role !== "captain" && m.taskName !== undefined;
}

// Grouping key: the turnId if available (one captain → commander turn); old history entries
// recorded before turnId existed fall back to taskName.
// This way, crew members issued in the same turn are gathered into one card even if each
// uses a different task file name.
export function crewGroupKey(msg: Message): string | undefined {
  return msg.turnId ?? msg.taskName;
}

// The completion of a crew task is logged asynchronously and independently of the commander's own turn
// — a fast crew member can complete (and be logged) before the commander's own issue text. So messages sharing the same group key
// are not simply merged at the position of the first one; the card is
// placed right after "the last non-crew message" found within the range of that group (the commander's issue/completion text)
// — preserving the expected order: captain → commander → (the commander's follow-up, if any)
// → crew card.
export function groupCrewMessages(messages: Message[]): RenderItem[] {
  const indicesByKey = new Map<string, number[]>();
  messages.forEach((msg, idx) => {
    const key = isCrewTaskMessage(msg) ? crewGroupKey(msg) : undefined;
    if (!key) return;
    const arr = indicesByKey.get(key);
    if (arr) arr.push(idx); else indicesByKey.set(key, [idx]);
  });

  const anchorByKey = new Map<string, number>();
  for (const [key, indices] of indicesByKey) {
    const first = indices[0];
    const last = indices[indices.length - 1];
    let anchor = first;
    for (let idx = first; idx <= last; idx++) {
      const isMember = isCrewTaskMessage(messages[idx]) && crewGroupKey(messages[idx]) === key;
      if (!isMember) anchor = idx + 1;
    }
    anchorByKey.set(key, anchor);
  }

  const groupsByKey = new Map<string, CrewGroup>();
  const groupsByAnchor = new Map<number, CrewGroup>();
  messages.forEach((msg) => {
    const key = isCrewTaskMessage(msg) ? crewGroupKey(msg) : undefined;
    if (!key) return;
    let group = groupsByKey.get(key);
    if (!group) {
      group = { type: "crew-group", taskName: msg.taskName ?? key, messages: [] };
      groupsByKey.set(key, group);
      groupsByAnchor.set(anchorByKey.get(key)!, group);
    }
    group.messages.push(msg);
  });

  const result: RenderItem[] = [];
  const emitted = new Set<CrewGroup>();
  for (let idx = 0; idx <= messages.length; idx++) {
    const group = groupsByAnchor.get(idx);
    if (group && !emitted.has(group)) {
      result.push(group);
      emitted.add(group);
    }
    if (idx < messages.length) {
      const msg = messages[idx];
      if (!isCrewTaskMessage(msg) || !crewGroupKey(msg)) result.push(msg);
    }
  }
  return result;
}

/** A run of loaded messages with no hole inside, and the hole (if any) just before it. */
export type Segment = { messages: Message[]; gapBefore: Gap | null };

/**
 * Splits the loaded messages at the holes of the history. Each segment is grouped and drawn
 * on its own (a card of crew reports never spans a hole), with the hole's buttons drawn
 * between segments.
 */
export function splitAtGaps(messages: Message[], gaps: Gap[]): Segment[] {
  const gapByBeforeId = new Map(gaps.map((g) => [g.beforeId, g]));
  const segments: Segment[] = [];
  for (const m of messages) {
    const gap = gapByBeforeId.get(m.id) ?? null;
    if (segments.length === 0 || gap) segments.push({ messages: [], gapBefore: gap });
    segments[segments.length - 1].messages.push(m);
  }
  return segments;
}
