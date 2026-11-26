import { useEffect, useRef } from "react";
import type { AccountsSnapshot, PendingPermission, Message, ThinkingEntry } from "./types";
import { api } from "./server-api";

type UseSSEOptions = {
  // The whole event surface of the chat feed. It mirrors server/timeline.ts:
  // upsert = a whole item (newly created, or a change other than the text),
  // append = a chunk delta added to the text the item already has,
  // remove = a complete removal (rare — only when "there turned out to be nothing to show").
  onTimelineUpsert: (item: Message) => void;
  onTimelineAppend: (id: string, text: string) => void;
  onTimelineRemove: (id: string) => void;
  // The operations (tool calls) of an item still being worked on changed: replaces the `activity` of that item.
  onTimelineActivity: (id: string, activity: ThinkingEntry) => void;
  onCreditsUsage?: (data: AccountsSnapshot) => void;
  // A signal that a crew member's state (starting, restarting, etc.) changed. On receiving it, fetch the crew status again.
  onCrewStatusChanged?: (data: { role: string; missionId: string }) => void;
  // A signal that the ship's Memory changed. On receiving it, a Memory pane that is open fetches again what it shows.
  onMemoryChanged?: () => void;
  onReconnect?: () => void;
  /** Called with false when the connection is lost and with true when it is up. */
  onConnectionChange?: (connected: boolean) => void;
  onPermissionRequested?: (permission: PendingPermission) => void;
  onPermissionResolved?: (key: string) => void;
};

// Reconnection settings
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

// A module-level singleton — guarantees that exactly one EventSource exists even across StrictMode's double mount
let singletonES: EventSource | null = null;
let subscriberCount = 0;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let hasConnectedOnce = false;

// Registry of reconnection callbacks — called when a reconnection succeeds
let onReconnectCallback: (() => void) | null = null;
// Told whether the connection is up (the screen shows a notice while it is not).
let onConnectionChangeCallback: ((connected: boolean) => void) | null = null;

// Registry of listeners — makes re-registration on reconnection possible
type ListenerEntry = {
  eventType: string;
  handler: (event: MessageEvent) => void;
};
let activeListeners: ListenerEntry[] = [];

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function getReconnectDelay(): number {
  // Exponential backoff with jitter: base * 2^attempt + random jitter
  const exponential = RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.min(reconnectAttempts, 16));
  const jitter = Math.random() * RECONNECT_BASE_DELAY_MS;
  return Math.min(exponential + jitter, RECONNECT_MAX_DELAY_MS);
}

function createEventSource(): EventSource {
  const es = new EventSource(api.eventsUrl());

  es.onerror = () => {
    // EventSource.CLOSED = 2 — from this state the browser does not reconnect automatically
    if (es.readyState === EventSource.CLOSED) {
      console.warn("[SSE] Connection CLOSED. Scheduling reconnection...");
      singletonES = null;
      onConnectionChangeCallback?.(false);
      scheduleReconnect();
    } else {
      // readyState === CONNECTING — the browser is reconnecting automatically, only log
      console.warn("[SSE] Connection error, browser attempting auto-reconnect");
      onConnectionChangeCallback?.(false);
    }
  };

  es.onopen = () => {
    // Connection succeeded — reset the retry counter
    const isReconnection = hasConnectedOnce;
    reconnectAttempts = 0;
    hasConnectedOnce = true;
    console.info("[SSE] Connection established");
    onConnectionChangeCallback?.(true);

    // If this is a re-establishment (not the first connection), fire the reconnection callbacks
    if (isReconnection && onReconnectCallback) {
      onReconnectCallback();
    }
  };

  return es;
}

function scheduleReconnect(): void {
  if (subscriberCount <= 0) {
    // There are no active subscribers — do not reconnect
    return;
  }

  // There is no limit on the attempts: a ship that was down for a few minutes must not leave a page that never comes back.
  // The delay grows to RECONNECT_MAX_DELAY_MS and stays there.
  clearReconnectTimer();

  const delay = getReconnectDelay();
  reconnectAttempts++;
  console.info(
    `[SSE] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts})`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    if (subscriberCount <= 0) return; // the subscribers left while waiting

    // Create a new EventSource
    singletonES = createEventSource();

    // Re-register all the active listeners on the new EventSource
    for (const entry of activeListeners) {
      singletonES.addEventListener(entry.eventType, entry.handler as EventListener);
    }
  }, delay);
}

function registerListener(eventType: string, handler: (event: MessageEvent) => void): void {
  activeListeners.push({ eventType, handler });
}

function unregisterListener(eventType: string, handler: (event: MessageEvent) => void): void {
  activeListeners = activeListeners.filter(
    (entry) => !(entry.eventType === eventType && entry.handler === handler)
  );
}

export function useSSE({ onTimelineUpsert, onTimelineAppend, onTimelineRemove, onTimelineActivity, onCreditsUsage, onCrewStatusChanged, onMemoryChanged, onReconnect, onConnectionChange, onPermissionRequested, onPermissionResolved }: UseSSEOptions) {
  const onTimelineUpsertRef = useRef(onTimelineUpsert);
  const onTimelineAppendRef = useRef(onTimelineAppend);
  const onTimelineRemoveRef = useRef(onTimelineRemove);
  const onTimelineActivityRef = useRef(onTimelineActivity);
  const onCreditsUsageRef = useRef(onCreditsUsage);
  const onCrewStatusChangedRef = useRef(onCrewStatusChanged);
  const onMemoryChangedRef = useRef(onMemoryChanged);
  const onReconnectRef = useRef(onReconnect);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const onPermissionRequestedRef = useRef(onPermissionRequested);
  const onPermissionResolvedRef = useRef(onPermissionResolved);

  // Batching chunks with rAF, per item id — in a period when several items (the commander's
  // own turn and several crew members) overlap, they can stream at the same time, each appending to a different
  // id, so buffering is done per id, and everything is flushed together once per animation frame.
  const chunkBuffersRef = useRef<Map<string, string[]>>(new Map());
  const rafIdRef = useRef<number | null>(null);

  // Keep the ref up to date without resubscribing
  onTimelineUpsertRef.current = onTimelineUpsert;
  onTimelineAppendRef.current = onTimelineAppend;
  onTimelineRemoveRef.current = onTimelineRemove;
  onTimelineActivityRef.current = onTimelineActivity;
  onCreditsUsageRef.current = onCreditsUsage;
  onCrewStatusChangedRef.current = onCrewStatusChanged;
  onMemoryChangedRef.current = onMemoryChanged;
  onReconnectRef.current = onReconnect;
  onConnectionChangeRef.current = onConnectionChange;
  onPermissionRequestedRef.current = onPermissionRequested;
  onPermissionResolvedRef.current = onPermissionResolved;

  useEffect(() => {
    // Before creating a new connection, close a stale one if there is one (just in case)
    if (singletonES && singletonES.readyState === EventSource.CLOSED) {
      singletonES = null;
    }

    if (!singletonES) {
      singletonES = createEventSource();
      reconnectAttempts = 0;
    }

    const eventSource = singletonES;
    subscriberCount++;

    // Register the onReconnect callback at module level
    onReconnectCallback = () => {
      onReconnectRef.current?.();
    };

    onConnectionChangeCallback = (connected) => onConnectionChangeRef.current?.(connected);

    // Visibility API: fire onReconnect when the tab becomes visible again. A connection that is down is retried at once
    // (it may be waiting out a long delay): the person looking at the tab should not wait for it.
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        if (!singletonES && subscriberCount > 0) {
          clearReconnectTimer();
          reconnectAttempts = 0;
          scheduleReconnect();
        }
        onReconnectRef.current?.();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    function scheduleFlush() {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const buffers = chunkBuffersRef.current;
        chunkBuffersRef.current = new Map();
        for (const [id, chunks] of buffers) {
          const text = chunks.join("");
          if (text) onTimelineAppendRef.current(id, text);
        }
      });
    }

    function onTimelineUpsertEvent(event: MessageEvent) {
      try {
        const item: Message = JSON.parse(event.data);
        // The `text` of an upsert is the complete authoritative state (the server also accumulates the same way
        // via timeline.append) — chunk fragments buffered for this id at this point are already
        // reflected in it, so they are discarded rather than added on top and applied twice.
        chunkBuffersRef.current.delete(item.id);
        onTimelineUpsertRef.current(item);
      } catch {
        // skip malformed events
      }
    }

    function onTimelineAppendEvent(event: MessageEvent) {
      try {
        const data: { id: string; text: string } = JSON.parse(event.data);
        const buf = chunkBuffersRef.current.get(data.id);
        if (buf) buf.push(data.text);
        else chunkBuffersRef.current.set(data.id, [data.text]);
        scheduleFlush();
      } catch {
        // skip malformed events
      }
    }

    function onTimelineRemoveEvent(event: MessageEvent) {
      try {
        const data: { id: string } = JSON.parse(event.data);
        chunkBuffersRef.current.delete(data.id);
        onTimelineRemoveRef.current(data.id);
      } catch {
        // skip malformed events
      }
    }

    function onTimelineActivityEvent(event: MessageEvent) {
      try {
        const data: { id: string; activity: ThinkingEntry } = JSON.parse(event.data);
        onTimelineActivityRef.current(data.id, data.activity);
      } catch {
        // skip malformed events
      }
    }

    function onCrewStatusChangedEvent(event: MessageEvent) {
      try {
        const data: { role: string; missionId: string } = JSON.parse(event.data);
        onCrewStatusChangedRef.current?.(data);
      } catch {
        // skip malformed events
      }
    }

    function onMemoryChangedEvent() {
      onMemoryChangedRef.current?.();
    }

    function onCreditsUsageEvent(event: MessageEvent) {
      try {
        const data: AccountsSnapshot = JSON.parse(event.data);
        onCreditsUsageRef.current?.(data);
      } catch {
        // skip malformed events
      }
    }

    function onPermissionRequestedEvent(event: MessageEvent) {
      try {
        const data: PendingPermission = JSON.parse(event.data);
        onPermissionRequestedRef.current?.(data);
      } catch { /* ignore */ }
    }

    function onPermissionResolvedEvent(event: MessageEvent) {
      try {
        const data: { key: string } = JSON.parse(event.data);
        onPermissionResolvedRef.current?.(data.key);
      } catch { /* ignore */ }
    }

    // Register the listener on the current EventSource
    eventSource.addEventListener("timeline:upsert", onTimelineUpsertEvent);
    eventSource.addEventListener("timeline:append", onTimelineAppendEvent);
    eventSource.addEventListener("timeline:remove", onTimelineRemoveEvent);
    eventSource.addEventListener("timeline:activity", onTimelineActivityEvent);
    eventSource.addEventListener("credits:usage", onCreditsUsageEvent);
    eventSource.addEventListener("crew:status_changed", onCrewStatusChangedEvent);
    eventSource.addEventListener("memory:changed", onMemoryChangedEvent);
    eventSource.addEventListener("permission:requested", onPermissionRequestedEvent);
    eventSource.addEventListener("permission:resolved", onPermissionResolvedEvent);

    // Also register in the global registry, for re-attaching on reconnection
    registerListener("timeline:upsert", onTimelineUpsertEvent);
    registerListener("timeline:append", onTimelineAppendEvent);
    registerListener("timeline:remove", onTimelineRemoveEvent);
    registerListener("timeline:activity", onTimelineActivityEvent);
    registerListener("credits:usage", onCreditsUsageEvent);
    registerListener("crew:status_changed", onCrewStatusChangedEvent);
    registerListener("memory:changed", onMemoryChangedEvent);
    registerListener("permission:requested", onPermissionRequestedEvent);
    registerListener("permission:resolved", onPermissionResolvedEvent);

    return () => {
      // Cancel a pending rAF flush, if any
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      chunkBuffersRef.current = new Map();

      // Remove the visibilitychange listener
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      // Clear the reconnection callbacks
      onReconnectCallback = null;
      onConnectionChangeCallback = null;

      // Remove from the current EventSource (if still alive)
      eventSource.removeEventListener("timeline:upsert", onTimelineUpsertEvent);
      eventSource.removeEventListener("timeline:append", onTimelineAppendEvent);
      eventSource.removeEventListener("timeline:remove", onTimelineRemoveEvent);
      eventSource.removeEventListener("timeline:activity", onTimelineActivityEvent);
      eventSource.removeEventListener("credits:usage", onCreditsUsageEvent);
      eventSource.removeEventListener("crew:status_changed", onCrewStatusChangedEvent);
      eventSource.removeEventListener("memory:changed", onMemoryChangedEvent);
      eventSource.removeEventListener("permission:requested", onPermissionRequestedEvent);
      eventSource.removeEventListener("permission:resolved", onPermissionResolvedEvent);

      // Remove from the global registry
      unregisterListener("timeline:upsert", onTimelineUpsertEvent);
      unregisterListener("timeline:append", onTimelineAppendEvent);
      unregisterListener("timeline:remove", onTimelineRemoveEvent);
      unregisterListener("timeline:activity", onTimelineActivityEvent);
      unregisterListener("credits:usage", onCreditsUsageEvent);
      unregisterListener("crew:status_changed", onCrewStatusChangedEvent);
      unregisterListener("memory:changed", onMemoryChangedEvent);
      unregisterListener("permission:requested", onPermissionRequestedEvent);
      unregisterListener("permission:resolved", onPermissionResolvedEvent);

      subscriberCount--;
      if (subscriberCount <= 0) {
        clearReconnectTimer();
        if (singletonES) {
          singletonES.close();
          singletonES = null;
        }
        subscriberCount = 0;
        reconnectAttempts = 0;
        hasConnectedOnce = false;
        onReconnectCallback = null;
        activeListeners = [];
      }
    };
  }, []);
}
