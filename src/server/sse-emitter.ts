import type { Response } from "express";
import type { SSEEvent } from "./types.js";

type SSEConnection = {
  id: string;
  res: Response;
  channel: string; // "all" | "bridge" | agent name
};

type SSEConnectionCallback = (res: Response) => void;

let connectionIdCounter = 0;
let onNewConnectionCallback: SSEConnectionCallback | null = null;
let broadcastSeqCounter = 0;

const connections: SSEConnection[] = [];

// Heartbeat interval — keeps connections alive and detects dead ones.
// 15 seconds is aggressive enough to survive the idle timeout of most proxies (typically 30-60 seconds).
const HEARTBEAT_INTERVAL_MS = 15_000;
// A client that does not read falls behind; once this much is waiting to be sent to it, the connection is closed (the browser
// reconnects and fetches a fresh snapshot) instead of letting the server's memory grow.
const MAX_BUFFERED_BYTES = 1024 * 1024;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function generateConnectionId(): string {
  return `sse_${++connectionIdCounter}_${Date.now()}`;
}

/**
 * Registers a callback called when a new SSE connection is established.
 * Used to send cached data to a newly connected client.
 */
export function onNewConnection(callback: SSEConnectionCallback): void {
  onNewConnectionCallback = callback;
}

function startHeartbeat(): void {
  if (heartbeatTimer) return; // already running
  heartbeatTimer = setInterval(() => {
    // Iterates over a copy: closing a connection removes it from the list.
    for (const connection of [...connections]) {
      try {
        // write() returning false is only backpressure (a slow client), not a broken connection; it is closed
        // below once too much is waiting. A write that throws means the connection is dead.
        connection.res.write(": heartbeat\n\n");
        if (isTooFarBehind(connection)) closeConnection(connection);
      } catch {
        closeConnection(connection);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function isTooFarBehind(connection: SSEConnection): boolean {
  return (connection.res.writableLength ?? 0) > MAX_BUFFERED_BYTES;
}

/**
 * Ends a connection that can no longer be served. The socket is closed, not just forgotten: a client that is only dropped
 * from the list would keep an open stream that never receives anything, and its EventSource would never reconnect.
 */
function closeConnection(connection: SSEConnection): void {
  removeConnection(connection.id);
  try {
    connection.res.destroy?.();
  } catch {
    // already gone
  }
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function addConnection(res: Response, channel: string): string {
  const id = generateConnectionId();

  // Sets the SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Sends an initial comment to establish the connection
  res.write(": connected\n\n");

  const connection: SSEConnection = { id, res, channel };
  connections.push(connection);

  // Starts the heartbeat if this is the first connection
  if (connections.length === 1) {
    startHeartbeat();
  }

  // Sends cached data to the newly connected client
  if (onNewConnectionCallback) {
    onNewConnectionCallback(res);
  }

  // Cleans up on disconnect
  res.on("close", () => {
    removeConnection(id);
  });

  return id;
}

export function removeConnection(id: string): void {
  const index = connections.findIndex((c) => c.id === id);
  if (index !== -1) {
    connections.splice(index, 1);
  }
  // Stops the heartbeat when no connections remain
  if (connections.length === 0) {
    stopHeartbeat();
  }
}

export function broadcast(event: SSEEvent): void {
  const eventType = event.type;
  const data = JSON.stringify(event.data);
  const seq = ++broadcastSeqCounter;
  const payload = `id: ${seq}\nevent: ${eventType}\ndata: ${data}\n\n`;

  // Decides which channels should receive this event
  const targetChannels = getTargetChannels(event);

  for (const connection of [...connections]) {
    if (targetChannels.includes(connection.channel) || connection.channel === "all") {
      try {
        connection.res.write(payload);
        if (isTooFarBehind(connection)) closeConnection(connection);
      } catch {
        // The connection is broken
        closeConnection(connection);
      }
    }
  }
}

function getTargetChannels(event: SSEEvent): string[] {
  switch (event.type) {
    case "timeline:upsert":
    case "timeline:append":
    case "timeline:remove":
    case "timeline:activity":
    case "permission:requested":
    case "permission:resolved":
      return ["bridge"];
    case "credits:usage":
      return ["bridge"];
    case "task:progress":
    case "task:complete":
      return ["all", event.data.agent];
    case "notification:task_complete":
    case "notification:escalation":
      return ["all", "bridge"];
    case "crew:status_changed":
      return ["bridge"];
    case "log":
      return ["all"];
    default:
      return ["all"];
  }
}

export function getConnectionCount(): number {
  return connections.length;
}
