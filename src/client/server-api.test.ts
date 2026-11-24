import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, type EventStream } from "./server-api";

// A fake fetch, to see which URL, method, headers, and body it was called with.
function setup(baseUrl?: string) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  });
  const api = createApi({ baseUrl, fetch: fakeFetch as unknown as typeof fetch });
  return { api, calls, last: () => calls[calls.length - 1] };
}
const JSON_HEADERS = { "Content-Type": "application/json" };

afterEach(() => vi.unstubAllGlobals());

describe("reads (GET)", () => {
  it("timeline: passes missionId encoded. The signal is passed too", async () => {
    const { api, last } = setup();
    const controller = new AbortController();
    await api.getTimeline("m 1/日本", controller.signal);
    expect(last().url).toBe(`/api/timeline?missionId=${encodeURIComponent("m 1/日本")}`);
    expect(last().init).toEqual({ signal: controller.signal });
  });

  it("older timeline: passes before and missionId encoded (no init object is attached)", async () => {
    const { api, last } = setup();
    await api.getOlderTimeline("2026-11-07T00:00:00Z", "m1");
    expect(last().url).toBe("/api/timeline/older?before=2026-11-07T00%3A00%3A00Z&missionId=m1");
    expect(last().init).toBeUndefined();
  });

  it.each([
    ["getConfig", (a: ReturnType<typeof createApi>) => a.getConfig(), "/api/config"],
    ["getCrew", (a: ReturnType<typeof createApi>) => a.getCrew(), "/api/crew"],
    ["getMissions", (a: ReturnType<typeof createApi>) => a.getMissions(), "/api/missions"],
    ["getPermissions", (a: ReturnType<typeof createApi>) => a.getPermissions(), "/api/permissions"],
  ])("%s makes a GET to a fixed URL", async (_name, call, url) => {
    const { api, last } = setup();
    await call(api);
    expect(last().url).toBe(url);
    expect(last().init?.method).toBeUndefined(); // GET
  });

  it("crew status/task history: encodes the crew name and the mission, and passes limit", async () => {
    const { api, last } = setup();
    await api.getCrewStatus("m 1");
    expect(last().url).toBe("/api/crew/status?missionId=m%201");
    await api.getCrewTasks("chief engineer", 10, "m 1");
    expect(last().url).toBe("/api/crew/chief%20engineer/tasks?limit=10&missionId=m%201");
  });

  it("task results and the list of pins", async () => {
    const { api, last } = setup();
    await api.getTaskResult("ensign_0001");
    expect(last().url).toBe("/api/results/ensign_0001");
    await api.getPins("m1");
    expect(last().url).toBe("/api/pins?missionId=m1");
  });
});

describe("writes (POST/PATCH/DELETE)", () => {
  it("creating and archiving missions", async () => {
    const { api, last } = setup();
    await api.createMission("New");
    expect(last().url).toBe("/api/missions");
    expect(last().init).toMatchObject({ method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name: "New" }) });

    await api.setMissionArchived("m 1", true);
    expect(last().url).toBe("/api/missions/m%201");
    expect(last().init).toMatchObject({ method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ archived: true }) });
  });

  it("conversation search: the conditions become the query (missions comma-separated, the period only when specified)", async () => {
    const { api, last } = setup();
    await api.search({ q: "ログイン 検証", missionIds: ["m1", "m 2"], captain: true, replies: false, tasks: true });
    const url = new URL(last().url, "http://x");
    expect(url.pathname).toBe("/api/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "ログイン 検証", missions: "m1,m 2", captain: "1", replies: "0", tasks: "1" });

    await api.search({ q: "x", missionIds: ["m1"], from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z", captain: false, replies: true, tasks: false });
    const params = new URL(last().url, "http://x").searchParams;
    expect(params.get("from")).toBe("2026-11-01T00:00:00.000Z");
    expect(params.get("to")).toBe("2026-11-02T00:00:00.000Z");
    expect(params.get("captain")).toBe("0");
  });

  it("sending a message: the same entry point for every crew member (the crew name is encoded. There are no special roles)", async () => {
    const { api, last } = setup();
    const controller = new AbortController();
    await api.sendMessage("first_officer", "hello", "m1", controller.signal);
    expect(last().url).toBe("/api/crew/first_officer/message");
    expect(last().init).toMatchObject({
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "hello", missionId: "m1" }),
      signal: controller.signal,
    });

    await api.sendMessage("chief_engineer", "please do it", "m1");
    expect(last().url).toBe("/api/crew/chief_engineer/message");
    expect(JSON.parse(String(last().init?.body))).toEqual({ text: "please do it", missionId: "m1" });
  });

  it("report, cancel, and re-fetching usage", async () => {
    const { api, last } = setup();
    await api.sendReport("chief engineer", "m1");
    expect(last().url).toBe("/api/crew/chief%20engineer/report");
    expect(last().init).toMatchObject({ method: "POST", body: JSON.stringify({ missionId: "m1" }) });

    await api.cancelTurn("m1");
    expect(last().url).toBe("/api/bridge/cancel");
    expect(last().init).toMatchObject({ method: "POST", body: JSON.stringify({ missionId: "m1" }) });

    await api.cancelCrewTask("ensign_0001");
    expect(last().url).toBe("/api/crew/ensign_0001/cancel");
    expect(last().init).toEqual({ method: "POST" });

    await api.refreshCredits();
    expect(last().url).toBe("/api/bridge/refresh-credits");
    expect(last().init).toEqual({ method: "POST" });
  });

  it("responding to a permission: encodes the key (the key contains :)", async () => {
    const { api, last } = setup();
    await api.respondPermission("chief_engineer:m1:7", "allow-once");
    expect(last().url).toBe("/api/permissions/chief_engineer%3Am1%3A7/respond");
    expect(last().init).toMatchObject({ method: "POST", body: JSON.stringify({ optionId: "allow-once" }) });
  });

  it("restarting an agent", async () => {
    const { api, last } = setup();
    await api.restartAgent("chief_engineer", "m1");
    expect(last().url).toBe("/api/agents/chief_engineer/restart");
    expect(last().init).toMatchObject({ method: "POST", body: JSON.stringify({ missionId: "m1" }) });
  });

  it("timeline range: builds the query from the given bounds", async () => {
    const { api, last } = setup();
    await api.getTimelineRange({ missionId: "m 1", afterId: "event-5", inclusive: true, beforeId: "turn-9", dir: "asc", limit: 20 });
    expect(last().url).toBe("/api/timeline/range?missionId=m+1&dir=asc&after=event-5&inclusive=1&before=turn-9&limit=20");
    await api.getTimelineRange({ missionId: "m1", afterId: "a", beforeId: "b", dir: "desc" });
    expect(last().url).toBe("/api/timeline/range?missionId=m1&dir=desc&after=a&before=b");
  });

  it("language: saved with PUT", async () => {
    const { api, last } = setup();
    await api.setLanguage("ja");
    expect(last().url).toBe("/api/config/language");
    expect(last().init).toMatchObject({ method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ language: "ja" }) });
  });

  it("crew language: saved with PUT to its own route", async () => {
    const { api, last } = setup();
    await api.setCrewLanguage("ja");
    expect(last().url).toBe("/api/config/crew-language");
    expect(last().init).toMatchObject({ method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ language: "ja" }) });
  });

  it("crew model: fetching, and changing/removing (PUT, null removes)", async () => {
    const { api, last } = setup();
    await api.getCrewModels("m 1");
    expect(last().url).toBe("/api/missions/m%201/crew-models");

    await api.setCrewModel("m1", "chief_engineer", "opus");
    expect(last().url).toBe("/api/missions/m1/crew-models/chief_engineer");
    expect(last().init).toMatchObject({ method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ model: "opus" }) });

    await api.setCrewModel("m1", "chief_engineer", null);
    expect(last().init).toMatchObject({ method: "PUT", body: JSON.stringify({ model: null }) });
  });

  it("creating and removing pins", async () => {
    const { api, last } = setup();
    const body = { messageId: "m 1", role: "captain", text: "t", timestamp: "ts", missionId: "bridge" };
    await api.createPin(body);
    expect(last().url).toBe("/api/pins");
    expect(last().init).toMatchObject({ method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

    await api.deletePin("m 1");
    expect(last().url).toBe("/api/pins/m%201");
    expect(last().init).toEqual({ method: "DELETE" });
  });
});

describe("connection target (baseUrl)", () => {
  it("if unspecified, a same-origin relative path", async () => {
    const { api, last } = setup();
    await api.getConfig();
    expect(last().url).toBe("/api/config");
    expect(api.eventsUrl()).toBe("/api/events/bridge");
  });

  it("if specified, the connection target of every API and SSE is that server", async () => {
    const { api, last } = setup("https://example.com:3939");
    await api.getConfig();
    expect(last().url).toBe("https://example.com:3939/api/config");
    await api.sendMessage("chief_engineer", "x", "m1");
    expect(last().url).toBe("https://example.com:3939/api/crew/chief_engineer/message");
    expect(api.eventsUrl()).toBe("https://example.com:3939/api/events/bridge");
  });
});

describe("push channel", () => {
  it("opens the SSE URL of the connection target with the browser's EventSource unless another channel is given", () => {
    const opened: string[] = [];
    class FakeEventSource { constructor(url: string) { opened.push(url); } }
    vi.stubGlobal("EventSource", FakeEventSource);
    try {
      createApi({ baseUrl: "https://example.com:3939" }).openEvents();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(opened).toEqual(["https://example.com:3939/api/events/bridge"]);
  });

  it("opens the channel a desktop shell supplies, with the same URL", () => {
    const stream = {} as EventStream;
    const openEventStream = vi.fn(() => stream);
    expect(createApi({ baseUrl: "https://example.com:3939", openEventStream }).openEvents()).toBe(stream);
    expect(openEventStream).toHaveBeenCalledWith("https://example.com:3939/api/events/bridge");
  });
});

describe("resolving fetch", () => {
  it("if no fetch is passed, the global fetch at the time of the call is used", async () => {
    const globalFetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", globalFetch);
    await createApi().getConfig();
    expect(globalFetch).toHaveBeenCalledWith("/api/config", { signal: undefined });
  });

  it("returns the Response as is (how to treat the status is left to the caller)", async () => {
    const api = createApi({ fetch: (async () => new Response('{"error":"nope"}', { status: 404 })) as unknown as typeof fetch });
    const res = await api.getTaskResult("x");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("nope");
  });
});
