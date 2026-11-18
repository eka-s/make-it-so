import { useCallback, useReducer } from "react";
import { api } from "./server-api";
import { initialPermissionState, permissionReducer } from "./permission-state";
import type { PendingPermission } from "./types";

/**
 * How long to keep a record of resolved approvals so they are "not revived" (to avoid a race with fetching an old snapshot).
 */
const RESOLVED_MEMORY_MS = 30_000;

/**
 * State of and operations on pending permissions (approvals). Updating the state is done by the reducer in permission-state.ts;
 * this only holds the exchange with the server (fetching, responding) and the timers.
 */
export function usePermissions() {
  const [state, dispatch] = useReducer(permissionReducer, initialPermissionState);

  /** Takes the approvals in from the server (the source of truth) (merged per key). */
  const hydrate = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await api.getPermissions(signal);
      if (!res.ok) return;
      const data: { permissions: PendingPermission[] } = await res.json();
      dispatch({ type: "hydrated", permissions: data.permissions });
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        console.error("Failed to load pending permissions:", err);
      }
    }
  }, []);

  const onRequested = useCallback((permission: PendingPermission) => {
    dispatch({ type: "requested", permission });
  }, []);

  const onResolved = useCallback((key: string) => {
    dispatch({ type: "resolved", key });
    setTimeout(() => dispatch({ type: "resolved-forgotten", key }), RESOLVED_MEMORY_MS);
  }, []);

  /**
   * Sends the captain's response. It is removed from the screen first (optimistically), and put back only when the server left it pending.
   */
  const respond = useCallback(async (key: string, optionId: string) => {
    const removed = state.pending.get(key);
    onResolved(key);
    try {
      const res = await api.respondPermission(key, optionId);
      // 404 = it was really already resolved elsewhere, so there is nothing to put back. Any other non-2xx (e.g. 503)
      // means the server deliberately left it pending — put it back so the captain can retry.
      if (!res.ok && res.status !== 404 && removed) dispatch({ type: "restored", permission: removed });
    } catch {
      // Network failure — the server-side state is unknown. Leave it removed and reconcile at the next fetch/SSE.
    }
  }, [onResolved, state.pending]);

  return { pendingList: Array.from(state.pending.values()), hydrate, onRequested, onResolved, respond };
}
