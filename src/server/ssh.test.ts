import { describe, expect, it } from "vitest";
import {
  buildRemoteSpawn,
  buildTunnelSpawn,
  parseSshResolvedHostname,
  resolveHostAddresses,
  shellQuote,
  TUNNEL_READY_MARKER,
  type HostConfig,
} from "./ssh.js";

const host: HostConfig = { name: "dev", destination: "me@dev-server" };

describe("shellQuote", () => {
  it("keeps whitespace, $, and quotes as one word", () => {
    expect(shellQuote("a b")).toBe(`'a b'`);
    expect(shellQuote("$HOME")).toBe(`'$HOME'`);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("buildRemoteSpawn", () => {
  it("builds a bash -lc that does cd and exec", () => {
    const r = buildRemoteSpawn(host, "/srv/my proj", "npx", ["--yes", "pkg"]);
    expect(r.command).toBe("ssh");
    expect(r.args).toContain("BatchMode=yes");
    expect(r.args.at(-2)).toBe("me@dev-server");
    expect(r.args.at(-1)).toBe(`bash -lc 'cd '\\''/srv/my proj'\\'' && exec '\\''npx'\\'' '\\''--yes'\\'' '\\''pkg'\\'''`);
  });

  it("connection details (port, key) are not put in the command (left to ~/.ssh/config)", () => {
    const r = buildRemoteSpawn({ name: "d", destination: "dev" }, "/w", "x", []);
    expect(r.args).not.toContain("-p");
    expect(r.args).not.toContain("-i");
    expect(r.args.join(" ")).not.toContain("StrictHostKeyChecking");
  });
});

describe("buildTunnelSpawn", () => {
  it("builds the reverse tunnel and the marker command", () => {
    const r = buildTunnelSpawn(host, 3939);
    expect(r.args).toContain("ExitOnForwardFailure=yes");
    expect(r.args).toContain("127.0.0.1:3939:127.0.0.1:3939");
    expect(r.args.at(-1)).toBe(`echo ${TUNNEL_READY_MARKER}; exec cat`);
  });
});

describe("parseSshResolvedHostname", () => {
  it("extracts the value of the hostname line from the output of `ssh -G`", () => {
    const out = "user alice\nhostname 127.0.0.1\nport 2222\nidentityfile ~/.ssh/key\n";
    expect(parseSshResolvedHostname(out)).toBe("127.0.0.1");
  });
  it("undefined if there is no hostname line", () => {
    expect(parseSshResolvedHostname("user alice\nport 22\n")).toBeUndefined();
  });
});

describe("resolveHostAddresses", () => {
  it("resolves per host. A host that fails is left out (no exception)", async () => {
    const run = async (destination: string) => {
      if (destination === "bad") throw new Error("ssh failed");
      return `hostname ${destination}.example\n`;
    };
    const result = await resolveHostAddresses(
      [{ name: "a", destination: "a" }, { name: "b", destination: "bad" }],
      run,
    );
    expect([...result]).toEqual([["a", "a.example"]]);
  });
});
