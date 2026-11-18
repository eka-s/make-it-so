// Provider-specific slash commands (`/context`, `/compact`, etc.). In ACP, the agent sends the list of available commands
// in an `available_commands_update` notification, and running one only requires sending `/name args` as the prompt body
// (verified on a real machine with claude-agent-acp; not verified with kiro).

export type SlashCommand = {
  /** Command name (without the leading `/`). */
  name: string;
  description: string;
  /**
   * Input hint for the arguments (e.g. `[interval] [prompt]`). Left out for commands that take no arguments.
   */
  hint?: string;
};

/** Reads `availableCommands` of `available_commands_update`. Entries with the wrong shape are dropped. */
export function parseAvailableCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return [];
  const commands: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { name, description, input } = item as { name?: unknown; description?: unknown; input?: { hint?: unknown } | null };
    if (typeof name !== "string" || name === "" || seen.has(name)) continue;
    seen.add(name);
    const hint = typeof input?.hint === "string" && input.hint !== "" ? input.hint : undefined;
    commands.push({ name, description: typeof description === "string" ? description : "", ...(hint ? { hint } : {}) });
  }
  return commands;
}

/**
 * Reads back the list saved in the DB (`SlashCommand[]` as JSON). Entries with the wrong shape are dropped.
 */
export function parseStoredCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return [];
  const commands: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { name, description, hint } = item as { name?: unknown; description?: unknown; hint?: unknown };
    if (typeof name !== "string" || name === "" || seen.has(name)) continue;
    seen.add(name);
    commands.push({
      name,
      description: typeof description === "string" ? description : "",
      ...(typeof hint === "string" && hint !== "" ? { hint } : {}),
    });
  }
  return commands;
}

/**
 * Whether the text runs a slash command in the list. True only when it starts with `/name`, what follows is whitespace or the end of the text,
 * and the name is in the list. A `/`-prefixed text that is not in the list (a path like `/usr/bin`) is treated as an ordinary sentence.
 */
export function isSlashCommand(text: string, commands: SlashCommand[]): boolean {
  const match = /^\/(\S+)(?:\s|$)/.exec(text);
  return match !== null && commands.some((c) => c.name === match[1]);
}
