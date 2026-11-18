import type { PendingPermission } from "./types";

// State of pending permissions (approvals) and its update (reducer). It is independent of `messages` —
// it is not tied to a chat bubble, so whether it can be shown/answered does not depend on whether a message exists
// (see PermissionTray).

export type PermissionState = {
  /** Pending requests. Keyed by their own `key`. */
  pending: Map<string, PendingPermission>;
  /**
   * Keys resolved within roughly the last 30 seconds. If a resolution happens while a GET /api/permissions fetch is in flight,
   * an old snapshot that still contains that key can come back — without this, merging it
   * again would revive a request that has already been answered.
   */
  recentlyResolved: Set<string>;
};

export type PermissionAction =
  /** A new approval arrived from the server (SSE). */
  | { type: "requested"; permission: PendingPermission }
  /** Resolved (answered here, or resolved elsewhere). Removed from the list and not revived for a while. */
  | { type: "resolved"; key: string }
  /**
   * Forget the "do not revive" record made right after resolution (about 30 seconds after it was resolved).
   */
  | { type: "resolved-forgotten"; key: string }
  /** Merges the server's list (GET /api/permissions) per key. */
  | { type: "hydrated"; permissions: PendingPermission[] }
  /** Puts back an approval that was optimistically removed, because the response failed. */
  | { type: "restored"; permission: PendingPermission };

export const initialPermissionState: PermissionState = { pending: new Map(), recentlyResolved: new Set() };

export function permissionReducer(state: PermissionState, action: PermissionAction): PermissionState {
  switch (action.type) {
    case "requested":
      return { ...state, pending: new Map(state.pending).set(action.permission.key, action.permission) };

    case "resolved": {
      const recentlyResolved = new Set(state.recentlyResolved).add(action.key);
      if (!state.pending.has(action.key)) return { ...state, recentlyResolved };
      const pending = new Map(state.pending);
      pending.delete(action.key);
      return { pending, recentlyResolved };
    }

    case "resolved-forgotten": {
      if (!state.recentlyResolved.has(action.key)) return state;
      const recentlyResolved = new Set(state.recentlyResolved);
      recentlyResolved.delete(action.key);
      return { ...state, recentlyResolved };
    }

    case "hydrated": {
      // Do not replace wholesale: we must never overwrite an SSE event that arrived before this fetch's response
      // with an old snapshot.
      let pending: Map<string, PendingPermission> | null = null;
      for (const p of action.permissions) {
        if (state.pending.has(p.key) || state.recentlyResolved.has(p.key)) continue;
        pending ??= new Map(state.pending);
        pending.set(p.key, p);
      }
      return pending ? { ...state, pending } : state;
    }

    case "restored": {
      const { key } = action.permission;
      const recentlyResolved = new Set(state.recentlyResolved);
      recentlyResolved.delete(key);
      const pending = state.pending.has(key) ? state.pending : new Map(state.pending).set(key, action.permission);
      return { pending, recentlyResolved };
    }
  }
}
