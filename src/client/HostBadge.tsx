import type { CrewHostInfo } from "./types";

// A mark for a crew member running on a remote host (shown next to the speaker name and the talk-target selector).
// It is not shown for local crew members, so nothing is rendered when there is no host.
export function HostBadge({ host }: { host?: CrewHostInfo }) {
  if (!host) return null;
  return (
    <span className="host-badge" title={host.address ? `${host.label} (${host.address})` : host.label}>
      🌐 {host.label}
    </span>
  );
}
