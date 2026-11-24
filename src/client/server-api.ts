import type {
  A2uiAnswer,
  CrewMemberConfig,
  CrewProfile,
  CrewHostGroup,
  CrewModelEntry,
  CrewTasks,
  Language,
  Message,
  Mission,
  PendingPermission,
  PinnedMessage,
  SearchResponse,
  SettingsConfigState,
  SettingsMemberFields,
  SettingsRosterState,
  SettingsHostsState,
  QuickActionItem,
  SettingsQuickAction,
  SettingsQuickActionsState,
  SettingsImportErrors,
  SettingsImportRequest,
  SettingsImportScan,
  SettingsOverview,
  SettingsShipFields,
  SettingsShipRuntime,
  SettingsShipState,
  TaskDetail,
  Theme,
} from "./types";

// The only place that calls the server's API. (Do not start the file name with "api" — Vite's dev server
// relays paths starting with "/api" to the backend, so this file would no longer load.)
// Building the URL (including encoding), the method, headers, and body, and
// the connection target (baseUrl) are gathered here. The target is decided by `VITE_API_BASE`, and when unset it is, as before,
// a same-origin relative path (when connecting to another server from a desktop app or mobile, only this place changes).
//
// Each function returns the `Response` as is. How to look at `res.ok` (tolerating 404, continuing even on failure, etc.)
// differs per caller, so it is not unified here. Only the type of `json()` is added.

/** A `Response` with `json()` typed. The body on error (`{ error }`) can be read too. */
export type ApiResponse<T = object> = Omit<Response, "json"> & { json(): Promise<T & { error?: string }> };

/**
 * What the chat feed needs from a push channel: the part of `EventSource` that useSSE.ts uses. The browser's `EventSource`
 * satisfies it as is; a desktop shell can supply its own channel (over IPC) instead of an HTTP stream.
 */
export type EventStream = Pick<EventSource, "addEventListener" | "removeEventListener" | "close" | "readyState" | "onopen" | "onerror">;

/** `readyState` of a channel that is closed and will not reconnect by itself (the value of `EventSource.CLOSED`). */
export const EVENT_STREAM_CLOSED = 2;

export type ApiOptions = {
  /**
   * The leading part of the connection target (e.g. `https://example.com`). A same-origin relative path when omitted.
   */
  baseUrl?: string;
  /** The fetch implementation. When omitted, the global fetch (replaced in tests). */
  fetch?: typeof fetch;
  /** Opens the push channel for the URL of `eventsUrl()`. When omitted, the browser's `EventSource` (replaced by a desktop shell and in tests). */
  openEventStream?: (url: string) => EventStream;
};

/** What is needed to create a pin (POST /api/pins). */
export type CreatePinBody = {
  messageId: string;
  role: string;
  text: string;
  timestamp: string;
  missionId: string;
};

const JSON_HEADERS = { "Content-Type": "application/json" };

export function createApi(options: ApiOptions = {}) {
  const baseUrl = options.baseUrl ?? "";
  const enc = encodeURIComponent;

  function request<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
    const doFetch = options.fetch ?? fetch;
    return doFetch(`${baseUrl}${path}`, init) as Promise<ApiResponse<T>>;
  }
  /** Sends with JSON as the body. */
  function send<T>(method: "POST" | "PATCH" | "PUT", path: string, body: unknown, signal?: AbortSignal): Promise<ApiResponse<T>> {
    return request<T>(path, { method, headers: JSON_HEADERS, body: JSON.stringify(body), signal });
  }

  return {
    /** Connection URL for SSE (chat updates). Passed to EventSource. */
    eventsUrl: () => `${baseUrl}/api/events/bridge`,
    /** Opens the SSE channel (chat updates). */
    openEvents: (): EventStream => (options.openEventStream ?? ((url) => new EventSource(url)))(`${baseUrl}/api/events/bridge`),

    // --- Chat timeline ---
    getTimeline: (missionId: string, signal?: AbortSignal) =>
      request<{ items: Message[]; hasMore: boolean; openUiItemId: string | null }>(`/api/timeline?missionId=${enc(missionId)}`, { signal }),
    /**
     * Items between two items of the history (by id): a chunk starting at an old item (jump),
     * or the next / previous items of a gap. See GET /api/timeline/range.
     */
    /** The captain's earlier messages in a mission, newest first (for the ↑ history of the input box). */
    getCaptainHistory: (missionId: string, signal?: AbortSignal) =>
      request<{ items: { id: string; text: string; timestamp: string }[] }>(`/api/timeline/captain-history?missionId=${enc(missionId)}`, { signal }),
    getTimelineRange: (p: { missionId: string; afterId?: string; inclusive?: boolean; beforeId?: string; dir: "asc" | "desc"; limit?: number }) => {
      const q = new URLSearchParams({ missionId: p.missionId, dir: p.dir });
      if (p.afterId) q.set("after", p.afterId);
      if (p.inclusive) q.set("inclusive", "1");
      if (p.beforeId) q.set("before", p.beforeId);
      if (p.limit) q.set("limit", String(p.limit));
      return request<{ items: Message[]; complete: boolean }>(`/api/timeline/range?${q.toString()}`);
    },
    getOlderTimeline: (before: string, missionId: string) =>
      request<{ items: Message[]; hasMore: boolean }>(`/api/timeline/older?before=${enc(before)}&missionId=${enc(missionId)}`),

    // --- Ship config ---
    getConfig: (signal?: AbortSignal) => request<{ defaultTarget: string | null; shipName: string; language: Language; crewLanguage: Language; theme: Theme }>("/api/config", { signal }),
    /**
     * Tells the desktop app how tall the header is and how much room it keeps at both ends together (in CSS pixels), so it can put the window buttons in the
     * middle of it and keep the window wide enough; the answer is the page's zoom. It is answered by the app around the page, not by the ship: outside the desktop app nothing answers it, and nothing asks.
     */
    reportShellWindow: (info: { height: number; room: number }) => send<{ zoom: number }>("POST", "/__shell/window", info),
    /** Saves the UI language on the server. */
    setLanguage: (language: Language) => send<{ language: Language }>("PUT", "/api/config/language", { language }),
    /** Saves the language the crew speaks on the server (separate from the UI language). */
    setCrewLanguage: (language: Language) => send<{ language: Language }>("PUT", "/api/config/crew-language", { language }),
    // --- Settings server (--settings) ---
    getSettingsOverview: (signal?: AbortSignal) => request<SettingsOverview>("/api/settings/overview", { signal }),
    getSettingsConfig: (signal?: AbortSignal) => request<SettingsConfigState & { message?: string }>("/api/settings/config", { signal }),
    /** Saves values of config.yml (key → value; null clears it to the default). A refusal has `errors` per key. */
    saveSettingsConfig: (values: Record<string, unknown>) =>
      send<SettingsConfigState & { errors?: Record<string, string>; message?: string }>("PUT", "/api/settings/config", { values }),
    getSettingsHosts: (signal?: AbortSignal) => request<SettingsHostsState & { message?: string }>("/api/settings/hosts", { signal }),
    saveSettingsHosts: (hosts: { name: string; destination: string }[]) =>
      send<SettingsHostsState & { errors?: Record<string, string>; message?: string }>("PUT", "/api/settings/hosts", { hosts }),
    getSettingsQuickActions: (signal?: AbortSignal) => request<SettingsQuickActionsState & { message?: string }>("/api/settings/quick-actions", { signal }),
    saveSettingsQuickActions: (actions: Partial<SettingsQuickAction>[]) =>
      send<SettingsQuickActionsState & { errors?: Record<string, string>; message?: string }>("PUT", "/api/settings/quick-actions", { actions }),
    /** The custom menu of this ship. */
    getQuickActions: (signal?: AbortSignal) => request<{ actions: QuickActionItem[]; message?: string }>("/api/quick-actions", { signal }),
    /** `seen`: the IDs of the items the editor loaded (an item that appeared after that is not taken off this ship by the save). */
    saveQuickActions: (actions: Partial<QuickActionItem>[], seen: string[]) =>
      send<{ actions: QuickActionItem[]; errors?: Record<string, string>; message?: string }>("PUT", "/api/quick-actions", { actions, seen }),
    getSettingsRoster: (signal?: AbortSignal) => request<SettingsRosterState & { message?: string }>("/api/settings/roster", { signal }),
    createSettingsMember: (id: string, fields: SettingsMemberFields) =>
      send<SettingsRosterState & { errors?: Record<string, string> }>("POST", "/api/settings/roster", { id, ...fields }),
    saveSettingsMember: (id: string, fields: SettingsMemberFields) =>
      send<SettingsRosterState & { errors?: Record<string, string> }>("PUT", `/api/settings/roster/${enc(id)}`, fields),
    deleteSettingsMember: (id: string) =>
      request<SettingsRosterState & { errors?: Record<string, string>; usedBy?: { ship: string; role: string }[] }>(`/api/settings/roster/${enc(id)}`, { method: "DELETE" }),
    getSettingsPersona: (id: string) => request<{ text: string; exists: boolean }>(`/api/settings/roster/${enc(id)}/persona`),
    saveSettingsPersona: (id: string, text: string) => send<{ text: string; exists: boolean }>("PUT", `/api/settings/roster/${enc(id)}/persona`, { text }),
    /** The URL of a member's icon (a changing `version` makes the browser fetch it again). */
    settingsIconUrl: (id: string, version: number) => `${baseUrl}/api/settings/roster/${enc(id)}/icon?v=${version}`,
    uploadSettingsIcon: (id: string, image: Blob) =>
      request<{ status?: string; error?: string }>(`/api/settings/roster/${enc(id)}/icon`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: image }),
    deleteSettingsIcon: (id: string) => request(`/api/settings/roster/${enc(id)}/icon`, { method: "DELETE" }),
    getSettingsRuntime: (signal?: AbortSignal) => request<{ ships: SettingsShipRuntime[]; shipUi: boolean; desktop: boolean }>("/api/settings/runtime", { signal }),
    startSettingsShip: (id: string) => request<SettingsShipRuntime & { message?: string }>(`/api/settings/ships/${enc(id)}/start`, { method: "POST" }),
    stopSettingsShip: (id: string) => request<{ status?: string; message?: string }>(`/api/settings/ships/${enc(id)}/stop`, { method: "POST" }),
    getSettingsShipLog: (id: string) => request<{ text: string }>(`/api/settings/ships/${enc(id)}/log`),
    scanSettingsImport: (path: string) => send<SettingsImportScan & { message?: string }>("POST", "/api/settings/import/scan", { path }),
    saveSettingsImport: (body: SettingsImportRequest) =>
      send<{ shipId: string; createdMembers: string[]; errors?: SettingsImportErrors; message?: string }>("POST", "/api/settings/import", body),
    /** Removes a ship and everything it kept. `confirm` must repeat the ship's ID. */
    deleteSettingsShip: (id: string) =>
      request<{ status?: string; message?: string }>(`/api/settings/ships/${enc(id)}`, { method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify({ confirm: id }) }),
    getSettingsShip: (id: string, signal?: AbortSignal) => request<SettingsShipState & { error?: string }>(`/api/settings/ships/${enc(id)}`, { signal }),
    /** Creates the minimal ship (a commander role holding `member`). A refusal has `errors` per field. */
    createSettingsShip: (ship: { id: string; port: number; name: string | null; member: string }) =>
      send<SettingsShipState & { errors?: Record<string, string> }>("POST", "/api/settings/ships", ship),
    saveSettingsShip: (id: string, fields: SettingsShipFields) =>
      send<SettingsShipState & { errors?: Record<string, string> }>("PUT", `/api/settings/ships/${enc(id)}`, { fields }),
    getCrew: (signal?: AbortSignal) => request<Record<string, CrewMemberConfig>>("/api/crew", { signal }),

    // --- Missions ---
    getMissions: (signal?: AbortSignal) => request<Mission[]>("/api/missions", { signal }),
    createMission: (name: string) => send<Mission>("POST", "/api/missions", { name }),
    setMissionArchived: (missionId: string, archived: boolean) =>
      send<Mission>("PATCH", `/api/missions/${enc(missionId)}`, { archived }),

    // --- Crew models (per mission) ---
    /** One crew member's personnel record (summary of settings, persona contents, briefing). */
    getCrewProfile: (role: string, signal?: AbortSignal) => request<CrewProfile>(`/api/crew/${enc(role)}/profile`, { signal }),
    /**
     * Uploads an icon image (the body is the image's bytes; the server decides the kind from the contents).
     */
    uploadCrewIcon: (role: string, image: Blob) =>
      request<{ status: string; icon?: string; reason?: string }>(`/api/crew/${enc(role)}/icon`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: image,
      }),
    /** Removes the icon and goes back to the default avatar. */
    deleteCrewIcon: (role: string) => request(`/api/crew/${enc(role)}/icon`, { method: "DELETE" }),
    /**
     * Searches conversations. Do not call it when `missionIds` is an empty array (on the server, that is the same as no mission being
     * specified = all missions). `from` is included and `to` is excluded (ISO format).
     */
    search: (
      p: { q: string; missionIds: string[]; from?: string; to?: string; captain: boolean; replies: boolean; tasks: boolean },
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams({ q: p.q, missions: p.missionIds.join(","), captain: p.captain ? "1" : "0", replies: p.replies ? "1" : "0", tasks: p.tasks ? "1" : "0" });
      if (p.from) query.set("from", p.from);
      if (p.to) query.set("to", p.to);
      return request<SearchResponse>(`/api/search?${query.toString()}`, { signal });
    },
    getCrewModels: (missionId: string, signal?: AbortSignal) =>
      request<CrewModelEntry[]>(`/api/missions/${enc(missionId)}/crew-models`, { signal }),
    /** If `model` is null, removes this mission's override and goes back to the default. */
    setCrewModel: (missionId: string, role: string, model: string | null) =>
      send<CrewModelEntry>("PUT", `/api/missions/${enc(missionId)}/crew-models/${enc(role)}`, { model }),

    // --- Entry point of conversations ---
    /** Talks to one crew member of the ship (every crew member has the same entry point). */
    sendMessage: (role: string, text: string, missionId: string, signal?: AbortSignal) =>
      send("POST", `/api/crew/${enc(role)}/message`, { text, missionId }, signal),
    /**
     * Sends "report" to that crew member (the crew member reports the unreported tasks it is allowed to see).
     */
    sendReport: (role: string, missionId: string, signal?: AbortSignal) =>
      send("POST", `/api/crew/${enc(role)}/report`, { missionId }, signal),
    /** A button of an A2UI form was pressed: the server sends the action to the crew member that drew it and marks the form answered. */
    answerA2ui: (itemId: string, answer: A2uiAnswer) =>
      send<{ messageId: string; status: "accepted" }>("POST", `/api/a2ui/${enc(itemId)}/answer`, answer),
    /** The captain closes an A2UI form without answering it: the reply keeps a mark saying so, and the input box is free again. */
    dismissA2ui: (itemId: string) => send<{ status: "dismissed" }>("POST", `/api/a2ui/${enc(itemId)}/dismiss`, {}),
    cancelTurn: (missionId: string) => send("POST", "/api/bridge/cancel", { missionId }),
    cancelCrewTask: (taskId: string) => request(`/api/crew/${enc(taskId)}/cancel`, { method: "POST" }),
    refreshCredits: () => request("/api/bridge/refresh-credits", { method: "POST" }),

    // --- permission ---
    getPermissions: (signal?: AbortSignal) => request<{ permissions: PendingPermission[] }>("/api/permissions", { signal }),
    respondPermission: (key: string, optionId: string) =>
      send("POST", `/api/permissions/${enc(key)}/respond`, { optionId }),

    // --- Crew state and tasks ---
    getCrewStatus: (missionId: string, signal?: AbortSignal) =>
      request<CrewHostGroup[]>(`/api/crew/status?missionId=${enc(missionId)}`, { signal }),
    getCrewTasks: (role: string, limit: number, missionId: string) =>
      request<CrewTasks>(`/api/crew/${enc(role)}/tasks?limit=${limit}&missionId=${enc(missionId)}`),
    restartAgent: (role: string, missionId: string) => send("POST", `/api/agents/${enc(role)}/restart`, { missionId }),
    getTaskResult: (taskId: string, signal?: AbortSignal) => request<TaskDetail>(`/api/results/${enc(taskId)}`, { signal }),

    // --- Pins ---
    getPins: (missionId: string, signal?: AbortSignal) =>
      request<PinnedMessage[]>(`/api/pins?missionId=${enc(missionId)}`, { signal }),
    createPin: (body: CreatePinBody) => send<PinnedMessage>("POST", "/api/pins", body),
    deletePin: (messageId: string) => request(`/api/pins/${enc(messageId)}`, { method: "DELETE" }),
  };
}

export type Api = ReturnType<typeof createApi>;

/**
 * The API client the app uses. The connection target is the build-time environment variable `VITE_API_BASE` (same origin when unset).
 */
export const api = createApi({ baseUrl: import.meta.env.VITE_API_BASE ?? "" });
