import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDraft, readImportContext, toId, type ImportContext } from "./import-draft.js";
import type { ProviderScan } from "./project-scan.js";

const scan = (over: Partial<ProviderScan> = {}): ProviderScan => ({ agents: [], model: null, permissionMode: null, ruleCandidates: [], mcp: null, notes: [], ...over });
const agent = (name: string, model: string | null = null) => ({ name, file: `.claude/agents/${name}.md`, description: null, model });
const empty = (): ImportContext => ({ roster: new Map(), shipIds: new Set(), ports: new Set() });

describe("toId", () => {
  it("makes an ID of letters, digits, underscores and hyphens", () => {
    expect(toId("Code Reviewer!", "x")).toBe("code-reviewer");
    expect(toId("--api_v2", "x")).toBe("api_v2");
    expect(toId("日本語", "fallback")).toBe("fallback");
  });
});

describe("buildDraft", () => {
  it("makes one chief per agent definition, working in the project and referring to the definition by name", () => {
    const draft = buildDraft("claude", "/work/my-app", scan({ agents: [agent("reviewer"), agent("builder", "opus")] }), empty());
    expect(draft.members.map((m) => [m.id, m.input.provider, m.input.model, m.exists])).toEqual([
      ["reviewer", "claude", null, false],
      ["builder", "claude", "opus", false],
    ]);
    expect(draft.ship.fields.crew).toEqual([
      { role: "reviewer", member: "reviewer", rank: "chief", model: null, permission_mode: null, cwd: "/work/my-app", agent: "reviewer", host: null, access: [{ target: "my-app", mode: "readwrite" }] },
      { role: "builder", member: "builder", rank: "chief", model: null, permission_mode: null, cwd: "/work/my-app", agent: "builder", host: null, access: [{ target: "my-app", mode: "readwrite" }] },
    ]);
    expect(draft.ship.fields.targets).toEqual([{ name: "my-app", path: "/work/my-app" }]);
    expect(draft.ship.fields.crew.some((r) => r.rank === "commander")).toBe(false);
  });

  it("names the ship after the folder, with a free port", () => {
    const draft = buildDraft("claude", "/work/My App", scan(), { ...empty(), ports: new Set([3939, 3940]) });
    expect(draft.ship.id).toBe("my-app");
    expect(draft.ship.fields.name).toBe("My App");
    expect(draft.ship.fields.port).toBe(3941);
  });

  it("makes a single generic member, with no agent reference, for a project without agent definitions", () => {
    const draft = buildDraft("kiro", "/work/app", scan(), empty());
    expect(draft.members).toHaveLength(1);
    expect(draft.members[0].input).toMatchObject({ name: "lead", provider: "kiro" });
    expect(draft.ship.fields.crew[0]).toMatchObject({ member: "lead", rank: "chief", agent: null });
  });

  it("takes the project's default model and permission mode unless the agent sets its own model", () => {
    const draft = buildDraft("claude", "/work/app", scan({ agents: [agent("a"), agent("b", "opus")], model: "sonnet", permissionMode: "plan" }), empty());
    expect(draft.members.map((m) => [m.input.model, m.input.permission_mode])).toEqual([["sonnet", "plan"], ["opus", "plan"]]);
  });

  it("offers an existing roster member of the same provider for reuse, and keeps a different provider's apart", () => {
    const context: ImportContext = { ...empty(), roster: new Map([["reviewer", "claude"], ["builder", "kiro"]]) };
    const draft = buildDraft("claude", "/work/app", scan({ agents: [agent("reviewer"), agent("builder")] }), context);
    expect(draft.members.map((m) => [m.id, m.exists, m.reuse])).toEqual([["reviewer", true, true], ["builder-2", false, false]]);
    expect(draft.ship.fields.crew.map((r) => [r.member, r.agent])).toEqual([["reviewer", "reviewer"], ["builder-2", "builder"]]);
  });

  it("tells two definitions that make the same ID apart", () => {
    const draft = buildDraft("claude", "/work/app", scan({ agents: [agent("Code Review"), agent("code-review")] }), empty());
    expect(draft.members.map((m) => m.id)).toEqual(["code-review", "code-review-2"]);
  });

  it("gives a ship ID no other ship has", () => {
    const draft = buildDraft("claude", "/work/app", scan(), { ...empty(), shipIds: new Set(["app", "app-2"]) });
    expect(draft.ship.id).toBe("app-3");
  });

  it("offers rule files and MCP servers without adding them", () => {
    const draft = buildDraft("claude", "/work/app", scan({ ruleCandidates: ["CLAUDE.md"], mcp: { file: ".mcp.json", servers: ["x"] } }), empty());
    expect(draft.ship.fields.rules).toEqual([]);
    expect(draft.ruleCandidates).toEqual([{ label: "CLAUDE.md", path: "/work/app/CLAUDE.md" }]);
    expect(draft.mcp).toEqual({ file: ".mcp.json", servers: ["x"] });
  });
});

describe("readImportContext", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-ctx-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("is empty for a directory that does not exist yet", () => {
    const ctx = readImportContext(path.join(dir, "none"));
    expect(ctx.roster.size).toBe(0);
    expect(ctx.shipIds.size).toBe(0);
  });

  it("reads the roster IDs with their providers, and the ships with their ports", () => {
    fs.writeFileSync(path.join(dir, "roster.yml"), "crew:\n  alex:\n    name: Alex\n    provider: kiro\n  sam:\n    name: Sam\n");
    fs.mkdirSync(path.join(dir, "ships", "alpha"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ships", "alpha", "ship.yml"), "port: 4001\ncrew: {}\n");
    fs.mkdirSync(path.join(dir, "ships", "stray"), { recursive: true });
    const ctx = readImportContext(dir);
    expect([...ctx.roster]).toEqual([["alex", "kiro"], ["sam", null]]);
    expect([...ctx.shipIds]).toEqual(["alpha"]);
    expect([...ctx.ports]).toEqual([4001]);
  });
});
