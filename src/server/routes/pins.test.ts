import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, createMission, initDatabase } from "../database.js";
import { startTestServer, type TestServer } from "../testing/http.js";
import { createPinsRouter } from "./pins.js";

// Routes for pinning. Who can be a pinned speaker is decided by the ship's composition (it does not read config; it is received as an argument).
type PinJson = { messageId: string; role: string; text: string; timestamp: string; missionId: string; isFloating: boolean };
let server: TestServer;

const pin = (overrides: Record<string, unknown> = {}) => ({
  messageId: "msg-1",
  role: "captain",
  text: "Important message",
  timestamp: "2026-11-07T00:00:00.000Z",
  missionId: "bridge",
  ...overrides,
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  initDatabase({ path: ":memory:", agentToRole: (agent) => agent });
  createMission("m1", "Mission 1");
  server = await startTestServer((app) => app.use("/api/pins", createPinsRouter({ crewRoles: ["first_officer", "ensign"] })));
});
afterEach(async () => {
  await server.close();
  closeDatabase();
  vi.restoreAllMocks();
});

describe("POST /api/pins", () => {
  it("pinning gives 201 and returns the shape for the floating display", async () => {
    const { status, body } = await server.send("POST", "/api/pins", pin());
    expect(status).toBe(201);
    expect(body).toMatchObject({ messageId: "msg-1", role: "captain", text: "Important message", missionId: "bridge", isFloating: true });
    expect((body as PinJson & { pinnedAt: string }).pinnedAt).toBeTruthy();
  });

  it("messages of the captain and of roles in the ship's composition can be pinned", async () => {
    for (const [i, role] of ["captain", "first_officer", "ensign"].entries()) {
      expect((await server.send("POST", "/api/pins", pin({ messageId: `m${i}`, role }))).status).toBe(201);
    }
  });

  it("a role not in the composition is 400", async () => {
    const { status, body } = await server.send("POST", "/api/pins", pin({ role: "nobody" }));
    expect(status).toBe(400);
    expect(body).toEqual({ error: "role must be 'captain' or a valid crew role" });
  });

  it.each([
    ["messageId", "messageId is required"],
    ["text", "text is required"],
    ["timestamp", "timestamp is required"],
    ["missionId", "missionId is required"],
  ])("400 if %s is missing", async (field, message) => {
    const payload = pin();
    delete (payload as Record<string, unknown>)[field];
    const { status, body } = await server.send("POST", "/api/pins", payload);
    expect(status).toBe(400);
    expect(body).toEqual({ error: message });
  });

  it("a message that is already pinned is 409", async () => {
    await server.send("POST", "/api/pins", pin());
    const { status, body } = await server.send("POST", "/api/pins", pin());
    expect(status).toBe(409);
    expect(body).toEqual({ error: "Message is already pinned" });
  });
});

describe("POST /api/pins: the mission", () => {
  it("404 when the mission does not exist (a pin cannot point into nothing)", async () => {
    const { status } = await server.send("POST", "/api/pins", pin({ missionId: "no-such-mission" }));
    expect(status).toBe(404);
  });
});

describe("GET /api/pins", () => {
  it("returns the list of pins. Can be narrowed by missionId (all missions if omitted)", async () => {
    await server.send("POST", "/api/pins", pin({ messageId: "a", missionId: "bridge" }));
    await server.send("POST", "/api/pins", pin({ messageId: "b", missionId: "m1" }));

    const all = (await server.get("/api/pins")).body as PinJson[];
    expect(all.map((p) => p.messageId).sort()).toEqual(["a", "b"]);
    const m1 = (await server.get("/api/pins?missionId=m1")).body as PinJson[];
    expect(m1.map((p) => p.messageId)).toEqual(["b"]);
  });
});

describe("DELETE /api/pins/:messageId", () => {
  it("unpins. 404 if it does not exist", async () => {
    await server.send("POST", "/api/pins", pin());
    const ok = await server.send("DELETE", "/api/pins/msg-1");
    expect(ok.status).toBe(204);
    expect(((await server.get("/api/pins")).body as PinJson[])).toEqual([]);

    const none = await server.send("DELETE", "/api/pins/msg-1");
    expect(none.status).toBe(404);
    expect(none.body).toEqual({ error: "Pin not found" });
  });
});
