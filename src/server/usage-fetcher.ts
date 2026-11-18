import { spawn } from "node:child_process";
import type { CreditsUsageData } from "./types.js";
import { logger } from "./logger.js";

const THROTTLE_MS = 5 * 60 * 1000; // 5 minutes
const TIMEOUT_MS = 20_000; // 20 seconds
const IDLE_MS = 4_000; // no output for 4 seconds → done

/** Strips ANSI escape sequences from a string. */
export function stripAnsi(text: string): string {
  // The target is the ANSI escape (the control character ESC), so a regex with control characters is allowed
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Parses the output of /usage into structured data.
 * Expected format (after ANSI removal, example):
 *   Estimated Usage | resets on 2026-09-01 | KIRO PRO+
 *   Credits (1876.05 of 2000 covered in plan)
 *   ████████████████████ 93.8%
 *
 * The percentage is computed from used/limit (the displayed "93.8%" string is not read).
 * kiro-cli started printing percentages with a decimal point, so picking it up directly with
 * `/(\d+)%/` would catch only the part after the decimal point and give a wrong value
 * (e.g. only "8" from "93.8%").
 */
export function parseUsageOutput(raw: string): CreditsUsageData | null {
  const text = stripAnsi(raw);

  // Extracts used/limit: "850.00 of 1000"
  const usedLimitMatch = text.match(/(\d+\.?\d*)\s*of\s*(\d+)/);
  if (!usedLimitMatch) return null;
  const used = parseFloat(usedLimitMatch[1]);
  const limit = parseFloat(usedLimitMatch[2]);

  const usedPercent = limit > 0 ? (used / limit) * 100 : 0;

  // Extracts the reset date: "resets on 08/01" or "resets on 2026-08-01"
  const resetsMatch = text.match(/resets on (\d{4}-\d{2}-\d{2}|\d{2}\/\d{2})/);
  const resetsAt = resetsMatch ? resetsMatch[1] : "unknown";

  return { usedPercent, used, limit, resetsAt };
}

/** Runs `kiro-cli chat --no-interactive "/usage"` and collects stdout. */
export function runUsageCommand(): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const finish = (result: string | Error) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      proc.kill();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };

    const proc = spawn("kiro-cli", ["chat", "--no-interactive", "/usage"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // absolute timeout
    timeoutTimer = setTimeout(() => {
      finish(output || new Error("Usage command timed out after 20s"));
    }, TIMEOUT_MS);

    // Reset the idle timer every time a data chunk arrives
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(output);
      }, IDLE_MS);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      resetIdleTimer();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      // kiro-cli prints the /usage response to stderr
      output += chunk.toString();
      resetIdleTimer();
    });

    proc.on("close", () => {
      finish(output);
    });

    proc.on("error", (err) => {
      finish(err);
    });

    // Start the idle timer right away (the process may produce output immediately)
    resetIdleTimer();
  });
}

export function runClaudeUsageCommand(): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const finish = (result: string | Error) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      proc.kill();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const proc = spawn("claude", ["--print", "/usage"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    timeoutTimer = setTimeout(() => {
      finish(output || new Error("Claude usage command timed out after 20s"));
    }, TIMEOUT_MS);

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(output), IDLE_MS);
    };

    proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); resetIdleTimer(); });
    proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); resetIdleTimer(); });
    proc.on("close", () => finish(output));
    proc.on("error", (err) => finish(err));

    resetIdleTimer();
  });
}

export function parseClaudeUsageOutput(raw: string): CreditsUsageData | null {
  const text = stripAnsi(raw);
  // "Current week (all models): 5% used · resets Aug 13, 9pm (Asia/Tokyo)"
  const weekMatch = text.match(/Current week[^:]*:\s*(\d+)%\s*used\s*·\s*resets\s*([^\n(]+)/);
  if (!weekMatch) return null;
  const usedPercent = parseInt(weekMatch[1], 10);
  const resetsAt = weekMatch[2].trim();

  // "Current session: 35% used · resets Aug 9, 8:49pm (Asia/Tokyo)"
  const sessionMatch = text.match(/Current session:\s*(\d+)%\s*used\s*·\s*resets\s*([^\n(]+)/);
  const secondary = sessionMatch ? {
    label: "Session",
    usedPercent: parseInt(sessionMatch[1], 10),
    resetsAt: sessionMatch[2].trim(),
  } : undefined;

  return { usedPercent, resetsAt, label: "Weekly", secondary };
}

/** What is needed to fetch usage. index.ts passes it in production; tests pass fakes. */
export type UsageFetcherDeps = {
  /** Running external commands. When omitted, the real kiro-cli / claude is started (replaced in tests). */
  commands?: Partial<{
    runKiroUsage: () => Promise<string>;
    runClaudeUsage: () => Promise<string>;
  }>;
  /** Current time (milliseconds). Replaced in the throttling tests. */
  now?: () => number;
};

/**
 * Creates a fetcher that fetches usage (credits) and holds its cache and throttling.
 * Fetching is done per provider (kiro / claude), and the cache is also per provider, held inside the instance.
 * For a provider it does not know (other than kiro / claude), nothing can be fetched, so it returns null.
 */
export function createUsageFetcher(deps: UsageFetcherDeps = {}) {
  const commands = {
    runKiroUsage: deps.commands?.runKiroUsage ?? runUsageCommand,
    runClaudeUsage: deps.commands?.runClaudeUsage ?? runClaudeUsageCommand,
  };
  const clock = deps.now ?? Date.now;

  // --- Per-provider credits cache ---
  const cache = new Map<string, { data: CreditsUsageData; fetchedAt: number }>();

  /** Fetches usage data. Returns the cache within the throttling period. */
  async function fetchUsage(provider: string): Promise<CreditsUsageData | null> {
    const cached = cache.get(provider);
    if (cached && clock() - cached.fetchedAt < THROTTLE_MS) return cached.data;
    return doFetch(provider);
  }

  /** Fetches usage data by force, ignoring the throttling period. */
  async function fetchUsageForced(provider: string): Promise<CreditsUsageData | null> {
    return doFetch(provider);
  }

  /** Gets the cached credits data without triggering a fetch. */
  function getCached(provider: string): CreditsUsageData | null {
    return cache.get(provider)?.data ?? null;
  }

  async function doFetch(provider: string): Promise<CreditsUsageData | null> {
    try {
      let parsed: CreditsUsageData | null = null;
      if (provider === "kiro") {
        const raw = await commands.runKiroUsage();
        parsed = parseUsageOutput(raw);
        if (parsed) logger.info(`[UsageFetcher] kiro: ${parsed.used}/${parsed.limit} (${parsed.usedPercent}%) resets ${parsed.resetsAt}`);
      } else if (provider === "claude") {
        const raw = await commands.runClaudeUsage();
        parsed = parseClaudeUsageOutput(raw);
        if (parsed) logger.info(`[UsageFetcher] claude: ${parsed.usedPercent}% (${parsed.label}) resets ${parsed.resetsAt}`);
      } else {
        return null;
      }

      if (parsed) {
        cache.set(provider, { data: parsed, fetchedAt: clock() });
      } else {
        logger.warn(`[UsageFetcher] Failed to parse output (${provider})`);
      }
      return parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[UsageFetcher] Error (${provider}): ${msg}`);
      return getCached(provider);
    }
  }

  return {
    fetchUsage,
    fetchUsageForced,
    getCached,
  };
}

export type UsageFetcher = ReturnType<typeof createUsageFetcher>;
