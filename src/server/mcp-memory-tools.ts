import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MEMORY_STATUSES } from "./memory-document.js";
import { MemoryError, type MemoryStore } from "./memory-store.js";
import { logger } from "./logger.js";

// The tools of the ship's Memory (an OKF bundle of Markdown memos), for every crew member. They are thin: the store validates, writes,
// indexes and commits. A write that goes through returns what the store warns about, so a crew member sees a limit being passed
// without the write being refused.

export type MemoryTools = Pick<MemoryStore, "write" | "deprecate" | "remove" | "read" | "search" | "history">;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

function json(value: unknown): ToolResult {
  return text(JSON.stringify(value, null, 2));
}

/** Runs a tool body; a refusal of the store becomes a message the crew member can act on, anything else is logged and reported briefly. */
async function guarded(tool: string, work: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof MemoryError) {
      const current = err.current ? `\n\nThe memo as it is now:\n${JSON.stringify(err.current, null, 2)}` : "";
      return text(`Error: ${err.message}${current}`, true);
    }
    logger.error(`[MCP] ${tool} failed:`, err);
    return text(`Error: ${tool} failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

function writeResult(verb: string, result: { path: string; version: string; warnings: string[] }): ToolResult {
  const warnings = result.warnings.length > 0 ? `\nWarnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}` : "";
  return text(`${verb} ${result.path}. version: ${result.version}${warnings}`);
}

const STATUS = z.enum(MEMORY_STATUSES);

/** Registers the Memory tools. `writer` gives the display name of the calling crew member (undefined when it cannot be identified). */
export function registerMemoryTools(server: McpServer, memory: MemoryTools, writer: () => string | undefined): void {
  const unidentified = (tool: string): ToolResult => {
    logger.error(`[MCP] ${tool}: the caller could not be identified (headers are missing or it is not in the ship)`);
    return text("Error: the caller could not be identified.", true);
  };

  server.registerTool(
    "search_memory",
    {
      description: "Lists and searches the ship's Memory (memos the crew keeps: decisions, procedures, notes). With no `query` it lists; with one it searches the titles, descriptions and bodies (every word must match). Narrow it with `status` or `path` (a path prefix, such as /procedures). Returns the path, title, description and status of each memo; read one with read_memory.",
      inputSchema: {
        query: z.string().max(1000).optional().describe("Words to look for"),
        status: z.array(STATUS).optional().describe("Only memos with one of these statuses (default: all, deprecated ones included)"),
        path: z.string().optional().describe("Only memos whose path starts with this"),
        limit: z.number().int().min(1).max(100).optional().describe("How many to return (default 20)"),
        offset: z.number().int().min(0).optional().describe("How many to skip, to see the next page"),
      },
    },
    async ({ query, status, path, limit, offset }) => guarded("search_memory", () => {
      const result = memory.search({ query, statuses: status, pathPrefix: path, limit, offset });
      return json({ total: result.total, items: result.items });
    }),
  );

  server.registerTool(
    "read_memory",
    {
      description: "Reads one memo of the ship's Memory by its path (as search_memory gives it). Returns its title, description, status, body, and `version`: to update the memo with write_memory, pass that version as `base`.",
      inputSchema: { path: z.string().describe("The path of the memo, such as procedures/deploy.md") },
    },
    async ({ path }) => guarded("read_memory", () => {
      const doc = memory.read(path.replace(/^\//, ""));
      if (!doc) return text(`There is no memo at ${path}. Use search_memory to find the path.`, true);
      const { frontmatter: _frontmatter, ...rest } = doc;
      return json(rest);
    }),
  );

  server.registerTool(
    "write_memory",
    {
      description: "Creates or updates a memo in the ship's Memory. Use it to keep what was learned or decided so that you and the other crew can find it later (see the memory skill for when and how). Give the `path` (you choose it: directories group memos, such as procedures/deploy.md), a one-line `description` of what the memo is and when it helps, the `body` in Markdown, and `message`, the change in a sentence (it is kept in the history). To update an existing memo, first read it with read_memory and pass its `version` as `base`; a stale or missing `base` is refused, with the memo as it is now. Leaving out `status` on an update keeps it. A memo that is still a rough note takes status draft. The server keeps the index.md files; do not write them.",
      inputSchema: {
        path: z.string().describe("Where the memo lives, ending with .md"),
        title: z.string().optional().describe("A title, in your language"),
        description: z.string().describe("One line: what this memo is and when it helps"),
        body: z.string().describe("The memo, in Markdown. Link to other memos with Markdown links"),
        status: STATUS.optional().describe("draft for a rough note, stable (the default, no flag) otherwise"),
        message: z.string().describe("The change in a sentence (the history message)"),
        base: z.string().optional().describe("The version read with read_memory; required to update an existing memo"),
      },
    },
    async ({ path, title, description, body, status, message, base }) => guarded("write_memory", async () => {
      const crew = writer();
      if (crew === undefined) return unidentified("write_memory");
      const result = await memory.write({ path: path.replace(/^\//, ""), title, description, body, status, message, base, crew });
      return writeResult(result.created ? "Created" : "Updated", result);
    }),
  );

  server.registerTool(
    "deprecate_memory",
    {
      description: "Marks a memo of the ship's Memory as deprecated: it stays (and stays in the history and the index), but is shown as no longer to be followed. Use it when a memo is out of date or replaced. Pass `superseded_by`, the path with a leading / of the memo that replaces it, when there is one. Use delete_memory only for what should not be kept at all.",
      inputSchema: {
        path: z.string(),
        superseded_by: z.string().optional().describe("The memo that replaces this one, such as /procedures/deploy-v2.md"),
        message: z.string().describe("Why, in a sentence (the history message)"),
      },
    },
    async ({ path, superseded_by, message }) => guarded("deprecate_memory", async () => {
      const crew = writer();
      if (crew === undefined) return unidentified("deprecate_memory");
      const result = await memory.deprecate({ path: path.replace(/^\//, ""), supersededBy: superseded_by, message, crew });
      return writeResult("Deprecated", result);
    }),
  );

  server.registerTool(
    "delete_memory",
    {
      description: "Deletes a memo of the ship's Memory. It stays in the history (get_memory_history), but it is gone from the Memory. Prefer deprecate_memory for a memo that was true once; delete what was wrong, a duplicate, or never worth keeping.",
      inputSchema: {
        path: z.string(),
        message: z.string().describe("Why, in a sentence (the history message)"),
      },
    },
    async ({ path, message }) => guarded("delete_memory", async () => {
      const crew = writer();
      if (crew === undefined) return unidentified("delete_memory");
      const result = await memory.remove({ path: path.replace(/^\//, ""), message, crew });
      return text(`Deleted ${result.path}.`);
    }),
  );

  server.registerTool(
    "get_memory_history",
    {
      description: "Gets the change history of the ship's Memory: who changed what, when, and why (the messages), newest first. Pass `path` for the history of one memo, deleted ones included; add `diff: true` with a path to see what each change did. Use it when asked what changed in the Memory, or to summarize recent work.",
      inputSchema: {
        path: z.string().optional().describe("A memo; leave out for the whole Memory"),
        limit: z.number().int().min(1).max(100).optional().describe("How many changes (default 20)"),
        diff: z.boolean().optional().describe("Include the diff of each change (needs path)"),
      },
    },
    async ({ path, limit, diff }) => guarded("get_memory_history", async () => {
      if (diff && !path) return text("Error: `diff` needs a `path`.", true);
      const entries = await memory.history({ path: path?.replace(/^\//, ""), limit, diff });
      return entries.length === 0 ? text("There is no history yet.") : json(entries);
    }),
  );
}
