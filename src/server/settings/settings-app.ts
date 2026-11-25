import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { parse } from "yaml";
import { createErrorHandler } from "../http-errors.js";
import { createLocalRequestGuard } from "../local-guard.js";
import { createSecurityHeaders } from "../security-headers.js";
import { readOverview } from "./settings-overview.js";
import { applyConfigValues, readConfigState } from "./config-fields.js";
import { readHostsState, saveHosts, type HostEntry } from "./hosts-settings.js";
import { listFleetShips, readQuickActions, saveQuickActions } from "../quick-actions.js";
import { YamlUnreadableError } from "./yaml-edit.js";
import { deleteMember, readPersona, readRosterState, saveMember, savePersona, type RosterMemberInput } from "./roster-settings.js";
import type { ShipRuntime } from "./ship-runtime.js";
import { applyImport, type ApplyMember } from "./import-apply.js";
import { buildDraft, readImportContext } from "./import-draft.js";
import { scanProject } from "./project-scan.js";
import { deleteShip, isShipFileReadable, newShipFields, parseShipFields, readShipState, saveShip } from "./ship-settings.js";
import { deleteCrewIcon, findCrewIcon, MAX_ICON_BYTES, saveCrewIcon } from "../crew-icons.js";
import { isLanguage, DEFAULT_LANGUAGE } from "../language.js";
import { DEFAULT_THEME, isTheme, type Theme } from "../theme.js";

/** What is needed to assemble the settings app. settings-main.ts wires it in production; tests pass fakes. */
export type SettingsAppDeps = {
  /** The directory being edited (~/.make-it-so). */
  dir: string;
  /** Directory of the built client (`dist/client`). When omitted (`npm run dev`), Vite serves the UI and proxies the API. */
  clientDir?: string;
  /** Starts, stops and looks at the ships' processes. */
  runtime: ShipRuntime;
  /**
   * Whether a ship started from here serves its screen: only when this server runs from the build (`dist`), the ships it
   * starts do too. In development (tsx) the screen is served by Vite, so a started ship has the API only.
   */
  shipUi?: boolean;
  /**
   * Whether this is the desktop app's settings: a ship has no port or screen address of its own there, it is opened in a window,
   * and it stops when that window is closed. The screen then offers "open" instead of start and stop.
   */
  desktop?: boolean;
};

/** The UI language, from config.yml (the settings screen has no ship database to take it from). */
function readLanguage(dir: string): "en" | "ja" {
  try {
    const raw = parse(fs.readFileSync(path.join(dir, "config.yml"), "utf-8")) as { language?: unknown } | null;
    return isLanguage(raw?.language) ? raw.language : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/** The default look, from config.yml (like the language: the settings screen has no ship database). */
function readTheme(dir: string): Theme {
  try {
    const raw = parse(fs.readFileSync(path.join(dir, "config.yml"), "utf-8")) as { theme?: unknown } | null;
    return isTheme(raw?.theme) ? raw.theme : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** The member fields of a request body, with what is missing filled in (validation is saveMember's job). */
function memberInput(body: Partial<RosterMemberInput>): RosterMemberInput {
  return {
    name: body.name as string,
    provider: body.provider ?? null,
    model: body.model ?? null,
    permission_mode: body.permission_mode ?? null,
    rules: body.rules ?? [],
    skills: body.skills ?? [],
  };
}

/** What an async route throws: a file that cannot be read as YAML is a 409; anything else goes to the error handler (JSON, logged). */
function sendUnexpected(err: unknown, res: express.Response, next: express.NextFunction): void {
  if (err instanceof YamlUnreadableError && !res.headersSent) res.status(409).json({ error: "unreadable", message: err.message });
  else next(err);
}

/**
 * Runs a read or a save and sends its result: a plain value is a 200, `{ status, body }` is sent as given, and a file that
 * cannot be read as YAML is a 409 (the file is left as it is) instead of a crash.
 */
function respond(res: express.Response, run: () => unknown): void {
  try {
    const result = run();
    if (typeof result === "object" && result !== null && "status" in result && "body" in result) {
      const { status, body } = result as { status: number; body: unknown };
      res.status(status).json(body);
    } else {
      res.json(result);
    }
  } catch (err) {
    if (err instanceof YamlUnreadableError) res.status(409).json({ error: "unreadable", message: err.message });
    else res.status(500).json({ error: "failed", message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Assembles the settings app. Like the ship app it does not listen on a port (the caller does) and has no
 * authentication, so the caller binds it to loopback only.
 */
export function createSettingsApp(deps: SettingsAppDeps): express.Express {
  const app = express();
  // The framework name is not told to anyone who asks.
  app.disable("x-powered-by");
  // The settings API can change what a ship runs and delete ships, so a request addressed to a non-local host name
  // (DNS rebinding) or sent from another origin is refused before anything else.
  app.use(createLocalRequestGuard());
  app.use(createSecurityHeaders());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/settings/overview", (_req, res) => {
    res.json(readOverview(deps.dir));
  });

  // --- config.yml ---
  app.get("/api/settings/config", (_req, res) => {
    respond(res, () => readConfigState(deps.dir));
  });

  app.put("/api/settings/config", (req, res) => {
    const values = (req.body as { values?: unknown } | undefined)?.values;
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      res.status(400).json({ error: "invalid_body", message: "values must be an object" });
      return;
    }
    respond(res, () => {
      const result = applyConfigValues(deps.dir, values as Record<string, unknown>);
      return result.ok ? result.state : { status: 400, body: { error: "invalid", errors: result.errors } };
    });
  });

  // --- hosts.yml ---
  app.get("/api/settings/hosts", (_req, res) => {
    respond(res, () => readHostsState(deps.dir));
  });

  app.put("/api/settings/hosts", (req, res) => {
    const hosts = (req.body as { hosts?: unknown } | undefined)?.hosts;
    if (!Array.isArray(hosts) || !hosts.every((h) => typeof h === "object" && h !== null)) {
      res.status(400).json({ error: "invalid_body", message: "hosts must be a list of { name, destination }" });
      return;
    }
    respond(res, () => {
      const result = saveHosts(deps.dir, hosts as HostEntry[]);
      return result.ok ? result.state : { status: 400, body: { error: "invalid", errors: result.errors } };
    });
  });

  // --- quick-actions.yml (the custom menu of the message box) ---
  const quickState = () => ({ actions: readQuickActions(deps.dir), ships: listFleetShips(deps.dir) });
  app.get("/api/settings/quick-actions", (_req, res) => {
    respond(res, quickState);
  });

  app.put("/api/settings/quick-actions", (req, res) => {
    const actions = (req.body as { actions?: unknown } | undefined)?.actions;
    if (!Array.isArray(actions)) {
      res.status(400).json({ error: "invalid_body", message: "actions must be a list" });
      return;
    }
    respond(res, () => {
      const result = saveQuickActions(deps.dir, actions);
      return result.ok ? quickState() : { status: 400, body: { error: "invalid", errors: result.errors } };
    });
  });

  // --- roster.yml and the files of a member ---
  app.get("/api/settings/roster", (_req, res) => {
    respond(res, () => readRosterState(deps.dir));
  });

  // Creates (POST, the ID in the body) or updates (PUT, the ID in the path) a member.
  app.post("/api/settings/roster", (req, res) => {
    const { id, ...member } = (req.body ?? {}) as { id?: unknown } & Partial<RosterMemberInput>;
    respond(res, () => {
      const result = saveMember(deps.dir, String(id ?? ""), memberInput(member), true);
      return result.ok ? result.state : { status: 400, body: { error: "invalid", errors: result.errors } };
    });
  });

  app.put("/api/settings/roster/:id", (req, res) => {
    respond(res, () => {
      const result = saveMember(deps.dir, req.params.id, memberInput((req.body ?? {}) as Partial<RosterMemberInput>), false);
      return result.ok ? result.state : { status: result.errors.id === "settings.error.memberMissing" ? 404 : 400, body: { error: "invalid", errors: result.errors } };
    });
  });

  app.delete("/api/settings/roster/:id", (req, res) => {
    respond(res, () => {
      const result = deleteMember(deps.dir, req.params.id);
      if (result.ok) return result.state;
      const status = result.errors.id === "settings.error.memberMissing" ? 404 : 409;
      return { status, body: { error: "invalid", errors: result.errors, usedBy: result.usedBy } };
    });
  });

  app.get("/api/settings/roster/:id/persona", (req, res) => {
    const persona = readPersona(deps.dir, req.params.id);
    if (!persona) res.status(400).json({ error: "invalid", errors: { id: "settings.error.memberId" } });
    else res.json(persona);
  });

  app.put("/api/settings/roster/:id/persona", (req, res) => {
    const text = (req.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string") {
      res.status(400).json({ error: "invalid_body", message: "text must be a string" });
      return;
    }
    if (!savePersona(deps.dir, req.params.id, text)) res.status(400).json({ error: "invalid", errors: { id: "settings.error.memberId" } });
    else res.json(readPersona(deps.dir, req.params.id));
  });

  app.get("/api/settings/roster/:id/icon", (req, res) => {
    const icon = findCrewIcon(deps.dir, req.params.id);
    if (!icon) {
      res.status(404).json({ error: "No icon" });
      return;
    }
    res.set({ "Content-Type": icon.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" });
    res.sendFile(icon.file);
  });

  // The bytes of the image as the body (the kind is decided from the leading bytes, see crew-icons.ts). Over the limit: 413.
  const rawBody = express.raw({ type: () => true, limit: MAX_ICON_BYTES + 1 });
  app.put(
    "/api/settings/roster/:id/icon",
    (req, res, next) => {
      rawBody(req, res, (err?: unknown) => {
        if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 413) {
          res.status(413).json({ error: "too_large" });
          return;
        }
        next(err);
      });
    },
    (req, res) => {
      const result = saveCrewIcon(deps.dir, req.params.id, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      if (!result.ok) res.status(result.reason === "too_large" ? 413 : 400).json({ error: result.reason });
      else res.json({ status: "ok" });
    },
  );

  app.delete("/api/settings/roster/:id/icon", (req, res) => {
    deleteCrewIcon(deps.dir, req.params.id);
    res.json({ status: "ok" });
  });

  // --- ships (ship.yml) ---
  app.get("/api/settings/ships/:id", (req, res) => {
    respond(res, () => readShipState(deps.dir, req.params.id) ?? { status: 404, body: { error: "not_found" } });
  });

  // --- starting and stopping ships ---
  app.get("/api/settings/runtime", (_req, res, next) => {
    void (async () => {
      const ships = await Promise.all(readOverview(deps.dir).ships.map((s) => deps.runtime.status(s.id)));
      // The address of a ship's screen and the command that serves it in development are made here, so the screen only shows them.
      res.json({
        ships: ships.map((s) => ({ ...s, url: s.port === null || deps.desktop === true ? null : `http://127.0.0.1:${s.port}`, devCommand: `npm run dev -- --ship ${s.id}` })),
        shipUi: deps.shipUi === true,
        desktop: deps.desktop === true,
      });
    })().catch((err) => sendUnexpected(err, res, next));
  });

  app.post("/api/settings/ships/:id/start", (req, res, next) => {
    void (async () => {
      if (!readShipState(deps.dir, req.params.id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const result = await deps.runtime.start(req.params.id);
      if (!result.ok) res.status(409).json({ error: "not_startable", reason: result.reason, message: `settings.error.start.${result.reason}` });
      else res.json(await deps.runtime.status(req.params.id));
    })().catch((err) => sendUnexpected(err, res, next));
  });

  app.post("/api/settings/ships/:id/stop", (req, res, next) => {
    void (async () => {
      const result = await deps.runtime.stop(req.params.id);
      if (!result.ok) res.status(409).json({ error: "not_running", message: "settings.error.start.not_running" });
      else res.json({ status: "stopping" });
    })().catch((err) => sendUnexpected(err, res, next));
  });

  // Removes a ship and everything it kept. The caller has to repeat the ship's ID as `confirm`, and the ship must not be running.
  app.delete("/api/settings/ships/:id", (req, res, next) => {
    void (async () => {
      const id = req.params.id;
      if ((req.body as { confirm?: unknown } | undefined)?.confirm !== id) {
        res.status(400).json({ error: "confirm_required", message: "settings.error.confirmRequired" });
        return;
      }
      const runtime = await deps.runtime.status(id);
      if (runtime.state === "running" || deps.runtime.isStarting(id)) {
        res.status(409).json({ error: "running", message: "settings.error.shipRunning" });
        return;
      }
      // Without a readable ship.yml there is no port to ask, so "not running" is only a guess: refuse, rather than risk it.
      if (runtime.port === null && !isShipFileReadable(deps.dir, id)) {
        res.status(409).json({ error: "unreadable", message: "settings.error.shipUnreadable" });
        return;
      }
      respond(res, () => {
        const result = deleteShip(deps.dir, id);
        return result.ok ? { status: "deleted" } : { status: result.error === "settings.error.shipMissing" ? 404 : 400, body: { error: "invalid", message: result.error } };
      });
    })().catch((err) => sendUnexpected(err, res, next));
  });

  app.get("/api/settings/ships/:id/log", (req, res) => {
    res.json({ text: deps.runtime.log(req.params.id) });
  });

  // A new ship: the minimal one (a commander role holding the given member), as `npm run init` makes.
  app.post("/api/settings/ships", (req, res) => {
    const { id, port, name, member } = (req.body ?? {}) as { id?: unknown; port?: unknown; name?: unknown; member?: unknown };
    if (typeof id !== "string" || typeof port !== "number" || typeof member !== "string" || (name !== undefined && name !== null && typeof name !== "string")) {
      res.status(400).json({ error: "invalid_body", message: "id, port and member are required" });
      return;
    }
    respond(res, () => {
      const result = saveShip(deps.dir, id.trim(), newShipFields(port, typeof name === "string" && name.trim() ? name.trim() : null, member.trim()), true);
      return result.ok ? result.state : { status: 400, body: { error: "invalid", errors: result.errors } };
    });
  });

  app.put("/api/settings/ships/:id", (req, res) => {
    const fields = parseShipFields((req.body as { fields?: unknown } | undefined)?.fields);
    if (!fields) {
      res.status(400).json({ error: "invalid_body", message: "fields has the wrong shape" });
      return;
    }
    respond(res, () => {
      const result = saveShip(deps.dir, req.params.id, fields, false);
      if (result.ok) return result.state;
      return { status: result.errors.id === "settings.error.shipMissing" ? 404 : 400, body: { error: "invalid", errors: result.errors } };
    });
  });

  // --- making a ship from an existing project ---
  // Reading the project and drafting what would be made writes nothing; the draft is looked at and changed on the screen.
  app.post("/api/settings/import/scan", (req, res) => {
    const raw = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof raw !== "string" || raw.trim() === "") {
      res.status(400).json({ error: "invalid_body", message: "path is required" });
      return;
    }
    respond(res, () => {
      const trimmed = raw.trim();
      const scan = scanProject(trimmed === "~" || trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed);
      if (!scan.isDirectory) return { dir: scan.dir, isDirectory: false, found: { claude: false, kiro: false }, drafts: null };
      const context = readImportContext(deps.dir);
      return {
        dir: scan.dir,
        isDirectory: true,
        found: { claude: scan.claude !== null, kiro: scan.kiro !== null },
        drafts: { claude: buildDraft("claude", scan.dir, scan.claude, context), kiro: buildDraft("kiro", scan.dir, scan.kiro, context) },
      };
    });
  });

  // Saves a (changed) draft: the members that are new, and the ship. Nothing is left behind when any of it is refused.
  app.post("/api/settings/import", (req, res) => {
    const body = (req.body ?? {}) as { members?: unknown; ship?: { id?: unknown; fields?: unknown } };
    const fields = parseShipFields(body.ship?.fields);
    const members = Array.isArray(body.members) ? body.members : null;
    const valid = members?.every((m) => typeof m === "object" && m !== null && typeof m.id === "string" && typeof m.reuse === "boolean");
    if (!fields || typeof body.ship?.id !== "string" || !members || !valid) {
      res.status(400).json({ error: "invalid_body", message: "members and ship have the wrong shape" });
      return;
    }
    respond(res, () => {
      const result = applyImport(deps.dir, {
        members: members.map((m): ApplyMember => ({ id: m.id.trim(), reuse: m.reuse, input: memberInput(m.input ?? {}) })),
        ship: { id: (body.ship as { id: string }).id.trim(), fields },
      });
      return result.ok ? { shipId: result.shipId, createdMembers: result.createdMembers } : { status: 400, body: { error: "invalid", errors: result.errors } };
    });
  });

  // The language for the UI (the same URL the ship app answers, so the shared UI code works unchanged).
  app.get("/api/config", (_req, res) => {
    const language = readLanguage(deps.dir);
    res.json({ language, crewLanguage: language, theme: readTheme(deps.dir) });
  });

  if (deps.clientDir) {
    const settingsHtml = path.join(deps.clientDir, "settings.html");
    if (fs.existsSync(settingsHtml)) {
      // `index: false`: the directory's index.html is the ship UI; `/` must give the settings page.
      app.use(express.static(deps.clientDir, { index: false }));
      app.get(/^(?!\/api(\/|$)).*/, (_req, res) => {
        res.sendFile(settingsHtml);
      });
    }
  }

  // Last of all: whatever else is thrown (a malformed body, an unexpected error) is a JSON answer, never an HTML page with a stack trace.
  app.use(createErrorHandler());

  return app;
}
