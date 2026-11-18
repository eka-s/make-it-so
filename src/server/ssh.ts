// Pure functions dedicated to building the commands for running an agent on a remote host (another PC or server) over SSH.
// They do not depend on config or the logger (to make unit testing easy). The actual spawn is done by
// `base-acp-client.ts`, and keeping the reverse tunnel resident is done by `host-tunnel.ts`.
//
// Authentication and encryption are left entirely to SSH (we have no tokens or TLS of our own).
// Connection details such as keys, ports, users, and host key handling all go in
// `~/.ssh/config` (per-PC settings) — only the destination name is kept here (a setting that may be
// shared via git), to avoid key paths and the like being left in the repository by mistake.

import { execFile } from "node:child_process";

export type HostConfig = {
  // Key in fleet/hosts.yml (for logs and error messages).
  name: string;
  // The ssh destination (a Host name in ~/.ssh/config, or `user@host`).
  destination: string;
};

/**
 * Escapes for a POSIX shell with single quotes. Used when building the script passed to `bash -lc`
 * on the remote side (a value containing spaces, `$`, or quotes is still treated as one word).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Options common to ssh. `BatchMode` is enabled so it never hangs waiting for a password
 * (key authentication is assumed), and `ServerAlive*` is added so dead connections are detected.
 * Ports, keys, etc. are not added (left to ~/.ssh/config; see the top of the file).
 */
function commonArgs(): string[] {
  const args = [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
  ];
  return args;
}

/**
 * An ssh command that runs `cd {cwd} && exec {command} {args}` on the remote host.
 * Going through `bash -lc` (a login shell) puts the remote PATH, tokens, and other environment variables in the same state
 * as a normal login to that host (non-interactive ssh does not read the profile, and a node installed via nvm, etc., may not be found).
 * The remote is assumed to be a Unix-like system with bash.
 */
export function buildRemoteSpawn(
  host: HostConfig,
  cwd: string,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  const script = `cd ${shellQuote(cwd)} && exec ${[command, ...args].map(shellQuote).join(" ")}`;
  return {
    command: "ssh",
    args: [...commonArgs(), host.destination, `bash -lc ${shellQuote(script)}`],
  };
}

// A marker announcing that the tunnel is established (printed to stdout by the remote command).
export const TUNNEL_READY_MARKER = "makeitso-tunnel-ready";

/**
 * An ssh command for the reverse tunnel that makes the main HTTP (`/mcp`) reachable from the remote localhost.
 * Only one is kept resident per host (host-tunnel.ts).
 *
 * The reasons for running `echo ...; exec cat` on the remote instead of `-N` are twofold:
 * - The server handles the forward request first and then the session, so when the marker arrives
 *   the forward is already established (if it failed, ssh would have exited first because of `ExitOnForwardFailure`).
 * - `cat` exits when stdin is closed, so the tunnel is not left behind when the main process dies.
 */
export function buildTunnelSpawn(host: HostConfig, port: number): { command: string; args: string[] } {
  return {
    command: "ssh",
    args: [
      ...commonArgs(),
      "-o", "ExitOnForwardFailure=yes",
      "-R", `127.0.0.1:${port}:127.0.0.1:${port}`,
      host.destination,
      `echo ${TUNNEL_READY_MARKER}; exec cat`,
    ],
  };
}

/**
 * Extracts the actual connection host name (it may be an IP address) from the output of `ssh -G <destination>`.
 * This is the resolved value of `HostName` in ~/.ssh/config, or the destination itself if there is none.
 */
export function parseSshResolvedHostname(sshGOutput: string): string | undefined {
  const m = /^hostname\s+(\S+)\s*$/m.exec(sshGOutput);
  return m?.[1];
}

/** Something that runs `ssh -G <destination>` and returns its standard output (replaced in tests). */
export type SshGRunner = (destination: string) => Promise<string>;

/** Runs the real `ssh -G`. Throws if it does not finish in time. */
export const runSshG: SshGRunner = (destination) =>
  new Promise((resolve, reject) => {
    execFile("ssh", ["-G", destination], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/**
 * Resolves the actual connection target (host name/IP) of each host with `ssh -G`. It is auxiliary information for display,
 * so a host that cannot be resolved is silently left out (it does not affect the connection itself).
 */
export async function resolveHostAddresses(
  hosts: HostConfig[],
  run: SshGRunner = runSshG,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  await Promise.all(hosts.map(async (host) => {
    try {
      const address = parseSshResolvedHostname(await run(host.destination));
      if (address) result.set(host.name, address);
    } catch {
      // Ignored because it is only for display
    }
  }));
  return result;
}
