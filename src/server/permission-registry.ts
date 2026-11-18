import { broadcast } from "./sse-emitter.js";
import type { PendingPermission } from "./types.js";

// The single source of truth for pending permission requests. It is independent of the conversation/message history.
// A request is always registered here the moment it fires, regardless of whether anything downstream can currently
// match it to a chat message. Visibility and answerability must never depend on whether that matching succeeds.
const pending = new Map<string, PendingPermission>();

export function registerPermission(permission: PendingPermission): void {
  pending.set(permission.key, permission);
  broadcast({ type: "permission:requested", data: permission });
}

/**
 * Non-destructive lookup — used to check whether a request is deliverable before committing to resolvePermission.
 */
export function peekPermission(key: string): PendingPermission | undefined {
  return pending.get(key);
}

/**
 * Removes and returns the pending entry. Returns undefined if it is already resolved or unknown (idempotent).
 */
export function resolvePermission(key: string): PendingPermission | undefined {
  const permission = pending.get(key);
  if (!permission) return undefined;
  pending.delete(key);
  broadcast({ type: "permission:resolved", data: { key } });
  return permission;
}

/**
 * Discards all pending entries of one scope (e.g. an agent being restarted) and notifies clients.
 * When `missionId` is given, only entries from that mission's session are affected — sessions of the same crew member in other
 * missions stay alive, so their pending requests must not be swept away.
 */
export function clearScope(scope: string, missionId?: string): void {
  for (const [key, permission] of pending) {
    if (permission.scope !== scope) continue;
    if (missionId && permission.missionId !== missionId) continue;
    pending.delete(key);
    broadcast({ type: "permission:resolved", data: { key } });
  }
}

export function listPending(): PendingPermission[] {
  return Array.from(pending.values());
}
