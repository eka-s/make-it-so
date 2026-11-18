import type { AccountIdentity } from "./account-identity.js";
import type { UsageFetcher } from "./usage-fetcher.js";
import type { AccountsSnapshot, AccountUsage } from "./types.js";

// Returns credits (usage) grouped by account (same credentials).
//
// Crew members that will be started are grouped by provider (local crew members inherit the environment MIS was started in,
// so with the same provider they run on the same account). Crew members on remote hosts run on another machine
// with another login, so they are neither identified nor counted in the usage (untracked).
// Only claude can be identified. A provider that cannot be identified is shown with the provider name itself as the key.

/** Crew information needed to group by account. */
export type AccountCrewMember = { name: string; provider?: string; host?: unknown };

export type AccountUsageDeps = {
  /** The ship's crew (role → member). */
  crew: Record<string, AccountCrewMember>;
  /** Default provider when a member has no provider specified. */
  defaultProvider: string;
  usage: Pick<UsageFetcher, "fetchUsage" | "fetchUsageForced" | "getCached">;
  /**
   * Account identification per provider. A provider that cannot be identified (or is unsupported) is not included.
   */
  identify: Record<string, () => Promise<AccountIdentity | null>>;
};

/** Splits the crew into per-provider groups (local) and those excluded from counting (remote). */
export function groupCrewByProvider(
  crew: Record<string, AccountCrewMember>,
  defaultProvider: string,
): { byProvider: Map<string, string[]>; untracked: string[] } {
  const byProvider = new Map<string, string[]>();
  const untracked: string[] = [];
  for (const member of Object.values(crew)) {
    if (member.host) {
      untracked.push(member.name);
      continue;
    }
    const provider = member.provider ?? defaultProvider;
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), member.name]);
  }
  return { byProvider, untracked };
}

export function createAccountUsage(deps: AccountUsageDeps) {
  const { byProvider, untracked } = groupCrewByProvider(deps.crew, deps.defaultProvider);
  // Cache of identified accounts. Ones that could not be identified (null) are not cached and are retried at the next refresh
  const identities = new Map<string, AccountIdentity>();

  function build(): AccountsSnapshot {
    const accounts: AccountUsage[] = [...byProvider].map(([provider, crews]) => {
      const identity = identities.get(provider);
      return {
        key: identity?.key ?? provider,
        provider,
        label: identity?.label ?? null,
        ...(identity?.plan ? { plan: identity.plan } : {}),
        usage: deps.usage.getCached(provider),
        crews,
      };
    });
    return { accounts, untracked };
  }

  /** Returns the list from the information that is already there, without triggering a fetch. */
  function snapshot(): AccountsSnapshot {
    return build();
  }

  /**
   * Identifies the account and caches it. If cached, it is not run again unless `force` is set. If `force` finds that the account can no longer
   * be identified (e.g. logged out), the old cache is discarded (so we do not keep showing another account's name).
   */
  async function identifyProvider(provider: string, force: boolean): Promise<void> {
    if (identities.has(provider) && !force) return;
    const identify = deps.identify[provider];
    if (!identify) return;
    let identity: AccountIdentity | null = null;
    try {
      identity = await identify();
    } catch {
      // Even when identification fails, do not stop showing the usage (show it as an unknown account)
    }
    if (identity) identities.set(provider, identity);
    else if (force) identities.delete(provider);
  }

  /**
   * Re-identifies the accounts and re-fetches usage, then returns the list. Usage normally follows a 5-minute throttle;
   * `force` ignores it and re-fetches.
   */
  // A refresh that is running is shared: several callers asking at once (a reload storm: every new SSE connection asks) get the
  // same result instead of each starting its own `claude auth status` and `claude --print /usage`. A forced one is not served by
  // a plain one that is running, since it must re-fetch.
  const inFlight = new Map<boolean, Promise<AccountsSnapshot>>();

  function refresh(options: { force?: boolean } = {}): Promise<AccountsSnapshot> {
    const force = options.force === true;
    const running = inFlight.get(force) ?? (force ? undefined : inFlight.get(true));
    if (running) return running;
    const started = refreshNow(options).finally(() => inFlight.delete(force));
    inFlight.set(force, started);
    return started;
  }

  async function refreshNow(options: { force?: boolean }): Promise<AccountsSnapshot> {
    await Promise.all(
      [...byProvider.keys()].map(async (provider) => {
        await Promise.all([
          identifyProvider(provider, options.force === true),
          options.force ? deps.usage.fetchUsageForced(provider) : deps.usage.fetchUsage(provider),
        ]);
      }),
    );
    return build();
  }

  return { snapshot, refresh };
}

export type AccountUsageService = ReturnType<typeof createAccountUsage>;
