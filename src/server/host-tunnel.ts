// An SSH reverse tunnel kept alive, one per remote host.
//
// A remote agent calls the main bulletin-board MCP (`http://127.0.0.1:{mcpPort}/mcp`)
// via the remote localhost. If the port forward for that (ssh -R) were set up per
// agent session, several crew members on the same host would fight over the same
// remote port, and when the first connection dropped everyone's MCP would be cut off
// with it. So one tunnel per host is managed here, and crew sessions only run plain ssh (see ssh.ts).
//
// When it drops, it reconnects with exponential backoff. If the main process dies, the remote
// `cat` exits when stdin is closed and the tunnel disappears too.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { TunnelState } from "./crew-hosts.js";
import { logger } from "./logger.js";
import { buildTunnelSpawn, TUNNEL_READY_MARKER, type HostConfig } from "./ssh.js";

export const READY_TIMEOUT_MS = 20_000;
export const BACKOFF_MIN_MS = 2_000;
export const BACKOFF_MAX_MS = 30_000;

/**
 * Function that starts the ssh child process. Production uses node:child_process spawn; tests pass a fake.
 */
export type SpawnTunnel = (command: string, args: string[]) => ChildProcess;

const spawnSsh: SpawnTunnel = (command, args) =>
  nodeSpawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

class HostTunnel {
  private process: ChildProcess | null = null;
  private ready = false;
  private backoffMs = BACKOFF_MIN_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private waiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  private lastError = "";

  constructor(
    private readonly host: HostConfig,
    // Port of the main process's MCP listener (connects the remote localhost of the same number to the main /mcp).
    private readonly port: number,
    private readonly spawn: SpawnTunnel,
  ) {}

  /** Whether the tunnel is established. */
  isReady(): boolean {
    return this.ready;
  }

  /** Starts connecting (only if not connected). */
  start(): void {
    if (this.process || this.retryTimer) return;
    this.connect();
  }

  /** Waits until the tunnel is established. Throws if it is not established in time. */
  waitReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    this.start();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(
          `[Host:${this.host.name}] SSH tunnel not ready after ${READY_TIMEOUT_MS / 1000}s${this.lastError ? `: ${this.lastError}` : ""}`,
        ));
      }, READY_TIMEOUT_MS);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private connect(): void {
    const { command, args } = buildTunnelSpawn(this.host, this.port);
    logger.info(`[Host:${this.host.name}] Opening SSH tunnel (remote 127.0.0.1:${this.port} -> main)`);
    const proc = this.spawn(command, args);
    this.process = proc;

    createInterface({ input: proc.stdout! }).on("line", (line) => {
      if (line.trim() !== TUNNEL_READY_MARKER) return;
      this.ready = true;
      this.backoffMs = BACKOFF_MIN_MS;
      logger.info(`[Host:${this.host.name}] SSH tunnel ready`);
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve();
      }
    });
    proc.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        this.lastError = msg;
        logger.warn(`[Host:${this.host.name}] ssh: ${msg}`);
      }
    });
    // The process ended (or never started): retry later. A command that cannot be started (no ssh) emits "error" and no "exit", so
    // both paths end here, once.
    let ended = false;
    const onEnded = (code: number | null) => {
      if (ended) return;
      ended = true;
      this.process = null;
      this.ready = false;
      logger.warn(`[Host:${this.host.name}] SSH tunnel closed (code ${code}); retrying in ${this.backoffMs / 1000}s`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    };
    proc.on("error", (err) => {
      this.lastError = err.message;
      onEnded(null);
    });
    proc.on("exit", onEnded);
  }
}

/**
 * Manages the per-host reverse tunnels. `ensureTunnel` for the same host shares the same single
 * tunnel. `port` is the main HTTP port.
 */
export function createHostTunnels(port: number, spawn: SpawnTunnel = spawnSsh) {
  const tunnels = new Map<string, HostTunnel>();

  return {
    /** Waits until the reverse tunnel to the given host is established (starting it if needed). */
    ensureTunnel(host: HostConfig): Promise<void> {
      let tunnel = tunnels.get(host.name);
      if (!tunnel) {
        tunnel = new HostTunnel(host, port, spawn);
        tunnels.set(host.name, tunnel);
      }
      return tunnel.waitReady();
    },
    /**
     * Tunnel state for display. "idle" if not opened yet, "connecting" while waiting to establish or reconnect,
     * "connected" once established.
     */
    state(hostName: string): TunnelState {
      const tunnel = tunnels.get(hostName);
      if (!tunnel) return "idle";
      return tunnel.isReady() ? "connected" : "connecting";
    },
  };
}
