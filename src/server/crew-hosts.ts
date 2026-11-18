// Groups crew members by the host they run on (for the group display of the crew status panel).
// The grouping is resolved on the server, and the client just renders in the order received (CLAUDE.md "Architecture policy").
import type { CrewMemberConfig } from "./fleet-config.js";

export type TunnelState = "connected" | "connecting" | "idle";

/** Host information shown on screen (shared by the group heading and the chat badge). */
export type CrewHostInfo = {
  /** Display name (for local, this machine's host name; for remote, the key in hosts.yml). */
  label: string;
  kind: "local" | "remote";
  /**
   * Actual connection target (the host name/IP resolved by `ssh -G`). Absent if it cannot be resolved or equals the name.
   */
  address?: string;
};

export type CrewHostGroup<T> = {
  host: CrewHostInfo;
  /** State of the reverse tunnel to the remote host. Always null for local. */
  tunnel: TunnelState | null;
  crew: T[];
};

export type CrewHostGroupDeps = {
  /** This machine's host name (the heading of the local group). */
  localHostname: string;
  /** Connection address of the remote host (if resolved). */
  hostAddress: (hostName: string) => string | undefined;
  /** State of the tunnel to the remote host. */
  tunnelState: (hostName: string) => TunnelState;
};

/** Display information of the host one crew member runs on. */
export function crewHostInfo(member: Pick<CrewMemberConfig, "host">, deps: CrewHostGroupDeps): CrewHostInfo {
  if (!member.host) return { label: deps.localHostname, kind: "local" };
  const address = deps.hostAddress(member.host.name);
  return { label: member.host.name, kind: "remote", ...(address && address !== member.host.name ? { address } : {}) };
}

/**
 * Groups a list of roles by host. Local comes first (omitted when there are no local crew members); remotes follow in the order they first
 * appear in the crew order.
 * `entryOf` builds, from a role, the data for one row inside a group.
 */
export function groupCrewByHost<T>(
  crew: Record<string, Pick<CrewMemberConfig, "host">>,
  deps: CrewHostGroupDeps,
  entryOf: (role: string) => T,
): Array<CrewHostGroup<T>> {
  const local: T[] = [];
  const remote = new Map<string, T[]>();
  const members = new Map<string, NonNullable<CrewMemberConfig["host"]>>();
  for (const [role, member] of Object.entries(crew)) {
    if (!member.host) {
      local.push(entryOf(role));
      continue;
    }
    const list = remote.get(member.host.name) ?? [];
    list.push(entryOf(role));
    remote.set(member.host.name, list);
    members.set(member.host.name, member.host);
  }

  const groups: Array<CrewHostGroup<T>> = [];
  if (local.length > 0) {
    groups.push({ host: { label: deps.localHostname, kind: "local" }, tunnel: null, crew: local });
  }
  for (const [name, entries] of remote) {
    groups.push({
      host: crewHostInfo({ host: members.get(name)! }, deps),
      tunnel: deps.tunnelState(name),
      crew: entries,
    });
  }
  return groups;
}
