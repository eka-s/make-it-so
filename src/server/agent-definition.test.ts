import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAgentDefinition } from "./agent-definition.js";

let tmp: string;
let cwd: string;
let home: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-agentdef-"));
  cwd = path.join(tmp, "work");
  home = path.join(tmp, "home");
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

describe("findAgentDefinition", () => {
  it("claude: reads .claude/agents/{name}.md in the cwd", () => {
    const file = write(path.join(cwd, ".claude/agents/scout.md"), "# Scout");
    expect(findAgentDefinition({ provider: "claude", agent: "scout", cwd, home })).toEqual({ path: file, text: "# Scout" });
  });

  it("claude: if not in the cwd, reads .claude/agents in the home. If both exist, the cwd comes first", () => {
    const homeFile = write(path.join(home, ".claude/agents/scout.md"), "home");
    expect(findAgentDefinition({ provider: "claude", agent: "scout", cwd, home })?.path).toBe(homeFile);
    const cwdFile = write(path.join(cwd, ".claude/agents/scout.md"), "cwd");
    expect(findAgentDefinition({ provider: "claude", agent: "scout", cwd, home })?.path).toBe(cwdFile);
  });

  it("kiro: reads .kiro/agents/{name}.json. Does not read claude's definition", () => {
    write(path.join(cwd, ".claude/agents/scout.md"), "claude");
    expect(findAgentDefinition({ provider: "kiro", agent: "scout", cwd, home })).toBeNull();
    const file = write(path.join(cwd, ".kiro/agents/scout.json"), "{}");
    expect(findAgentDefinition({ provider: "kiro", agent: "scout", cwd, home })?.path).toBe(file);
  });

  it("a name that is not found or invalid (path separators or ..) returns null and reads no other location", () => {
    write(path.join(tmp, "secret.md"), "secret");
    expect(findAgentDefinition({ provider: "claude", agent: "nobody", cwd, home })).toBeNull();
    expect(findAgentDefinition({ provider: "claude", agent: "../../secret", cwd: path.join(cwd, ".claude/agents"), home })).toBeNull();
    expect(findAgentDefinition({ provider: "claude", agent: "a/b", cwd, home })).toBeNull();
    expect(findAgentDefinition({ provider: "claude", agent: "..", cwd, home })).toBeNull();
    expect(findAgentDefinition({ provider: "claude", agent: "", cwd, home })).toBeNull();
  });
});
