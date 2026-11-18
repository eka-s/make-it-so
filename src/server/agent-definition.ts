import fs from "node:fs";
import path from "node:path";

// The persona of a crew member that specifies `agent:` lives in the provider's own definition (agent). This looks for that definition file
// within what MIS can read and shows it on screen.
//   claude: `{cwd}/.claude/agents/{name}.md`, otherwise `{home}/.claude/agents/{name}.md`
//   kiro:   `{cwd}/.kiro/agents/{name}.json`, otherwise `{home}/.kiro/agents/{name}.json`
// Only the contents of that file are visible. The final prompt the provider actually uses is a combination of `CLAUDE.md`, skills,
// plugins, user settings, and more, so MIS cannot obtain it.
// The definition of a remote host's crew member lives on another machine, so it is not searched.

export type AgentDefinition = { path: string; text: string };

/**
 * Characters allowed in an agent name (it becomes a file name, so path separators and `..` are rejected).
 */
const SAFE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function candidates(provider: string, agent: string, cwd: string, home: string): string[] {
  const dirs = provider === "kiro" ? [".kiro/agents"] : [".claude/agents"];
  const ext = provider === "kiro" ? "json" : "md";
  return [cwd, home].flatMap((base) => dirs.map((dir) => path.join(base, dir, `${agent}.${ext}`)));
}

/** Looks for the definition file. Returns null if the name is invalid or the file is not found. */
export function findAgentDefinition(options: { provider: string; agent: string; cwd: string; home: string }): AgentDefinition | null {
  if (!SAFE_AGENT_NAME.test(options.agent) || options.agent.includes("..")) return null;
  for (const file of candidates(options.provider, options.agent, options.cwd, options.home)) {
    try {
      if (fs.statSync(file).isFile()) return { path: file, text: fs.readFileSync(file, "utf-8") };
    } catch {
      // If not found, look in the next location
    }
  }
  return null;
}
