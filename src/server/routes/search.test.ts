import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestServer } from "../testing/http.js";
import { createSearchRouter, MAX_SEARCH_HITS } from "./search.js";
import type { SearchQuery, SearchRow } from "../database.js";

let server: TestServer;
let search: ReturnType<typeof vi.fn>;

const row = (over: Partial<SearchRow> = {}): SearchRow => ({
  seq: 1, occurred_at: "2026-11-14T06:00:00.000Z", mission_id: "m1", mission_name: "ログイン改修", kind: "reply",
  agent: "sam", text: "ログインの検証を追加しました", instruction: null, item_id: "t1", ...over,
});

beforeEach(async () => {
  search = vi.fn(() => ({ total: 0, rows: [] }));
  server = await startTestServer((app) => app.use(createSearchRouter({ search, agentToRole: (agent) => (agent === "sam" ? "chief_engineer" : agent) })));
});
afterEach(async () => {
  await server.close();
});

const lastQuery = (): SearchQuery => search.mock.calls.at(-1)![0];

describe("GET /api/search", () => {
  it("400 if there is no search term (empty or only whitespace)", async () => {
    expect((await server.get("/api/search")).status).toBe(400);
    expect((await server.get("/api/search?q=%20%20")).status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it("passes the search terms as AND terms split on whitespace. The default is all missions, all kinds, and an upper limit of 500", async () => {
    await server.get(`/api/search?q=${encodeURIComponent("ログイン　検証")}`);
    expect(lastQuery()).toEqual({
      terms: ["ログイン", "検証"], missionIds: null, from: undefined, to: undefined,
      includeCaptain: true, includeReplies: true, includeTasks: true, limit: MAX_SEARCH_HITS,
    });
  });

  it("uses the target missions, period, kinds to include, and count as the conditions as they are", async () => {
    const from = "2026-11-01T00:00:00.000Z";
    const to = "2026-11-15T00:00:00.000Z";
    await server.get(`/api/search?q=x&missions=m1,m2&from=${from}&to=${to}&captain=0&replies=1&tasks=false&limit=20`);
    expect(lastQuery()).toMatchObject({ missionIds: ["m1", "m2"], from, to, includeCaptain: false, includeReplies: true, includeTasks: false, limit: 20 });
    await server.get("/api/search?q=x&limit=99999");
    expect(lastQuery().limit).toBe(MAX_SEARCH_HITS);
  });

  it("400 if the period is not in ISO format", async () => {
    expect((await server.get("/api/search?q=x&from=yesterday")).status).toBe(400);
    expect((await server.get("/api/search?q=x&to=nope")).status).toBe(400);
  });

  it("the result carries the jump target id, mission name, role, time, and excerpt (with the matched ranges). The role of the captain's messages is captain", async () => {
    search.mockReturnValue({
      total: 2,
      rows: [row({ kind: "captain", agent: null, text: "ログインを直して", item_id: "event-7" }), row()],
    });
    const { body } = await server.get("/api/search?q=ログイン");
    const result = body as { total: number; truncated: boolean; hits: Array<Record<string, unknown>> };
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.hits[0]).toMatchObject({ id: "event-7", role: "captain", kind: "captain", missionId: "m1", missionName: "ログイン改修", matchedIn: null });
    expect(result.hits[1]).toMatchObject({ id: "t1", role: "chief_engineer", kind: "reply", timestamp: "2026-11-14T06:00:00.000Z" });
    expect(result.hits[1].snippet).toMatchObject({ text: "ログインの検証を追加しました", ranges: [[0, 4]] });
  });

  it("for a task, if the report has no term, the excerpt is built from the instruction, and it shows which one matched", async () => {
    search.mockReturnValue({
      total: 2,
      rows: [
        row({ kind: "task", text: "異常はありません", instruction: "入力の検証を見て", item_id: "a_1" }),
        row({ kind: "task", text: "検証の報告です", instruction: "別の依頼", item_id: "a_2" }),
      ],
    });
    const { body } = await server.get("/api/search?q=検証");
    const hits = (body as { hits: Array<{ matchedIn: string; snippet: { text: string } }> }).hits;
    expect(hits[0]).toMatchObject({ matchedIn: "instruction" });
    expect(hits[0].snippet.text).toBe("入力の検証を見て");
    expect(hits[1]).toMatchObject({ matchedIn: "report" });
  });

  it("if the total is larger than the number returned, truncated tells it. If there is no mission name, the ID is used instead", async () => {
    search.mockReturnValue({ total: 900, rows: [row({ mission_name: null })] });
    const { body } = await server.get("/api/search?q=x");
    expect(body).toMatchObject({ total: 900, truncated: true });
    expect((body as { hits: Array<{ missionName: string }> }).hits[0].missionName).toBe("m1");
  });
});
