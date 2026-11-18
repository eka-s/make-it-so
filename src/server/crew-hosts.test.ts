import { describe, expect, it } from "vitest";
import { groupCrewByHost, type CrewHostGroupDeps } from "./crew-hosts.js";

const local = {};
const onDock = { host: { name: "dock", destination: "dock" } };
const onBox = { host: { name: "box", destination: "me@box" } };

const deps: CrewHostGroupDeps = {
  localHostname: "bridge-pc",
  hostAddress: (name) => ({ dock: "127.0.0.1", box: "box" })[name],
  tunnelState: (name) => (name === "dock" ? "connected" : "connecting"),
};

describe("groupCrewByHost", () => {
  it("with only local crew, one local group (no tunnel)", () => {
    expect(groupCrewByHost({ a: local, b: local }, deps, (r) => r)).toEqual([
      { host: { label: "bridge-pc", kind: "local" }, tunnel: null, crew: ["a", "b"] },
    ]);
  });

  it("local first, remotes in the order they first appear. Crew members of the same host form one group", () => {
    const groups = groupCrewByHost({ a: onBox, b: local, c: onDock, d: onBox }, deps, (r) => r);
    expect(groups.map((g) => [g.host.label, g.crew])).toEqual([
      ["bridge-pc", ["b"]],
      ["box", ["a", "d"]],
      ["dock", ["c"]],
    ]);
  });

  it("the connection address is attached only when it differs from the name. The tunnel state is per host", () => {
    const groups = groupCrewByHost({ c: onDock, d: onBox }, deps, (r) => r);
    expect(groups[0]).toEqual({ host: { label: "dock", kind: "remote", address: "127.0.0.1" }, tunnel: "connected", crew: ["c"] });
    expect(groups[1]).toEqual({ host: { label: "box", kind: "remote" }, tunnel: "connecting", crew: ["d"] });
  });

  it("with no local crew members, no local group is shown", () => {
    const groups = groupCrewByHost({ c: onDock }, deps, (r) => r);
    expect(groups.map((g) => g.host.kind)).toEqual(["remote"]);
  });
});
