import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFrontMatter, scanProject } from "./project-scan.js";

let project: string;
beforeEach(() => { project = fs.mkdtempSync(path.join(os.tmpdir(), "mis-scan-")); });
afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

function write(rel: string, text: string): void {
  const f = path.join(project, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

describe("readFrontMatter", () => {
  it("reads the YAML block at the top of a Markdown file", () => {
    expect(readFrontMatter("---\nname: a\nmodel: sonnet\n---\nbody")).toEqual({ name: "a", model: "sonnet" });
  });
  it("is empty for a file without front matter or with a broken one", () => {
    expect(readFrontMatter("just text")).toEqual({});
    expect(readFrontMatter("---\n: : :\n  - [\n---\n")).toEqual({});
  });
});

describe("scanProject", () => {
  it("reports a path that is not a directory", () => {
    const scan = scanProject(path.join(project, "missing"));
    expect(scan.isDirectory).toBe(false);
    expect(scan.claude).toBeNull();
    expect(scan.kiro).toBeNull();
  });

  it("finds nothing for a project without any agent tooling", () => {
    const scan = scanProject(project);
    expect(scan.isDirectory).toBe(true);
    expect(scan.claude).toBeNull();
    expect(scan.kiro).toBeNull();
  });

  it("reads claude agents by their front matter name, or the file name without one", () => {
    write(".claude/agents/reviewer.md", "---\nname: code-reviewer\ndescription: Reviews code\nmodel: opus\n---\nYou review.");
    write(".claude/agents/plain.md", "No front matter.");
    write(".claude/agents/notes.txt", "ignored");
    const claude = scanProject(project).claude!;
    expect(claude.agents).toEqual([
      { name: "plain", file: ".claude/agents/plain.md", description: null, model: null },
      { name: "code-reviewer", file: ".claude/agents/reviewer.md", description: "Reviews code", model: "opus" },
    ]);
  });

  it("reads the model and permission mode from settings, the local file winning", () => {
    write(".claude/settings.json", JSON.stringify({ model: "sonnet", permissions: { defaultMode: "plan" } }));
    write(".claude/settings.local.json", JSON.stringify({ model: "opus" }));
    const claude = scanProject(project).claude!;
    expect(claude.model).toBe("opus");
    expect(claude.permissionMode).toBe("plan");
  });

  it("does not import the mode that skips every confirmation, and says so", () => {
    write(".claude/settings.json", JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
    const claude = scanProject(project).claude!;
    expect(claude.permissionMode).toBeNull();
    expect(claude.notes).toEqual([{ code: "bypassNotImported", file: ".claude/settings.json" }]);
  });

  it("reports MCP servers and CLAUDE.md as candidates only", () => {
    write(".mcp.json", JSON.stringify({ mcpServers: { github: {}, db: {} } }));
    write("CLAUDE.md", "# rules");
    const claude = scanProject(project).claude!;
    expect(claude.mcp).toEqual({ file: ".mcp.json", servers: ["github", "db"] });
    expect(claude.ruleCandidates).toEqual(["CLAUDE.md"]);
  });

  it("notes a settings file that is not valid JSON and goes on", () => {
    write(".claude/settings.json", "{ broken");
    write(".claude/agents/a.md", "x");
    const claude = scanProject(project).claude!;
    expect(claude.notes).toEqual([{ code: "unreadable", file: ".claude/settings.json" }]);
    expect(claude.agents.map((a) => a.name)).toEqual(["a"]);
  });

  it("reads kiro agents from JSON and Markdown, the file name standing in for a missing name", () => {
    write(".kiro/agents/builder.json", JSON.stringify({ name: "build-agent", description: "Builds", model: "claude-sonnet-4", prompt: "x" }));
    write(".kiro/agents/tester.json", JSON.stringify({ prompt: "x" }));
    write(".kiro/agents/writer.md", "---\ndescription: Writes\n---\nbody");
    write(".kiro/agents/broken.json", "{ nope");
    const kiro = scanProject(project).kiro!;
    expect(kiro.agents.map((a) => [a.name, a.model])).toEqual([["build-agent", "claude-sonnet-4"], ["tester", null], ["writer", null]]);
    expect(kiro.notes).toEqual([{ code: "unreadable", file: ".kiro/agents/broken.json" }]);
  });

  it("offers kiro steering files and its MCP servers", () => {
    write(".kiro/steering/product.md", "x");
    write(".kiro/steering/tech.md", "x");
    write(".kiro/settings/mcp.json", JSON.stringify({ mcpServers: { fs: {} } }));
    const kiro = scanProject(project).kiro!;
    expect(kiro.ruleCandidates).toEqual([".kiro/steering/product.md", ".kiro/steering/tech.md"]);
    expect(kiro.mcp).toEqual({ file: ".kiro/settings/mcp.json", servers: ["fs"] });
  });
});

describe("files that are too large to be what they claim", () => {
  it("an agent definition over the size limit is reported as unreadable and not read", () => {
    write(".claude/agents/big.md", "---\nname: big\n---\n" + "x".repeat(1024 * 1024 + 10));
    write(".claude/agents/ok.md", "---\nname: ok\n---\nfine");
    const claude = scanProject(project).claude!;
    expect(claude.agents.map((a) => a.name)).toEqual(["ok"]);
    expect(claude.notes).toEqual([{ code: "unreadable", file: ".claude/agents/big.md" }]);
  });
});
