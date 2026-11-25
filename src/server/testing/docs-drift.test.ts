import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Keeps the reference docs in step with the code: every HTTP route and every config key in the code
// must be listed in its reference doc, and the doc must not list one that no longer exists.
// The code is read as text, so adding a route or a key without documenting it fails here.
// Both language versions of each doc (English, and `.ja.md` in Japanese) are checked.

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf-8");

function sorted(set: Set<string>): string[] {
  return [...set].sort();
}

describe.each(["", ".ja"])("docs/reference/http-api%s.md", (lang) => {
  // Sub-routers mounted under a prefix (the paths inside them are relative to it).
  const MOUNTED: Record<string, string> = { "pins.ts": "/api/pins" };

  function codeRoutes(): Set<string> {
    const found = new Set<string>();
    const pattern = /\b(?:router|app)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/g;
    const files = fs.readdirSync(path.join(root, "src/server/routes")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const sources: [string, string][] = [
      ...files.map((f): [string, string] => [f, read(`src/server/routes/${f}`)]),
      ["app.ts", read("src/server/app.ts")],
      ["mcp-listener.ts", read("src/server/mcp-listener.ts")],
      ["settings-app.ts", read("src/server/settings/settings-app.ts")],
    ];
    for (const [file, source] of sources) {
      for (const m of source.matchAll(pattern)) {
        const prefix = MOUNTED[file] ?? "";
        const routePath = prefix + (m[2] === "/" && prefix ? "" : m[2]);
        // Only the API and the MCP endpoint (not the static-file fallback).
        if (routePath.startsWith("/api") || routePath === "/mcp") found.add(`${m[1].toUpperCase()} ${routePath}`);
      }
    }
    return found;
  }

  function documentedRoutes(): Set<string> {
    const found = new Set<string>();
    for (const m of read(`docs/reference/http-api${lang}.md`).matchAll(/`(GET|POST|PUT|DELETE|PATCH) (\/[^`?\s]*)/g)) {
      found.add(`${m[1]} ${m[2]}`);
    }
    return found;
  }

  it("lists exactly the routes the server registers", () => {
    expect(sorted(documentedRoutes())).toEqual(sorted(codeRoutes()));
  });
});

describe.each(["", ".ja"])("docs/reference/configuration%s.md", (lang) => {
  const doc = read(`docs/reference/configuration${lang}.md`);
  const documentedKeys = new Set([...doc.matchAll(/^\| `([^`|]+)`/gm)].map((m) => m[1]));
  // Keys that were renamed and are only mentioned as a startup error.
  const RENAMED = new Set(["profile"]);

  /** Property names (depth 1) of an `interface Name { ... }` in a source file. */
  function interfaceKeys(file: string, name: string): string[] {
    const body = read(file).match(new RegExp(`interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`))?.[1];
    if (!body) throw new Error(`interface ${name} not found in ${file}`);
    return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]).filter((k) => !RENAMED.has(k));
  }

  it("lists every config.yml key that load-config.ts reads", () => {
    const keys = new Set<string>();
    for (const m of read("src/server/load-config.ts").matchAll(/\braw\??\.(\w+(?:\??\.\w+)*)/g)) {
      keys.add(m[1].replace(/\?/g, ""));
    }
    expect(keys.size).toBeGreaterThan(5);
    expect(sorted(keys).filter((k) => !documentedKeys.has(k))).toEqual([]);
  });

  it("lists every roster.yml member key", () => {
    expect(interfaceKeys("src/server/fleet-config.ts", "RosterMember").filter((k) => !documentedKeys.has(k))).toEqual([]);
  });

  it("lists every ship.yml key and every crew assignment key", () => {
    const keys = [...interfaceKeys("src/server/fleet-config.ts", "RawShipFile"), ...interfaceKeys("src/server/fleet-config.ts", "ShipCrewAssignment")];
    expect(keys.filter((k) => !documentedKeys.has(k))).toEqual([]);
  });

  it("lists every quick-actions.yml item key (actions[].<key>)", () => {
    // QuickAction is a `type` literal in quick-actions.ts, so read its property names directly.
    const body = read("src/server/quick-actions.ts").match(/export type QuickAction = \{\n([\s\S]*?)\n\};/)?.[1];
    if (!body) throw new Error("type QuickAction not found in quick-actions.ts");
    const keys = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => `actions[].${m[1]}`);
    expect(keys.length).toBeGreaterThan(5);
    expect(keys.filter((k) => !documentedKeys.has(k))).toEqual([]);
  });

  it("the server reads no MAKE_IT_SO_* environment variable (settings come from files and the --ship argument)", () => {
    const vars = new Set<string>();
    const dir = path.join(root, "src/server");
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      for (const m of read(`src/server/${f}`).matchAll(/\benv\.(MAKE_IT_SO_[A-Z_]+)/g)) vars.add(m[1]);
    }
    expect(sorted(vars)).toEqual([]);
  });

  it("does not list a config.yml key that load-config.ts no longer reads", () => {
    // Every documented config.yml key (dotted or top-level, in the config.yml section) must be read by load-config.ts.
    const section = doc.split(/^## `config\.yml`$/m)[1]?.split(/^## /m)[0] ?? "";
    const documented = [...section.matchAll(/^\| `([^`|]+)`/gm)].map((m) => m[1]);
    const source = read("src/server/load-config.ts");
    const stale = documented.filter((key) => {
      const last = key.split(".").pop()!;
      return !new RegExp(`\\b${last}\\b`).test(source);
    });
    expect(stale).toEqual([]);
  });
});
