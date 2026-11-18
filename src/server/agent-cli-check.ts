import fs from "node:fs";
import path from "node:path";

// Checks whether the agent's CLI is on the PATH. When it is missing, this lets us show guidance up front
// instead of a confusing spawn ENOENT failure. It cannot check authentication (whether you are logged in).

export type PathLookup = {
  /** Value of the PATH environment variable. */
  pathEnv: string | undefined;
  platform: NodeJS.Platform;
  /** Executable extensions on Windows (PATHEXT). */
  pathExt?: string;
  /** Whether the given path exists as a regular file. */
  isFile: (p: string) => boolean;
};

/** Defaults when checking against the real environment. */
export function systemPathLookup(env: NodeJS.ProcessEnv = process.env): PathLookup {
  return {
    pathEnv: env.PATH ?? env.Path,
    platform: process.platform,
    pathExt: env.PATHEXT,
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** Whether the command is on the PATH (for a command that contains a path, whether that path exists). */
export function isOnPath(command: string, lookup: PathLookup): boolean {
  const win = lookup.platform === "win32";
  const exts = win ? ["", ...(lookup.pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const candidates = (base: string) => exts.map((e) => base + e);
  if (path.isAbsolute(command) || command.includes("/") || (win && command.includes("\\"))) {
    return candidates(command).some(lookup.isFile);
  }
  const dirs = (lookup.pathEnv ?? "").split(win ? ";" : ":").filter(Boolean);
  return dirs.some((dir) => candidates(path.join(dir, command)).some(lookup.isFile));
}

/** Default startup command per provider (same as the default of `acp.<provider>.command` in config.yml). */
export const DEFAULT_PROVIDER_COMMAND: Record<string, string> = { kiro: "kiro-cli", claude: "npx" };

/** Guidance shown to the user when it is missing. null when it is found. */
export function missingCliMessage(provider: string, command: string, lookup: PathLookup): string | null {
  if (isOnPath(command, lookup)) return null;
  // The npx advice only fits the default command; a command someone chose ("acp.<provider>.command") is theirs to install.
  const isDefault = command === DEFAULT_PROVIDER_COMMAND[provider];
  const hint = !isDefault
    ? `Check "acp.${provider}.command" in config.yml (the settings screen: Config), or install that command.`
    : provider === "claude"
      ? "Install Node.js (npx comes with it); the Claude agent adapter is fetched with npx on first start, and you need to be logged in to Claude Code."
      : "Install kiro-cli and log in to it.";
  return `"${command}" (needed for the ${provider} provider) was not found on PATH. ${hint} make-it-so cannot check whether you are logged in.`;
}
