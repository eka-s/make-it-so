import type { Message, ThinkingEntry } from "./types";

// The state of the chat screen and its update rules. A pure function (reducer) separated from components,
// reflecting what arrives from the server (the snapshot, SSE upsert/append/remove) into the state as is.
// Values that change on every call, such as the time, are not made inside the reducer but received through the action.

/**
 * A hole in the loaded history: the items between two loaded items are not loaded.
 * `afterId` is the loaded item just before the hole, `beforeId` the one just after it.
 * The hole is filled from either end (see the gap-filled action) until nothing is left.
 */
export type Gap = {
  afterId: string;
  beforeId: string;
  /** Which end is being loaded now ("top" = continue after `afterId`, "bottom" = go back from `beforeId`). */
  loading?: "top" | "bottom";
};

export type ChatState = {
  /**
   * Every item of the chat feed (captain, commander, crew tasks). It is the server's authoritative TimelineItem itself.
   */
  messages: Message[];
  /**
   * Whether the captain has sent something and is waiting for the response to complete (the hourglass on the send button).
   */
  isSending: boolean;
  /**
   * A lightweight signal that tells the crew status panel in the left pane that "crew-related state may have changed".
   * No new SSE kind is added; it rides on the existing timeline:upsert.
   * role is set only for a crew upsert, and is null for the commander's upsert or a mission switch.
   * tick increases monotonically and is used to detect a change in useEffect dependencies.
   */
  crewActivitySignal: { role: string | null; tick: number };
  /**
   * The id of the reply that holds an A2UI form the captain has neither answered nor closed (null if none). The server says it with the
   * snapshot (it can be outside the loaded items) and each upsert of a reply with a form keeps it up to date. While there is one,
   * nothing can be sent in the mission.
   */
  openUiItemId: string | null;
  /** Holes in the loaded history (left by jumping to an old item, see Gap). Empty normally. */
  gaps: Gap[];
  /** Whether there is more past history. */
  hasMore: boolean;
  /** Whether past history is being loaded. */
  isLoadingOlder: boolean;
};

export const initialChatState: ChatState = {
  messages: [],
  isSending: false,
  crewActivitySignal: { role: null, tick: 0 },
  openUiItemId: null,
  gaps: [],
  hasMore: false,
  isLoadingOlder: false,
};

export type ChatAction =
  /** A snapshot of GET /api/timeline was received. */
  | {
      type: "snapshot-loaded";
      items: Message[];
      hasMore: boolean;
      /** Only when there is no send request in flight, decide isSending from the server's state. */
      resolveSending: boolean;
      /** The reply with a form waiting for the captain, as the server says (null if none). */
      openUiItemId: string | null;
    }
  /** Switched to another mission (discard the conversation being shown and fetch again). */
  | { type: "mission-switched" }
  | { type: "older-loading-started" }
  | { type: "older-loading-finished" }
  /** The result of GET /api/timeline/older. If items is empty, there is no more past. */
  | { type: "older-loaded"; items: Message[]; hasMore: boolean }
  /**
   * A chunk that starts at an old item (a jump to it) was loaded. `beforeId` is the loaded item
   * the chunk was fetched up to; `complete` says whether the chunk reaches it without a hole.
   */
  | { type: "chunk-jump-loaded"; items: Message[]; complete: boolean; beforeId: string }
  /** The next ("top") or previous ("bottom") items of a gap were loaded. */
  | { type: "gap-loading-started"; afterId: string; beforeId: string; side: "top" | "bottom" }
  | { type: "gap-loading-finished"; afterId: string; beforeId: string }
  | { type: "gap-filled"; afterId: string; beforeId: string; side: "top" | "bottom"; items: Message[]; complete: boolean }
  | { type: "timeline-activity"; id: string; activity: ThinkingEntry }
  /**
   * A signal that a crew member's state (starting, restarting, etc.) changed. Makes the crew status be fetched again.
   */
  | { type: "crew-status-changed"; role: string }
  | { type: "timeline-upsert"; item: Message; activeMissionId: string }
  | { type: "timeline-append"; id: string; text: string }
  | { type: "timeline-remove"; id: string }
  /**
   * The captain sent a message (including report). Adds the captain's message locally and starts waiting for the response.
   */
  | { type: "message-sent"; message: Message }
  /** Sending failed. Cancels the wait for the response and adds the error to the conversation. */
  | { type: "send-failed"; message: Message }
  /** An action on an A2UI form failed: the error is added to the conversation (no send is in progress, so the waiting state is left alone). */
  | { type: "a2ui-failed"; message: Message };

function sameGap(g: Gap, ids: { afterId: string; beforeId: string }): boolean {
  return g.afterId === ids.afterId && g.beforeId === ids.beforeId;
}

/** Keeps the gaps whose two items are still loaded and next to each other. */
function keepAdjacentGaps(gaps: Gap[], messages: Message[]): Gap[] {
  if (gaps.length === 0) return gaps;
  const index = new Map(messages.map((m, i) => [m.id, i]));
  return gaps.filter((g) => {
    const a = index.get(g.afterId);
    const b = index.get(g.beforeId);
    return a !== undefined && b !== undefined && b === a + 1;
  });
}

function bumpSignal(state: ChatState, role: string | null): ChatState["crewActivitySignal"] {
  return { role, tick: state.crewActivitySignal.tick + 1 };
}

/**
 * Whether it is a "turn" of the conversation with the captain (a message that is not a task). A task has a `taskName` and a turn does not.
 * It does not look at whose turn it is (no special-casing by role).
 */
function isTurn(item: Message): boolean {
  return item.role !== "captain" && item.taskName === undefined;
}

/** Which crew member's event the upsert is about (used to update the crew status history). */
function signalRole(item: Message): string | null {
  return item.role;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "snapshot-loaded": {
      // Keeps the older pages that the user had already scrolled back to by paging — the snapshot covers only
      // the latest window. Excluding by id (not only by strict timestamp comparison)
      // means it still works correctly even when an old message happens to share exactly the same millisecond timestamp
      // as the oldest item of the snapshot.
      const earliestNew = action.items[0]?.timestamp;
      const newIds = new Set(action.items.map((m) => m.id));
      const oldOnly = earliestNew
        ? state.messages.filter((m) => !newIds.has(m.id) && m.timestamp <= earliestNew)
        : state.messages.filter((m) => !newIds.has(m.id));
      const merged = [...oldOnly, ...action.items];
      return {
        ...state,
        messages: merged,
        // A hole stays only while the two items around it are still next to each other.
        gaps: keepAdjacentGaps(state.gaps, merged),
        // hasMore only says something about the snapshot's own window, so
        // trust it only when no older page had already been loaded before it.
        hasMore: oldOnly.length === 0 ? action.hasMore : state.hasMore,
        openUiItemId: action.openUiItemId,
        isSending: action.resolveSending
          ? action.items.some((m) => isTurn(m) && m.status === "streaming")
          : state.isSending,
        // On every initial display and every re-fetch after an SSE reconnection, also have the crew status fetched again
        // (changes that happened during the reconnection do not arrive as events).
        crewActivitySignal: bumpSignal(state, null),
      };
    }

    case "mission-switched":
      return {
        ...state,
        messages: [],
        openUiItemId: null,
        gaps: [],
        hasMore: false,
        // Also have the crew status (unreported counts, etc.) of the mission being switched to fetched again
        crewActivitySignal: bumpSignal(state, null),
      };

    case "older-loading-started":
      return { ...state, isLoadingOlder: true };

    case "older-loading-finished":
      return { ...state, isLoadingOlder: false };

    case "gap-loading-started":
      return { ...state, gaps: state.gaps.map((g) => (sameGap(g, action) ? { ...g, loading: action.side } : g)) };

    case "gap-loading-finished":
      return { ...state, gaps: state.gaps.map((g) => (sameGap(g, action) ? { ...g, loading: undefined } : g)) };

    case "chunk-jump-loaded": {
      const have = new Set(state.messages.map((m) => m.id));
      const fresh = action.items.filter((m) => !have.has(m.id));
      const at = state.messages.findIndex((m) => m.id === action.beforeId);
      if (fresh.length === 0 || at < 0) return state;
      const before = state.messages[at - 1]; // the loaded item just above where the chunk goes
      let gaps = state.gaps;
      if (before) {
        // The hole that used to be here is split: one above the chunk, one below it (unless complete).
        gaps = gaps.filter((g) => !(g.afterId === before.id && g.beforeId === action.beforeId));
        gaps = [...gaps, { afterId: before.id, beforeId: fresh[0].id }];
      }
      if (!action.complete) gaps = [...gaps, { afterId: fresh[fresh.length - 1].id, beforeId: action.beforeId }];
      return {
        ...state,
        messages: [...state.messages.slice(0, at), ...fresh, ...state.messages.slice(at)],
        gaps,
        // Nothing loaded above the chunk: older history may exist above it.
        hasMore: before ? state.hasMore : true,
      };
    }

    case "gap-filled": {
      if (!state.gaps.some((g) => sameGap(g, action))) return state; // stale (the gap is gone)
      const have = new Set(state.messages.map((m) => m.id));
      const fresh = action.items.filter((m) => !have.has(m.id));
      const anchor = state.messages.findIndex((m) => m.id === (action.side === "top" ? action.afterId : action.beforeId));
      if (anchor < 0) return state;
      const at = action.side === "top" ? anchor + 1 : anchor;
      const messages = [...state.messages.slice(0, at), ...fresh, ...state.messages.slice(at)];
      // Nothing came back, or the whole range was returned: the hole is closed.
      const closed = action.complete || fresh.length === 0;
      const gaps = state.gaps.flatMap((g): Gap[] => {
        if (!sameGap(g, action)) return [g];
        if (closed) return [];
        return [action.side === "top" ? { afterId: fresh[fresh.length - 1].id, beforeId: g.beforeId } : { afterId: g.afterId, beforeId: fresh[0].id }];
      });
      return { ...state, messages, gaps };
    }

    case "older-loaded":
      return action.items.length > 0
        ? { ...state, messages: [...action.items, ...state.messages], hasMore: action.hasMore }
        : { ...state, hasMore: false };

    case "timeline-activity": {
      // The operations of an item still being worked on, as the server has them now. An item that is not (or no longer) in the list,
      // or has already ended, is left alone: its final upsert carries its final operations.
      const idx = state.messages.findIndex((m) => m.id === action.id);
      if (idx === -1 || state.messages[idx].status !== "streaming") return state;
      return { ...state, messages: state.messages.map((m, i) => (i === idx ? { ...m, activity: action.activity } : m)) };
    }

    case "crew-status-changed":
      return { ...state, crewActivitySignal: bumpSignal(state, action.role) };

    case "timeline-upsert": {
      const { item, activeMissionId } = action;
      // Drop events of other missions (concurrency is per mission, so it is quite normal for a turn of a mission
      // not being viewed to be running in the background. It must not mix into this screen).
      // However, the crew status update signal alone is treated, for an event of any mission, as a
      // "you may go and check" signal.
      if (item.missionId !== activeMissionId) {
        return item.role !== "captain" ? { ...state, crewActivitySignal: bumpSignal(state, signalRole(item)) } : state;
      }

      const idx = state.messages.findIndex((m) => m.id === item.id);
      const messages = idx === -1 ? [...state.messages, item] : state.messages.map((m, i) => (i === idx ? item : m));
      let next: ChatState = { ...state, messages };
      // The server decides which form locks the input (`locksInput` on its item) and tells the snapshot as `openUiItemId`; a form is answered
      // or closed after the snapshot was taken, and that arrives as the upsert of its reply, so the lock follows that item (no separate event).
      if (item.a2ui) {
        next = { ...next, openUiItemId: item.a2ui.locksInput ? item.id : state.openUiItemId === item.id ? null : state.openUiItemId };
      }

      // An upsert of anything other than captain (the commander itself or a crew member) is, for the crew status panel,
      // a signal "you may check right now without polling".
      if (item.role !== "captain") next = { ...next, crewActivitySignal: bumpSignal(state, signalRole(item)) };

      // A non-streaming upsert for a turn of the conversation with the captain (the same whoever it is with) — success, error,
      // cancellation, or a recovery notice — means the turn has ended.
      // (Forgetting this leaves the send button stuck on the hourglass.)
      if (isTurn(item) && item.status !== "streaming") next = { ...next, isSending: false };
      return next;
    }

    case "timeline-append": {
      const idx = state.messages.findIndex((m) => m.id === action.id);
      if (idx === -1) return state;
      return {
        ...state,
        messages: state.messages.map((m, i) => (i === idx ? { ...m, text: m.text + action.text } : m)),
      };
    }

    case "timeline-remove":
      // Fires only for a turn that ended with nothing to show (e.g. an empty auto-resume response)
      // — it always means the turn in progress has ended.
      return {
        ...state,
        messages: state.messages.filter((m) => m.id !== action.id),
        isSending: false,
      };

    case "message-sent":
      return { ...state, messages: [...state.messages, action.message], isSending: true };

    case "send-failed":
      return { ...state, isSending: false, messages: [...state.messages, action.message] };

    case "a2ui-failed":
      return { ...state, messages: [...state.messages, action.message] };
  }
}
