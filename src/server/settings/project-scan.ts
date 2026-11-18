import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { PERMISSION_MODE_SUGGESTIONS } from "./roster-settings.js";

// Reads what a project already has for a provider's agent tooling (`.claude/` for claude, `.kiro/` for kiro), so that a
// ship can be drafted from it. Nothing here writes anything, and nothing found is copied: an agent definition stays in
// the project and is only referred to by name.

export type ScanProvider = "claude" | "kiro";

export type FoundAgent = {
  /** The name the provider knows the agent by (the `agent` value of a role). */
  name: string;
  /** The definition file, relative to the project. */
  file: string;
  description: string | null;
  model: string | null;
};

export type ScanNote =
  | { code: "unreadable"; file: string }
  | { code: "bypassNotImported"; file: string };

export type ProviderScan = {
  agents: FoundAgent[];
  /** The default model the project sets, if any. */
  model: string | null;
  /** The default permission mode the project sets, if any (never a mode that skips every confirmation). */
  permissionMode: string | null;
  /** Files that could be handed to the crew as ship rules. The provider already reads them itself, so they are offered, not chosen. */
  ruleCandidates: string[];
  /** MCP servers the project configures. They widen what a crew member can do, so they are only reported, never imported. */
  mcp: { file: string; servers: string[] } | null;
  notes: ScanNote[];
};

export type ProjectScan = {
  dir: string;
  /** False when the path is not an existing directory (nothing else is filled in then). */
  isDirectory: boolean;
  claude: ProviderScan | null;
  kiro: ProviderScan | null;
};

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

// An agent definition or a settings file is small. A larger file (or a special file such as a FIFO) is not read, so that scanning a
// project can never block or exhaust the server.
const MAX_FILE_BYTES = 1024 * 1024;

function readText(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** Reads a JSON object file. Returns null when the file does not exist and "unreadable" when it is not a JSON object. */
function readJsonObject(file: string): Record<string, unknown> | null | "unreadable" {
  const raw = readText(file);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : "unreadable";
  } catch {
    return "unreadable";
  }
}

/** Splits a Markdown file into its YAML front matter and what follows. A file without (valid) front matter has an empty one. */
export function readFrontMatter(source: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!m) return {};
  try {
    const value = parse(m[1]) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const stem = (file: string) => path.basename(file).replace(/\.[^.]+$/, "");

function listFiles(dir: string, extensions: string[]): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && extensions.includes(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function mcpServers(project: string, rel: string, notes: ScanNote[]): ProviderScan["mcp"] {
  const json = readJsonObject(path.join(project, rel));
  if (json === null) return null;
  if (json === "unreadable") { notes.push({ code: "unreadable", file: rel }); return null; }
  const servers = json.mcpServers;
  const names = typeof servers === "object" && servers !== null ? Object.keys(servers) : [];
  return names.length > 0 ? { file: rel, servers: names } : null;
}

/** The permission mode to offer from a project setting: a known mode, and never the one that skips every confirmation. */
function importablePermissionMode(value: unknown, file: string, notes: ScanNote[]): string | null {
  const mode = text(value);
  if (mode === null) return null;
  if (mode === "bypassPermissions") { notes.push({ code: "bypassNotImported", file }); return null; }
  return (PERMISSION_MODE_SUGGESTIONS as readonly string[]).includes(mode) ? mode : null;
}

function scanClaude(project: string): ProviderScan | null {
  const root = path.join(project, ".claude");
  const mcpFile = path.join(project, ".mcp.json");
  const claudeMd = path.join(project, "CLAUDE.md");
  if (!fs.existsSync(root) && !fs.existsSync(mcpFile) && !fs.existsSync(claudeMd)) return null;

  const notes: ScanNote[] = [];
  const agents: FoundAgent[] = [];
  for (const name of listFiles(path.join(root, "agents"), [".md"])) {
    const rel = path.posix.join(".claude/agents", name);
    const source = readText(path.join(project, rel));
    if (source === null) { notes.push({ code: "unreadable", file: rel }); continue; }
    const meta = readFrontMatter(source);
    agents.push({ name: text(meta.name) ?? stem(name), file: rel, description: text(meta.description), model: text(meta.model) });
  }

  // settings.local.json is the personal override of settings.json, so it wins.
  let model: string | null = null;
  let permissionMode: string | null = null;
  for (const name of ["settings.json", "settings.local.json"]) {
    const rel = path.posix.join(".claude", name);
    const json = readJsonObject(path.join(project, rel));
    if (json === null) continue;
    if (json === "unreadable") { notes.push({ code: "unreadable", file: rel }); continue; }
    model = text(json.model) ?? model;
    const permissions = json.permissions;
    const mode = typeof permissions === "object" && permissions !== null ? (permissions as Record<string, unknown>).defaultMode : undefined;
    permissionMode = importablePermissionMode(mode, rel, notes) ?? permissionMode;
  }

  return {
    agents, model, permissionMode,
    ruleCandidates: fs.existsSync(claudeMd) ? ["CLAUDE.md"] : [],
    mcp: mcpServers(project, ".mcp.json", notes),
    notes,
  };
}

function scanKiro(project: string): ProviderScan | null {
  const root = path.join(project, ".kiro");
  if (!fs.existsSync(root)) return null;

  const notes: ScanNote[] = [];
  const agents: FoundAgent[] = [];
  // An agent is a JSON or a Markdown file; the file name is the agent's name unless the file says another.
  for (const name of listFiles(path.join(root, "agents"), [".json", ".md"])) {
    const rel = path.posix.join(".kiro/agents", name);
    const source = readText(path.join(project, rel));
    if (source === null) { notes.push({ code: "unreadable", file: rel }); continue; }
    let meta: Record<string, unknown>;
    if (name.toLowerCase().endsWith(".json")) {
      try {
        const value = JSON.parse(source) as unknown;
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
        meta = value as Record<string, unknown>;
      } catch {
        notes.push({ code: "unreadable", file: rel });
        continue;
      }
    } else {
      meta = readFrontMatter(source);
    }
    agents.push({ name: text(meta.name) ?? stem(name), file: rel, description: text(meta.description), model: text(meta.model) });
  }

  return {
    agents, model: null, permissionMode: null,
    ruleCandidates: listFiles(path.join(root, "steering"), [".md"]).map((n) => path.posix.join(".kiro/steering", n)),
    mcp: mcpServers(project, ".kiro/settings/mcp.json", notes),
    notes,
  };
}

/** Reads what a project has for each provider. A provider the project has nothing for is null. */
export function scanProject(dir: string): ProjectScan {
  const resolved = path.resolve(dir);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(resolved).isDirectory();
  } catch {
    // not there
  }
  if (!isDirectory) return { dir: resolved, isDirectory: false, claude: null, kiro: null };
  return { dir: resolved, isDirectory: true, claude: scanClaude(resolved), kiro: scanKiro(resolved) };
}
