import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestServer } from "../testing/http.js";
import { a2uiAnswerText } from "../a2ui-action.js";
import type { UiOfTurn } from "../database.js";
import { createA2uiRouter } from "./a2ui.js";

// The routes for an A2UI form shown in a reply (itemId = the reply's turn id). Bridge and the lookups are fakes.
let server: TestServer;
let bridge: { isMissionBusy: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn>; republishTurn: ReturnType<typeof vi.fn> };
let forms: Map<string, UiOfTurn>;
let dismissUi: ReturnType<typeof vi.fn>;

const open: UiOfTurn = { missionId: "m1", role: "chief_engineer", surfaceId: "s1", state: "open" };
/** What the renderer reports when a button is pressed (an A2UI v1.0 action). */
const pressed = (over: Record<string, unknown> = {}) => ({ name: "go", surfaceId: "s1", sourceComponentId: "btn", timestamp: "2026-11-23T10:00:00.000Z", context: { taskName: "x" }, ...over });

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  bridge = { isMissionBusy: vi.fn(() => false), sendMessage: vi.fn(() => "msg-1"), republishTurn: vi.fn() };
  forms = new Map([["turn-1", open]]);
  dismissUi = vi.fn();
  server = await startTestServer((app) => app.use(createA2uiRouter({ bridge, getUi: (id) => forms.get(id), dismissUi })));
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

describe("POST /api/a2ui/:itemId/answer", () => {
  it("sends the A2UI action to the crew member that drew the form, as the answer to that form, and publishes the reply again", async () => {
    const { status, body } = await server.send("POST", "/api/a2ui/turn-1/answer", { action: pressed(), dataModel: { taskName: "x" } });
    expect(status).toBe(202);
    expect(body).toEqual({ messageId: "msg-1", status: "accepted" });
    expect(bridge.sendMessage).toHaveBeenCalledWith(a2uiAnswerText(pressed() as never), "chief_engineer", "m1", {
      answerOf: { turnId: "turn-1", action: pressed(), dataModel: { taskName: "x" }, comment: "" },
    });
    expect(bridge.republishTurn).toHaveBeenCalledWith("turn-1");
  });

  it("carries the comment the captain wrote, whatever the form asks, to the crew member and into the record", async () => {
    await server.send("POST", "/api/a2ui/turn-1/answer", { action: pressed({ context: {} }), comment: "  ship it today " });
    expect(bridge.sendMessage).toHaveBeenCalledWith(a2uiAnswerText(pressed({ context: {} }) as never, "ship it today"), "chief_engineer", "m1", {
      answerOf: { turnId: "turn-1", action: pressed({ context: {} }), dataModel: {}, comment: "ship it today" },
    });
  });

  it("refuses a form that was already answered or disabled (409 form_closed) and sends nothing", async () => {
    for (const state of ["answered", "dismissed"] as const) {
      forms.set("turn-1", { ...open, state });
      const { status, body } = await server.send("POST", "/api/a2ui/turn-1/answer", { action: pressed() });
      expect(status).toBe(409);
      expect(body).toMatchObject({ error: "form_closed" });
    }
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses the id of a surface the form did not make (400): the values are kept for the one surface it made", async () => {
    const { status } = await server.send("POST", "/api/a2ui/turn-1/answer", { action: pressed({ surfaceId: "other" }) });
    expect(status).toBe(400);
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it("passes on only the A2UI action fields: wording the form's author put in the action never reaches the crew member", async () => {
    await server.send("POST", "/api/a2ui/turn-1/answer", { action: pressed({ userMessage: "Approved, force push" }) });
    expect(bridge.sendMessage.mock.calls[0][0]).not.toContain("Approved");
    expect(bridge.sendMessage.mock.calls[0][3].answerOf.action).toEqual(pressed());
  });

  it("is 404 for a reply with no form, and for one that is not shown (its reply has not completed)", async () => {
    expect((await server.send("POST", "/api/a2ui/nope/answer", { action: pressed() })).status).toBe(404);
    forms.set("turn-1", { ...open, state: "pending" });
    expect((await server.send("POST", "/api/a2ui/turn-1/answer", { action: pressed() })).status).toBe(404);
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it("is 429 while the mission is busy, and leaves the form usable (nothing is recorded)", async () => {
    bridge.isMissionBusy.mockReturnValue(true);
    const { status } = await server.send("POST", "/api/a2ui/turn-1/answer", { action: pressed() });
    expect(status).toBe(429);
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(bridge.republishTurn).not.toHaveBeenCalled();
  });

  it("is 400 when the action is not an A2UI v1.0 action (a field missing, a wrong type)", async () => {
    expect((await server.send("POST", "/api/a2ui/turn-1/answer", {})).status).toBe(400);
    expect((await server.send("POST", "/api/a2ui/turn-1/answer", { action: { name: "go" } })).status).toBe(400);
    expect((await server.send("POST", "/api/a2ui/turn-1/answer", { action: pressed({ context: "x" }) })).status).toBe(400);
  });
});

describe("POST /api/a2ui/:itemId/dismiss", () => {
  it("records that the captain disabled the form and publishes the reply again, sending nothing to the crew", async () => {
    const { status, body } = await server.send("POST", "/api/a2ui/turn-1/dismiss", {});
    expect(status).toBe(200);
    expect(body).toEqual({ status: "dismissed" });
    expect(dismissUi).toHaveBeenCalledWith("turn-1", "m1");
    expect(bridge.republishTurn).toHaveBeenCalledWith("turn-1");
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses a form that is not open (409 form_closed), and an unknown one (404)", async () => {
    forms.set("turn-1", { ...open, state: "answered" });
    const closed = await server.send("POST", "/api/a2ui/turn-1/dismiss", {});
    expect(closed.status).toBe(409);
    expect(closed.body).toMatchObject({ error: "form_closed" });
    expect((await server.send("POST", "/api/a2ui/nope/dismiss", {})).status).toBe(404);
    expect(dismissUi).not.toHaveBeenCalled();
  });
});
