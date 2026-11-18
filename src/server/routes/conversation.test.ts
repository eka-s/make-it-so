import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, createMission, initDatabase } from "../database.js";
import type { AccountsSnapshot } from "../types.js";
import { startTestServer, type TestServer } from "../testing/http.js";
import { createConversationRouter, type ConversationRouterDeps } from "./conversation.js";

// Routes of the conversation entry point. Bridge is a fake (only how it is called is verified), and checking that a mission exists uses an in-memory DB.
let server: TestServer;
let bridge: {
  isMissionBusy: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendReport: ReturnType<typeof vi.fn>;
  cancelMessage: ReturnType<typeof vi.fn>;
};
let broadcast: ReturnType<typeof vi.fn>;
let fetchCredits: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  initDatabase({ path: ":memory:", agentToRole: (agent) => agent });
  createMission("m1", "Test");
  bridge = {
    isMissionBusy: vi.fn(() => false),
    sendMessage: vi.fn(() => "msg-1"),
    sendReport: vi.fn(() => ({ messageId: "report-1" })),
    cancelMessage: vi.fn(() => true),
  };
  broadcast = vi.fn();
  fetchCredits = vi.fn(async () => null);
  const deps: ConversationRouterDeps = {
    crew: { first_officer: {}, chief_engineer: {} },
    bridge,
    fetchCredits,
    broadcast,
  };
  server = await startTestServer((app) => app.use(createConversationRouter(deps)));
});
afterEach(async () => {
  await server.close();
  closeDatabase();
  vi.restoreAllMocks();
});

describe("POST /api/crew/:role/message", () => {
  it("accepts a message addressed to that crew member (202) and sends it. Every role has the same entry point (even one named first_officer is not special-cased)", async () => {
    const { status, body } = await server.send("POST", "/api/crew/chief_engineer/message", { text: "please do it", missionId: "m1" });
    expect(status).toBe(202);
    expect(body).toEqual({ messageId: "msg-1", status: "accepted" });
    expect(bridge.sendMessage).toHaveBeenCalledWith("please do it", "chief_engineer", "m1");

    await server.send("POST", "/api/crew/first_officer/message", { text: "hello" });
    expect(bridge.sendMessage).toHaveBeenLastCalledWith("hello", "first_officer", "bridge");
  });

  it("a nonexistent role is 404", async () => {
    const { status, body } = await server.send("POST", "/api/crew/nobody/message", { text: "x" });
    expect(status).toBe(404);
    expect(body).toEqual({ error: "Unknown crew role" });
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it("the old entry point (/api/bridge/message) no longer exists", async () => {
    const res = await fetch(`${server.baseUrl}/api/bridge/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(404);
  });

  it.each([
    ["text is missing", {}],
    ["text is empty", { text: "" }],
    ["text is not a string", { text: 42 }],
  ])("400 when %s", async (_label, payload) => {
    const { status, body } = await server.send("POST", "/api/crew/chief_engineer/message", payload);
    expect(status).toBe(400);
    expect(body).toEqual({ error: "text is required" });
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it("a nonexistent mission is 404", async () => {
    const { status, body } = await server.send("POST", "/api/crew/chief_engineer/message", { text: "x", missionId: "nope" });
    expect(status).toBe(404);
    expect(body).toEqual({ error: "Unknown mission" });
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it("if that mission is busy, 429 (nothing is sent). Another mission is accepted", async () => {
    bridge.isMissionBusy.mockImplementation((missionId: string) => missionId === "m1");
    const busy = await server.send("POST", "/api/crew/chief_engineer/message", { text: "x", missionId: "m1" });
    expect(busy.status).toBe(429);
    expect(busy.body).toEqual({ error: "This mission is busy processing a previous message" });
    expect(bridge.sendMessage).not.toHaveBeenCalled();

    const other = await server.send("POST", "/api/crew/chief_engineer/message", { text: "x" });
    expect(other.status).toBe(202);
  });

  it("if sending throws an exception, 500 and that message is returned", async () => {
    bridge.sendMessage.mockImplementation(() => {
      throw new Error("boom");
    });
    const failed = await server.send("POST", "/api/crew/chief_engineer/message", { text: "x" });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "boom" });
  });
});

describe("POST /api/crew/:role/report", () => {
  it("sends report to that crew member (202). The destination is the crew member in the URL", async () => {
    const { status, body } = await server.send("POST", "/api/crew/chief_engineer/report", { missionId: "m1" });
    expect(status).toBe(202);
    expect(body).toEqual({ messageId: "report-1", status: "accepted" });
    expect(bridge.sendReport).toHaveBeenCalledWith("chief_engineer", "m1");
  });

  it("a nonexistent role is 404. If no mission is specified, the default mission. A nonexistent mission is 404, busy is 429, an exception is 500", async () => {
    expect((await server.send("POST", "/api/crew/nobody/report", {})).status).toBe(404);

    await server.send("POST", "/api/crew/first_officer/report", {});
    expect(bridge.sendReport).toHaveBeenCalledWith("first_officer", "bridge");

    expect((await server.send("POST", "/api/crew/first_officer/report", { missionId: "nope" })).status).toBe(404);

    bridge.isMissionBusy.mockReturnValue(true);
    expect((await server.send("POST", "/api/crew/first_officer/report", {})).status).toBe(429);

    bridge.isMissionBusy.mockReturnValue(false);
    bridge.sendReport.mockImplementation(() => {
      throw new Error("boom");
    });
    expect((await server.send("POST", "/api/crew/first_officer/report", {})).status).toBe(500);
  });
});

describe("POST /api/bridge/cancel", () => {
  it("if there is a turn in progress, sends a cancel (200)", async () => {
    const { status, body } = await server.send("POST", "/api/bridge/cancel", { missionId: "m1" });
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok", message: "Cancel sent" });
    expect(bridge.cancelMessage).toHaveBeenCalledWith("m1");
  });

  it("409 if there is nothing to cancel. A nonexistent mission is 404", async () => {
    bridge.cancelMessage.mockReturnValue(false);
    const none = await server.send("POST", "/api/bridge/cancel", {});
    expect(none.status).toBe(409);
    expect(none.body).toEqual({ error: "No active message to cancel" });

    expect((await server.send("POST", "/api/bridge/cancel", { missionId: "nope" })).status).toBe(404);
  });
});

describe("re-fetching the credit usage", () => {
  const credits: AccountsSnapshot = { accounts: [], untracked: ["Data"] };

  it("refresh-credits: re-fetches the per-account list, broadcasts it over SSE, and returns it", async () => {
    fetchCredits.mockResolvedValueOnce(credits);
    const ok = await server.send("POST", "/api/bridge/refresh-credits");
    expect(ok.body).toEqual({ status: "ok", data: credits });
    expect(broadcast).toHaveBeenCalledWith({ type: "credits:usage", data: credits });
  });

  it("500 if fetching throws an exception", async () => {
    fetchCredits.mockRejectedValueOnce(new Error("network"));
    expect((await server.send("POST", "/api/bridge/refresh-credits")).status).toBe(500);
  });
});
