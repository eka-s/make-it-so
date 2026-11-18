import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startTestServer, type TestServer } from "../testing/http.js";
import { createCrewProfileRouter, crewIconUrl, type CrewProfileRouterDeps } from "./crew-profile.js";
import type { CrewMemberConfig } from "../fleet-config.js";
import type { Language } from "../language.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let tmp: string;
let fleet: string;
let home: string;
let work: string;
let server: TestServer;
let crew: Record<string, CrewMemberConfig>;

function member(id: string, over: Partial<CrewMemberConfig> = {}): CrewMemberConfig {
  return { name: id.toUpperCase(), rank: "crew", acp_agent: id, cwd: work, rules: [], skills: [], additionalDirectories: [], ...over };
}

async function start(): Promise<void> {
  const deps: CrewProfileRouterDeps = {
    crew,
    defaultProvider: "claude",
    fleetRoot: fleet,
    home,
    briefingDeps: () => ({ fleetRoot: fleet, projectRoot: tmp, skillsDir: path.join(tmp, "skills"), crew, crewLanguage: "en" as Language }),
    hostInfo: () => ({ label: "dock", kind: "remote" }),
  };
  server = await startTestServer((app) => app.use(createCrewProfileRouter(deps)));
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-profile-"));
  fleet = path.join(tmp, "fleet");
  home = path.join(tmp, "home");
  work = path.join(tmp, "work");
  for (const dir of [fleet, home, work, path.join(fleet, "personnel")]) fs.mkdirSync(dir, { recursive: true });
  crew = { first_officer: member("alex"), ensign: member("jo", { permissionMode: "default" }) };
  await start();
});
afterEach(async () => {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const put = (role: string, body: Buffer | string, type = "application/octet-stream") =>
  fetch(`${server.baseUrl}/api/crew/${role}/icon`, { method: "PUT", headers: { "Content-Type": type }, body });

describe("GET /api/crew/:role/profile", () => {
  it("returns a summary of the settings (name, ID, provider, permission mode, cwd). If there is a persona file, its contents too", async () => {
    fs.writeFileSync(path.join(fleet, "personnel", "jo.md"), "Jo is careful.");
    const { status, body } = await server.get("/api/crew/ensign/profile");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      role: "ensign",
      name: "JO",
      memberId: "jo",
      provider: "claude",
      permissionMode: "default",
      cwd: work,
      host: null,
      persona: { source: "personnel", text: "Jo is careful.", path: "personnel/jo.md" },
    });
  });

  it("returns the briefing (the full text actually sent). The persona is in it too", async () => {
    fs.writeFileSync(path.join(fleet, "personnel", "jo.md"), "Jo is careful.");
    const { body } = await server.get("/api/crew/ensign/profile");
    const briefing = (body as { briefing: string }).briefing;
    expect(briefing).toContain("[SYSTEM: This is a briefing");
    expect(briefing).toContain("Jo is careful.");
  });

  it("if there is no persona file, the source is none", async () => {
    const { body } = await server.get("/api/crew/ensign/profile");
    expect((body as { persona: unknown }).persona).toEqual({ source: "none" });
  });

  it("a crew member that specifies agent shows the provider's definition file instead of a persona file (not_found if there is none)", async () => {
    crew.ensign = member("jo", { agent: "scout" });
    fs.writeFileSync(path.join(fleet, "personnel", "jo.md"), "ignored: the agent definition is the persona");
    expect(((await server.get("/api/crew/ensign/profile")).body as { persona: unknown }).persona).toEqual({ source: "agent", status: "not_found", agent: "scout" });

    const file = path.join(work, ".claude", "agents", "scout.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# Scout");
    const { body } = await server.get("/api/crew/ensign/profile");
    expect((body as { persona: unknown }).persona).toEqual({ source: "agent", status: "found", agent: "scout", text: "# Scout", path: file });
    // if there is an agent, the persona file is not in the briefing
    expect((body as { briefing: string }).briefing).not.toContain("ignored: the agent definition");
  });

  it("the agent definition of a remote host's crew member cannot be read, so it is remote. The host display is returned too", async () => {
    crew.ensign = member("jo", { agent: "scout", host: { name: "dock", destination: "me@x" } });
    const { body } = await server.get("/api/crew/ensign/profile");
    expect(body).toMatchObject({ host: { label: "dock", kind: "remote" }, persona: { source: "agent", status: "remote", agent: "scout" } });
  });

  it("if the rules file cannot be read, briefing is null and the reason is returned in briefingError (the profile itself is still returned)", async () => {
    crew.ensign = member("jo", { rules: [path.join(tmp, "missing-rule.md")] });
    const { status, body } = await server.get("/api/crew/ensign/profile");
    expect(status).toBe(200);
    expect(body).toMatchObject({ briefing: null, briefingError: expect.stringContaining("missing-rule.md") });
  });

  it("an unknown role is 404", async () => {
    expect((await server.get("/api/crew/nobody/profile")).status).toBe(404);
    expect((await server.get("/api/crew/constructor/profile")).status).toBe(404);
  });
});

describe("icon", () => {
  it("404 if there is no image", async () => {
    expect((await fetch(`${server.baseUrl}/api/crew/ensign/icon`)).status).toBe(404);
  });

  it("uploading saves to personnel/{ID}.png, the contents can be fetched, and the URL is returned", async () => {
    const res = await put("ensign", PNG);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { icon: string }).icon).toMatch(/^\/api\/crew\/ensign\/icon\?v=\d+$/);
    expect(fs.existsSync(path.join(fleet, "personnel", "jo.png"))).toBe(true);

    const got = await fetch(`${server.baseUrl}/api/crew/ensign/icon`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG);
  });

  it("something that is not an image (SVG, text) or empty is 400, and nothing is saved", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const res = await put("ensign", svg, "image/svg+xml");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "unsupported_type" });
    expect((await put("ensign", "hello", "text/plain")).status).toBe(400);
    expect((await put("ensign", Buffer.alloc(0))).status).toBe(400);
    expect(fs.readdirSync(path.join(fleet, "personnel"))).toEqual([]);
  });

  it("an image that is too large is 413, and nothing is saved", async () => {
    const big = Buffer.alloc(1024 * 1024 + 10);
    PNG.copy(big);
    const res = await put("ensign", big);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ reason: "too_large" });
    expect(fs.readdirSync(path.join(fleet, "personnel"))).toEqual([]);
  });

  it("deleting removes the image. It is not an error even if there is no image", async () => {
    await put("ensign", PNG);
    expect((await server.send("DELETE", "/api/crew/ensign/icon")).status).toBe(200);
    expect((await fetch(`${server.baseUrl}/api/crew/ensign/icon`)).status).toBe(404);
    expect((await server.send("DELETE", "/api/crew/ensign/icon")).status).toBe(200);
  });

  it("an operation on an unknown role is 404. A person whose ID has unusable characters is refused saving", async () => {
    expect((await put("nobody", PNG)).status).toBe(404);
    expect((await server.send("DELETE", "/api/crew/nobody/icon")).status).toBe(404);
    crew.ensign = member("../evil");
    const res = await put("ensign", PNG);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "invalid_member" });
  });
});

describe("crewIconUrl", () => {
  it("if there is an image, returns a URL with a modification time (the URL changes when it is replaced). undefined if none", () => {
    expect(crewIconUrl("ensign", { mtimeMs: 1700000000123.9 })).toBe("/api/crew/ensign/icon?v=1700000000123");
    expect(crewIconUrl("ensign", null)).toBeUndefined();
  });
});
