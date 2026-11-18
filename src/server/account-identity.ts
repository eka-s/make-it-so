import { execFile } from "node:child_process";

// Identifies which account is logged in. Credits (the usage quota) are determined per authenticated account,
// not per crew member or per provider, so this is the material for grouping crew members that run on the same credentials.
//
// Only claude can be identified for now (`claude auth status`). kiro-cli is not supported (the output format is unknown).
// When an account cannot be identified, we return "unknown" (null) instead of guessing.

export type AccountIdentity = {
  /**
   * Key that decides whether two crew members share the same credentials. Built from the provider and the organization ID (the email address alone would mix personal and organization quotas).
   */
  key: string;
  /** Name shown on screen (the email address, or the organization name if there is none). */
  label: string;
  /** Kind of plan (pro, max, etc.). */
  plan?: string;
};

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Reads the account from the output (JSON) of `claude auth status`.
 * Returns null when not logged in, when there is no organization ID (API-key auth etc., which has no usage quota), or when the output is not JSON.
 */
export function parseClaudeAuthStatus(raw: string): AccountIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const status = parsed as Record<string, unknown>;
  if (status.loggedIn !== true) return null;
  const orgId = nonEmpty(status.orgId);
  if (!orgId) return null;
  return {
    key: `claude:${orgId}`,
    label: nonEmpty(status.email) ?? nonEmpty(status.orgName) ?? orgId,
    plan: nonEmpty(status.subscriptionType),
  };
}

const TIMEOUT_MS = 15_000;

/** Runs `claude auth status` and returns its standard output. */
export function runClaudeAuthStatus(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("claude", ["auth", "status"], { timeout: TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
