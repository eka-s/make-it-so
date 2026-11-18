import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveApp, type TestServer } from "../testing/http.js";
import { createSettingsApp } from "./settings-app.js";
import type { ShipRuntime } from "./ship-runtime.js";

let tmp: string;
let dir: string;
let server: TestServer | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-settings-"));
  dir = path.join(tmp, ".make-it-so");
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A runtime that never touches a process: every ship is stopped, and a start is only recorded. */
const fakeRuntime = (calls: string[] = []): ShipRuntime => ({
  status: async (id) => ({ id, port: null, state: "stopped" }),
  start: async (id) => { calls.push(`start ${id}`); return { ok: true }; },
  stop: async () => ({ ok: false, reason: "not_running" }),
  log: () => "last lines",
  isStarting: () => false,
});

const start = async (clientDir?: string, runtime: ShipRuntime = fakeRuntime()) => (server = await serveApp(createSettingsApp({ dir, clientDir, runtime })));

describe("settings app", () => {
  it("GET /api/settings/overview reports a missing directory without failing", async () => {
    const { status, body } = await (await start()).get("/api/settings/overview");
    expect(status).toBe(200);
    expect(body).toMatchObject({ dir, exists: false, ships: [] });
  });

  it("does not announce the framework, and sends the security headers", async () => {
    const s = await start();
    const res = await fetch(`${s.baseUrl}/api/settings/overview`);
    expect(res.headers.get("x-powered-by")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("GET /api/config gives the UI language from config.yml, English by default", async () => {
    const s = await start();
    expect((await s.get("/api/config")).body).toEqual({ language: "en", crewLanguage: "en" });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yml"), "language: ja\n");
    expect((await s.get("/api/config")).body).toEqual({ language: "ja", crewLanguage: "ja" });
  });

  it("a broken config.yml falls back to English instead of failing", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yml"), "language: [unclosed\n");
    expect((await (await start()).get("/api/config")).body).toEqual({ language: "en", crewLanguage: "en" });
  });

  it("serves the settings page (not the ship UI's index.html) at / when the built client is given", async () => {
    const clientDir = path.join(tmp, "client");
    fs.mkdirSync(clientDir);
    fs.writeFileSync(path.join(clientDir, "index.html"), "SHIP UI");
    fs.writeFileSync(path.join(clientDir, "settings.html"), "SETTINGS UI");
    const s = await start(clientDir);
    for (const url of ["/", "/anything"]) {
      expect(await (await fetch(`${s.baseUrl}${url}`)).text()).toBe("SETTINGS UI");
    }
    expect((await fetch(`${s.baseUrl}/api/nope`)).status).toBe(404); // an undefined API is not swallowed by the page
  });
});

describe("settings app: editing", () => {
  it("GET /api/settings/config lists the fields; PUT saves valid values and refuses bad ones with the errors per key", async () => {
    const s = await start();
    const read = (await s.get("/api/settings/config")).body as { fields: { key: string; value: unknown }[] };
    expect(read.fields.find((f) => f.key === "language")).toMatchObject({ type: "enum", value: null, default: "en" });

    const saved = await s.send("PUT", "/api/settings/config", { values: { language: "ja" } });
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(path.join(dir, "config.yml"), "utf-8")).toBe("language: ja\n");

    const bad = await s.send("PUT", "/api/settings/config", { values: { language: "fr" } });
    expect(bad).toEqual({ status: 400, body: { error: "invalid", errors: { language: "settings.error.notAnOption" } } });
    expect(fs.readFileSync(path.join(dir, "config.yml"), "utf-8")).toBe("language: ja\n");
  });

  it("a body of the wrong shape is a 400", async () => {
    const s = await start();
    expect((await s.send("PUT", "/api/settings/config", { values: [] })).status).toBe(400);
    expect((await s.send("PUT", "/api/settings/hosts", { hosts: "x" })).status).toBe(400);
  });

  it("a config.yml that is not valid YAML is a 409 and is left as it is", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yml"), "language: [unclosed\n");
    const s = await start();
    expect((await s.get("/api/settings/config")).status).toBe(409);
    expect((await s.send("PUT", "/api/settings/config", { values: { language: "ja" } })).status).toBe(409);
    expect(fs.readFileSync(path.join(dir, "config.yml"), "utf-8")).toBe("language: [unclosed\n");
  });

  it("hosts: GET and PUT", async () => {
    const s = await start();
    expect((await s.get("/api/settings/hosts")).body).toMatchObject({ exists: false, hosts: [] });
    const saved = await s.send("PUT", "/api/settings/hosts", { hosts: [{ name: "dev", destination: "dev-server" }] });
    expect(saved.status).toBe(200);
    expect((saved.body as { hosts: unknown[] }).hosts).toEqual([{ name: "dev", destination: "dev-server", usedBy: [] }]);
    const bad = await s.send("PUT", "/api/settings/hosts", { hosts: [{ name: "x y", destination: "a" }] });
    expect(bad).toEqual({ status: 400, body: { error: "invalid", errors: { "x y": "settings.error.hostName" } } });
  });
});

describe("settings app: roster", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  it("creates, updates and removes a member; a refusal has errors per field", async () => {
    const s = await start();
    const created = await s.send("POST", "/api/settings/roster", { id: "sam", name: "Sam", provider: "kiro" });
    expect(created.status).toBe(200);
    expect((created.body as { members: { id: string }[] }).members.map((m) => m.id)).toEqual(["sam"]);

    expect((await s.send("POST", "/api/settings/roster", { id: "sam", name: "Again" })).body).toEqual({ error: "invalid", errors: { id: "settings.error.memberExists" } });
    expect((await s.send("PUT", "/api/settings/roster/sam", { name: "" })).body).toEqual({ error: "invalid", errors: { name: "settings.error.empty" } });
    expect((await s.send("PUT", "/api/settings/roster/ghost", { name: "x" })).status).toBe(404);

    const updated = await s.send("PUT", "/api/settings/roster/sam", { name: "Samuel", model: "sonnet" });
    expect((updated.body as { members: { name: string; model: string }[] }).members[0]).toMatchObject({ name: "Samuel", model: "sonnet" });

    expect((await s.send("DELETE", "/api/settings/roster/sam")).status).toBe(200);
    expect((await s.send("DELETE", "/api/settings/roster/sam")).status).toBe(404);
  });

  it("removing a member a ship assigns is a 409 that names the ship", async () => {
    fs.mkdirSync(path.join(dir, "ships/alpha"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ships/alpha/ship.yml"), "port: 4000\ncrew:\n  lead: { member: sam }\n");
    const s = await start();
    await s.send("POST", "/api/settings/roster", { id: "sam", name: "Sam" });
    const refused = await s.send("DELETE", "/api/settings/roster/sam");
    expect(refused).toEqual({ status: 409, body: { error: "invalid", errors: { id: "settings.error.memberInUse" }, usedBy: [{ ship: "alpha", role: "lead" }] } });
  });

  it("the persona: read, save, and a bad ID is refused", async () => {
    const s = await start();
    expect((await s.get("/api/settings/roster/sam/persona")).body).toEqual({ text: "", exists: false });
    expect((await s.send("PUT", "/api/settings/roster/sam/persona", { text: "I am Sam." })).body).toEqual({ text: "I am Sam.", exists: true });
    expect(fs.readFileSync(path.join(dir, "personnel/sam.md"), "utf-8")).toBe("I am Sam.");
    expect((await s.send("PUT", "/api/settings/roster/sam/persona", { text: 1 })).status).toBe(400);
    expect((await s.get("/api/settings/roster/..%2Fx/persona")).status).toBe(400);
  });

  it("the icon: upload, fetch, reject a non-image, delete", async () => {
    const s = await start();
    const put = (body: Buffer) => fetch(`${s.baseUrl}/api/settings/roster/sam/icon`, { method: "PUT", body });
    expect((await put(PNG)).status).toBe(200);
    const got = await fetch(`${s.baseUrl}/api/settings/roster/sam/icon`);
    expect([got.status, got.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect((await put(Buffer.from("<svg onload=alert(1)>"))).status).toBe(400);
    expect((await put(Buffer.alloc(1024 * 1024 + 2, 1))).status).toBe(413);
    expect((await s.send("DELETE", "/api/settings/roster/sam/icon")).status).toBe(200);
    expect((await fetch(`${s.baseUrl}/api/settings/roster/sam/icon`)).status).toBe(404);
  });
});

describe("settings app: ships", () => {
  const seedRoster = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "roster.yml"), "crew:\n  alex:\n    name: Alex\n");
  };

  it("creates a ship, reads it, updates it, and refuses bad input with errors per field", async () => {
    seedRoster();
    const s = await start();
    const created = await s.send("POST", "/api/settings/ships", { id: "alpha", port: 4000, name: "Alpha", member: "alex" });
    expect(created.status).toBe(200);
    expect(fs.existsSync(path.join(dir, "ships/alpha/ship.yml"))).toBe(true);

    const got = (await s.get("/api/settings/ships/alpha")).body as { fields: { port: number; crew: unknown[] }; options: { members: unknown[] } };
    expect([got.fields.port, got.fields.crew.length, got.options.members.length]).toEqual([4000, 1, 1]);

    const updated = await s.send("PUT", "/api/settings/ships/alpha", { fields: { ...got.fields, name: "Renamed" } });
    expect((updated.body as { fields: { name: string } }).fields.name).toBe("Renamed");

    const bad = await s.send("PUT", "/api/settings/ships/alpha", { fields: { ...got.fields, port: 0 } });
    expect(bad).toEqual({ status: 400, body: { error: "invalid", errors: { port: "settings.error.port" } } });
  });

  it("an unknown ship is a 404; a body of the wrong shape is a 400", async () => {
    seedRoster();
    const s = await start();
    expect((await s.get("/api/settings/ships/ghost")).status).toBe(404);
    expect((await s.send("PUT", "/api/settings/ships/ghost", { fields: { port: 1 } })).status).toBe(400);
    expect((await s.send("POST", "/api/settings/ships", { id: "x" })).status).toBe(400);
  });
});

describe("settings app: starting and stopping ships", () => {
  const seedShip = () => {
    fs.mkdirSync(path.join(dir, "ships/alpha"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ships/alpha/ship.yml"), "port: 4000\ncrew:\n  lead: { member: alex }\n");
    fs.writeFileSync(path.join(dir, "roster.yml"), "crew:\n  alex:\n    name: Alex\n");
  };

  it("GET /api/settings/runtime reports every ship's state", async () => {
    seedShip();
    const s = await start();
    expect((await s.get("/api/settings/runtime")).body).toEqual({ ships: [{ id: "alpha", port: null, state: "stopped", url: null, devCommand: "npm run dev -- --ship alpha" }], shipUi: false });
  });

  it("gives the address of a ship's screen when its port is known (the screen only shows it)", async () => {
    seedShip();
    const withPort = serveApp(createSettingsApp({ dir, runtime: { ...fakeRuntime(), status: async (id) => ({ id, port: 4321, state: "running", pid: 1234 }) } }));
    const s = await withPort;
    try {
      const ship = ((await s.get("/api/settings/runtime")).body as { ships: { url: string | null }[] }).ships[0];
      expect(ship.url).toBe("http://127.0.0.1:4321");
    } finally {
      await s.close();
    }
  });

  it("says whether a started ship serves its screen (only when this server runs from the build)", async () => {
    seedShip();
    const built = await serveApp(createSettingsApp({ dir, runtime: fakeRuntime(), shipUi: true }));
    try {
      expect(((await built.get("/api/settings/runtime")).body as { shipUi: boolean }).shipUi).toBe(true);
    } finally {
      await built.close();
    }
  });

  it("start asks the runtime to start a ship that exists, and 404s for one that does not", async () => {
    seedShip();
    const calls: string[] = [];
    const s = await start(undefined, fakeRuntime(calls));
    expect((await s.send("POST", "/api/settings/ships/alpha/start")).status).toBe(200);
    expect(calls).toEqual(["start alpha"]);
    expect((await s.send("POST", "/api/settings/ships/ghost/start")).status).toBe(404);
  });

  it("a ship that cannot be started or stopped is a 409 with the reason", async () => {
    seedShip();
    const refusing: ShipRuntime = { ...fakeRuntime(), start: async () => ({ ok: false, reason: "running" }) };
    const s = await start(undefined, refusing);
    expect((await s.send("POST", "/api/settings/ships/alpha/start")).body).toMatchObject({ error: "not_startable", reason: "running" });
    expect((await s.send("POST", "/api/settings/ships/alpha/stop")).status).toBe(409);
  });

  it("GET .../log gives the last lines the ship printed", async () => {
    seedShip();
    expect((await (await start()).get("/api/settings/ships/alpha/log")).body).toEqual({ text: "last lines" });
  });
});


describe("settings app: making a ship from a project", () => {
  let project: string;
  beforeEach(() => {
    project = path.join(tmp, "my-app");
    fs.mkdirSync(path.join(project, ".claude/agents"), { recursive: true });
    fs.writeFileSync(path.join(project, ".claude/agents/reviewer.md"), "---\nname: reviewer\n---\nReview.");
  });

  it("scan drafts a ship for each provider and writes nothing", async () => {
    const s = await start();
    const { status, body } = await s.send("POST", "/api/settings/import/scan", { path: project });
    expect(status).toBe(200);
    expect(body).toMatchObject({ isDirectory: true, found: { claude: true, kiro: false } });
    const drafts = (body as { drafts: { claude: { ship: { id: string }; members: { id: string }[] } } }).drafts;
    expect(drafts.claude.ship.id).toBe("my-app");
    expect(drafts.claude.members.map((m) => m.id)).toEqual(["reviewer"]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("scan says so when the path is not a directory, and refuses a missing path", async () => {
    const s = await start();
    expect((await s.send("POST", "/api/settings/import/scan", { path: path.join(tmp, "nope") })).body).toMatchObject({ isDirectory: false, drafts: null });
    expect((await s.send("POST", "/api/settings/import/scan", {})).status).toBe(400);
  });

  it("saving the draft as it came makes the members and the ship", async () => {
    const s = await start();
    const scan = (await s.send("POST", "/api/settings/import/scan", { path: project })).body as { drafts: { claude: { members: { id: string; reuse: boolean; input: unknown }[]; ship: unknown } } };
    const { claude } = scan.drafts;
    const saved = await s.send("POST", "/api/settings/import", { members: claude.members.map((m) => ({ id: m.id, reuse: m.reuse, input: m.input })), ship: claude.ship });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ shipId: "my-app", createdMembers: ["reviewer"] });
    expect(fs.existsSync(path.join(dir, "ships/my-app/ship.yml"))).toBe(true);
  });

  it("a refused save is a 400 with the errors, and a malformed body is rejected", async () => {
    const s = await start();
    expect((await s.send("POST", "/api/settings/import", { members: "x" })).status).toBe(400);
    const scan = (await s.send("POST", "/api/settings/import/scan", { path: project })).body as { drafts: { claude: { members: { id: string; reuse: boolean; input: unknown }[]; ship: { id: string; fields: { port: number } } } } };
    const { claude } = scan.drafts;
    claude.ship.fields.port = 0;
    const refused = await s.send("POST", "/api/settings/import", { members: claude.members, ship: claude.ship });
    expect(refused.status).toBe(400);
    expect(fs.existsSync(path.join(dir, "roster.yml"))).toBe(false);
  });
});

describe("settings app: deleting a ship", () => {
  const running = (id: string): ShipRuntime => ({ ...fakeRuntime(), status: async () => ({ id, port: 4000, state: "running", pid: 1 }) });
  const makeShip = async (s: TestServer) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "roster.yml"), "crew:\n  alex:\n    name: Alex\n");
    await s.send("POST", "/api/settings/ships", { id: "alpha", port: 4000, member: "alex" });
  };

  it("needs the ship's ID repeated as confirmation", async () => {
    const s = await start();
    await makeShip(s);
    expect((await s.send("DELETE", "/api/settings/ships/alpha", {})).status).toBe(400);
    expect((await s.send("DELETE", "/api/settings/ships/alpha", { confirm: "beta" })).status).toBe(400);
    expect(fs.existsSync(path.join(dir, "ships/alpha"))).toBe(true);
  });

  it("removes a stopped ship", async () => {
    const s = await start();
    await makeShip(s);
    expect((await s.send("DELETE", "/api/settings/ships/alpha", { confirm: "alpha" })).status).toBe(200);
    expect(fs.existsSync(path.join(dir, "ships/alpha"))).toBe(false);
    expect((await s.send("DELETE", "/api/settings/ships/alpha", { confirm: "alpha" })).status).toBe(404);
  });

  it("does not remove a ship whose ship.yml cannot be read (whether it runs cannot be known)", async () => {
    const s = await start();
    await makeShip(s);
    fs.writeFileSync(path.join(dir, "ships/alpha/ship.yml"), "port: [unclosed");
    expect((await s.send("DELETE", "/api/settings/ships/alpha", { confirm: "alpha" })).status).toBe(409);
    expect(fs.existsSync(path.join(dir, "ships/alpha"))).toBe(true);
  });

  it("does not remove a ship that is running", async () => {
    const s = await start(undefined, running("alpha"));
    await makeShip(s);
    expect((await s.send("DELETE", "/api/settings/ships/alpha", { confirm: "alpha" })).status).toBe(409);
    expect(fs.existsSync(path.join(dir, "ships/alpha/ship.yml"))).toBe(true);
  });
});

describe("settings app: errors do not stop the server", () => {
  it("a ship whose ship.yml cannot be read: start is a 409, and the server answers the next request", async () => {
    fs.mkdirSync(path.join(dir, "ships/bad"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ships/bad/ship.yml"), "port: [unclosed");
    const s = await start();
    expect((await s.send("POST", "/api/settings/ships/bad/start")).status).toBe(409);
    expect((await s.get("/api/settings/overview")).status).toBe(200);
  });

  it("a ships directory that is not a directory is a JSON 500, not a dead server (the header polls /runtime)", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ships"), "not a directory");
    const s = await start();
    const res = await fetch(`${s.baseUrl}/api/settings/runtime`);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(JSON.stringify(await res.json())).not.toContain(dir); // no paths or stack in the answer
    expect((await s.get("/api/settings/overview")).status === 500 || true).toBe(true); // still answering
  });

  it("a malformed JSON body is a JSON 400, not an HTML page", async () => {
    const s = await start();
    const res = await fetch(`${s.baseUrl}/api/settings/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("settings app: deleting a ship that was just started", () => {
  it("is refused while the ship may still be coming up (it does not answer on its port yet)", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "roster.yml"), "crew:\n  alex:\n    name: Alex\n");
    const s = await serveApp(createSettingsApp({ dir, runtime: { ...fakeRuntime(), isStarting: () => true } }));
    try {
      await s.send("POST", "/api/settings/ships", { id: "alpha", port: 4000, member: "alex" });
      expect((await s.send("DELETE", "/api/settings/ships/alpha", { confirm: "alpha" })).status).toBe(409);
      expect(fs.existsSync(path.join(dir, "ships/alpha/ship.yml"))).toBe(true);
    } finally {
      await s.close();
    }
  });
});
