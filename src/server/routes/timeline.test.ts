import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MISSION_ID,
  closeDatabase,
  createMission,
  initDatabase,
  recordCaptainMessage,
} from "../database.js";
import { configureTimeline, forget, upsert } from "../timeline.js";
import type { TimelineItem } from "../types.js";
import { startTestServer, type TestServer } from "../testing/http.js";
import { createTimelineRouter } from "./timeline.js";

type Snapshot = { items: TimelineItem[]; hasMore: boolean };

let server: TestServer;
const liveIds: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  initDatabase({ path: ":memory:", agentToRole: (agent) => agent });
  createMission("m1", "Test");
  configureTimeline({ readTaskText: async () => "", readTurnText: async () => "" });
  server = await startTestServer((app) => app.use(createTimelineRouter()));
});
afterEach(async () => {
  await server.close();
  for (const id of liveIds.splice(0)) forget(id);
  closeDatabase();
  vi.restoreAllMocks();
});

describe("GET /api/timeline: the form waiting for the captain", () => {
  it("says which reply holds the form the captain has neither answered nor closed (null if none), whatever items were loaded", async () => {
    const withUi = await startTestServer((app) => app.use(createTimelineRouter({ openUiItemId: (missionId) => (missionId === "m1" ? "turn-7" : null) })));
    try {
      expect(((await withUi.get("/api/timeline?missionId=m1")).body as { openUiItemId: string | null }).openUiItemId).toBe("turn-7");
      expect(((await withUi.get("/api/timeline?missionId=bridge")).body as { openUiItemId: string | null }).openUiItemId).toBeNull();
      expect(((await server.get("/api/timeline")).body as { openUiItemId: string | null }).openUiItemId).toBeNull(); // no way to look: none
    } finally {
      await withUi.close();
    }
  });
});

describe("GET /api/timeline", () => {
  it("if no mission is specified, returns the history of the default mission", async () => {
    recordCaptainMessage("default message", DEFAULT_MISSION_ID);
    recordCaptainMessage("m1 message", "m1");
    const body = (await server.get("/api/timeline")).body as Snapshot;
    expect(body.items.map((i) => i.text)).toEqual(["default message"]);
  });

  it("narrowed by missionId", async () => {
    recordCaptainMessage("default message", DEFAULT_MISSION_ID);
    recordCaptainMessage("m1 message", "m1");
    const body = (await server.get("/api/timeline?missionId=m1")).body as Snapshot;
    expect(body.items.map((i) => i.text)).toEqual(["m1 message"]);
  });

  it("narrowing the count with limit returns from the newest, and hasMore is set", async () => {
    for (const text of ["1", "2", "3"]) {
      recordCaptainMessage(text, DEFAULT_MISSION_ID);
      await sleep(3);
    }
    const body = (await server.get("/api/timeline?limit=2")).body as Snapshot;
    expect(body.items.map((i) => i.text)).toEqual(["2", "3"]);
    expect(body.hasMore).toBe(true);
  });

  it("in-progress (live) items are also included, only those of the same mission", async () => {
    const live = (id: string, missionId: string): void => {
      liveIds.push(id);
      upsert({ id, missionId, role: "first_officer", text: `live-${id}`, timestamp: new Date().toISOString(), status: "streaming" });
    };
    live("turn-bridge", DEFAULT_MISSION_ID);
    live("turn-m1", "m1");
    const body = (await server.get("/api/timeline?missionId=m1")).body as Snapshot;
    expect(body.items.map((i) => i.id)).toEqual(["turn-m1"]);
  });

  it("returns 500 if fetching fails (the exception is not swallowed)", async () => {
    closeDatabase(); // make a state where the database is unusable
    const { status, body } = await server.get("/api/timeline");
    expect(status).toBe(500);
    expect(body).toEqual({ error: "Failed to retrieve timeline" });
  });
});

describe("GET /api/timeline/older", () => {
  it("400 if there is no before", async () => {
    const { status, body } = await server.get("/api/timeline/older");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "before is required" });
  });

  it("returns only persisted history before `before` (in-progress items are not included)", async () => {
    for (const text of ["1", "2", "3"]) {
      recordCaptainMessage(text, DEFAULT_MISSION_ID);
      await sleep(3);
    }
    liveIds.push("turn-x");
    upsert({ id: "turn-x", missionId: DEFAULT_MISSION_ID, role: "first_officer", text: "live", timestamp: "2000-01-01T00:00:00.000Z", status: "streaming" });

    const newest = ((await server.get("/api/timeline?limit=1")).body as Snapshot).items.find((i) => i.text === "3")!;
    const body = (await server.get(`/api/timeline/older?before=${encodeURIComponent(newest.id)}`)).body as Snapshot;
    expect(body.items.map((i) => i.text)).toEqual(["1", "2"]);
    expect(body.hasMore).toBe(false);
  });

  it("404 when `before` is not an item of this mission's persisted history", async () => {
    const { status, body } = await server.get("/api/timeline/older?before=turn-none");
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: "not found", id: "turn-none" });
  });

  it("a malformed limit is not a server error (the default page is used)", async () => {
    recordCaptainMessage("a", DEFAULT_MISSION_ID);
    expect((await server.get("/api/timeline?limit=abc")).status).toBe(200);
    expect((await server.get("/api/timeline?limit=-1")).status).toBe(200);
  });

  it("can be narrowed by missionId", async () => {
    recordCaptainMessage("default", DEFAULT_MISSION_ID);
    await sleep(3);
    const first = recordCaptainMessage("m1 first", "m1");
    await sleep(3);
    const second = recordCaptainMessage("m1 second", "m1");
    const body = (await server.get(`/api/timeline/older?missionId=m1&before=${encodeURIComponent(second.id)}`)).body as Snapshot;
    expect(body.items.map((i) => i.id)).toEqual([first.id]);
  });
});

describe("GET /api/timeline/range", () => {
  type Range = { items: TimelineItem[]; complete: boolean };

  async function seed(): Promise<string[]> {
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      ids.push(recordCaptainMessage(`msg ${n}`, "m1").id);
      await sleep(3);
    }
    return ids;
  }

  it("returns the items right after an item, with complete=false when more are left in the range", async () => {
    const ids = await seed();
    const { status, body } = await server.get(`/api/timeline/range?missionId=m1&after=${ids[0]}&before=${ids[3]}&dir=asc&limit=1`);
    expect(status).toBe(200);
    const r = body as Range;
    expect(r.items.map((i) => i.text)).toEqual(["msg 2"]);
    expect(r.complete).toBe(false);
  });

  it("inclusive=1 starts at the item itself; dir=desc takes the newest end of the range", async () => {
    const ids = await seed();
    const asc = (await server.get(`/api/timeline/range?missionId=m1&after=${ids[1]}&inclusive=1&before=${ids[3]}&limit=5`)).body as Range;
    expect(asc.items.map((i) => i.text)).toEqual(["msg 2", "msg 3"]);
    expect(asc.complete).toBe(true);
    const desc = (await server.get(`/api/timeline/range?missionId=m1&after=${ids[0]}&before=${ids[3]}&dir=desc&limit=1`)).body as Range;
    expect(desc.items.map((i) => i.text)).toEqual(["msg 3"]);
  });

  it("rejects a request with no bound (400) and an unknown item (404)", async () => {
    const ids = await seed();
    expect((await server.get("/api/timeline/range?missionId=m1")).status).toBe(400);
    const missing = await server.get(`/api/timeline/range?missionId=m1&after=${ids[0]}&before=event-99999`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: "item_not_found" });
  });

  it("does not see items of another mission (404)", async () => {
    const ids = await seed();
    expect((await server.get(`/api/timeline/range?missionId=${DEFAULT_MISSION_ID}&after=${ids[0]}`)).status).toBe(404);
  });
});

describe("GET /api/timeline/captain-history", () => {
  it("lists the captain's messages newest first, once each, without the fixed ones, up to 20", async () => {
    const fixedServer = await startTestServer((app) => app.use(createTimelineRouter({ fixedMessages: () => ["report", "/resume"] })));
    try {
      for (let i = 1; i <= 25; i++) recordCaptainMessage(`message ${i}`, "m1");
      recordCaptainMessage("Report", "m1");
      recordCaptainMessage("/resume", "m1");
      recordCaptainMessage("message 3", "m1");
      recordCaptainMessage("other mission", "bridge");
      const { status, body } = await fixedServer.get("/api/timeline/captain-history?missionId=m1");
      expect(status).toBe(200);
      const items = (body as { items: { text: string; id: string }[] }).items;
      expect(items).toHaveLength(20);
      expect(items[0].text).toBe("message 3");
      expect(items[1].text).toBe("message 25");
      expect(items.map((i) => i.text)).not.toContain("Report");
      expect(items.map((i) => i.text)).not.toContain("/resume");
      expect(items.filter((i) => i.text === "message 3")).toHaveLength(1);
      expect(items[0].id).toMatch(/^event-\d+$/);
    } finally {
      await fixedServer.close();
    }
  });

  it("is empty for a mission with no messages", async () => {
    const { body } = await server.get("/api/timeline/captain-history?missionId=m1");
    expect(body).toEqual({ items: [] });
  });
});
