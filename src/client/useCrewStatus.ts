import { useCallback, useEffect, useState } from "react";
import { api } from "./server-api";
import type { CrewHostGroup } from "./types";

// Fetches and holds the running state of the current mission's crew (GET /api/crew/status). The crew status in the left pane
// and the input box (the partner's slash commands) use the same data.
// It is fetched once on mount and on mission switch, and when `activitySignal.tick` changes
// (the signal is emitted on timeline updates, SSE reconnection, and crew state changes). There is no periodic polling.
// The tunnel state of remote hosts is carried in the same response, but no signal is emitted when only the tunnel changes,
// so the display can stay stale until the next activity or a screen refresh (accepted).
export function useCrewStatus(missionId: string, activitySignal: { role: string | null; tick: number }): CrewHostGroup[] {
  const [groups, setGroups] = useState<CrewHostGroup[]>([]);

  const fetchStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await api.getCrewStatus(missionId, signal);
      if (res.ok) setGroups(await res.json());
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        console.error("Failed to fetch crew status:", err);
      }
    }
  }, [missionId]);

  // Initial fetch on mount (and when fetchStatus is recreated on mission switch)
  useEffect(() => {
    const controller = new AbortController();
    void fetchStatus(controller.signal);
    return () => controller.abort();
  }, [fetchStatus]);

  // Re-fetch immediately every time the signal fires. Do nothing when tick===0 (the initial value, nothing has happened yet)
  // — the initial fetch above covers that.
  useEffect(() => {
    if (activitySignal.tick === 0) return;
    void fetchStatus();
  }, [activitySignal.tick, fetchStatus]);

  return groups;
}
