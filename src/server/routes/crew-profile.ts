import express from "express";
import { buildBriefing, readPersonnelText, type BriefingDeps } from "../crew-briefing.js";
import { findAgentDefinition } from "../agent-definition.js";
import { deleteCrewIcon, findCrewIcon, MAX_ICON_BYTES, saveCrewIcon } from "../crew-icons.js";
import type { CrewHostInfo } from "../crew-hosts.js";
import type { CrewMemberConfig } from "../fleet-config.js";

// Routes for one crew member's "personnel record" (the profile on screen): fetching and changing the summary of settings, the persona contents, and the icon.
// The assembly is done on the server, and the client just renders what it receives.

export type CrewProfileRouterDeps = {
  /** The ship's crew (role name → crew config). */
  crew: Record<string, CrewMemberConfig>;
  /** Default provider when the roster does not specify one. */
  defaultProvider: string;
  /** Location of the fleet roster (where `personnel/` lives). */
  fleetRoot: string;
  /**
   * The home directory, where the provider's agent definitions (`.claude/agents` in the home, etc.) are looked up.
   */
  home: string;
  /**
   * What is needed to build the briefing. The crew's language can change, so it is fetched again on every call.
   */
  briefingDeps: () => BriefingDeps;
  /** Connection target display of a remote host's crew member. */
  hostInfo: (member: CrewMemberConfig) => CrewHostInfo;
};

/** Where the persona comes from and its contents. */
export type CrewPersona =
  /** The persona file that MIS injects (`personnel/{ID}.md`). */
  | { source: "personnel"; text: string; path: string }
  /** A crew member that specifies `agent:`. The provider's definition file was found. */
  | { source: "agent"; status: "found"; agent: string; text: string; path: string }
  /**
   * `agent:` is specified but the definition file cannot be read (not found, or a remote host's crew member).
   */
  | { source: "agent"; status: "not_found" | "remote"; agent: string }
  /** There is no persona file. */
  | { source: "none" };

/**
 * URL of the icon. A modification time is attached so that the URL changes when the image is replaced (an old image does not stay in the cache).
 */
export function crewIconUrl(role: string, icon: { mtimeMs: number } | null): string | undefined {
  return icon ? `/api/crew/${encodeURIComponent(role)}/icon?v=${Math.floor(icon.mtimeMs)}` : undefined;
}

export function createCrewProfileRouter(deps: CrewProfileRouterDeps): express.Router {
  const router = express.Router();

  function memberOf(role: string): CrewMemberConfig | undefined {
    return Object.prototype.hasOwnProperty.call(deps.crew, role) ? deps.crew[role] : undefined;
  }

  function personaOf(member: CrewMemberConfig, provider: string): CrewPersona {
    if (member.agent) {
      if (member.host) return { source: "agent", status: "remote", agent: member.agent };
      const found = findAgentDefinition({ provider, agent: member.agent, cwd: member.cwd, home: deps.home });
      return found
        ? { source: "agent", status: "found", agent: member.agent, ...found }
        : { source: "agent", status: "not_found", agent: member.agent };
    }
    const text = readPersonnelText(deps.fleetRoot, member);
    return text && member.acp_agent
      ? { source: "personnel", text, path: `personnel/${member.acp_agent}.md` }
      : { source: "none" };
  }

  // --- Profile (personnel record) ---
  router.get("/api/crew/:role/profile", (req, res) => {
    const { role } = req.params;
    const member = memberOf(role);
    if (!member) {
      res.status(404).json({ error: "Unknown crew role" });
      return;
    }
    const provider = member.provider ?? deps.defaultProvider;
    let briefing: string | null = null;
    let briefingError: string | undefined;
    try {
      briefing = buildBriefing(deps.briefingDeps(), member, role);
    } catch (err) {
      briefingError = err instanceof Error ? err.message : String(err);
    }
    res.json({
      role,
      name: member.name,
      rank: member.rank,
      memberId: member.acp_agent ?? null,
      provider,
      permissionMode: member.permissionMode ?? null,
      cwd: member.cwd,
      host: member.host ? deps.hostInfo(member) : null,
      persona: personaOf(member, provider),
      briefing,
      ...(briefingError ? { briefingError } : {}),
    });
  });

  // --- Icon ---
  router.get("/api/crew/:role/icon", (req, res) => {
    const member = memberOf(req.params.role);
    const icon = member?.acp_agent ? findCrewIcon(deps.fleetRoot, member.acp_agent) : null;
    if (!icon) {
      res.status(404).json({ error: "No icon" });
      return;
    }
    // Make it render as the image itself (do not let the content be interpreted as another kind)
    res.set({ "Content-Type": icon.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" });
    res.sendFile(icon.file);
  });

  // Receives the bytes of the image as the body as they are (the kind is decided from the leading bytes of the content).
  // If the limit is exceeded, 413 is returned here.
  const rawBody = express.raw({ type: () => true, limit: MAX_ICON_BYTES + 1 });
  router.put(
    "/api/crew/:role/icon",
    (req, res, next) => {
      rawBody(req, res, (err?: unknown) => {
        if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 413) {
          res.status(413).json({ error: "The image is too large", reason: "too_large" });
          return;
        }
        next(err);
      });
    },
    (req, res) => {
      const member = memberOf(req.params.role);
      if (!member?.acp_agent) {
        res.status(404).json({ error: "Unknown crew role" });
        return;
      }
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = saveCrewIcon(deps.fleetRoot, member.acp_agent, bytes);
      if (!result.ok) {
        const status = result.reason === "too_large" ? 413 : 400;
        res.status(status).json({ error: `The image was rejected (${result.reason})`, reason: result.reason });
        return;
      }
      res.json({ status: "ok", icon: crewIconUrl(req.params.role, findCrewIcon(deps.fleetRoot, member.acp_agent)) });
    },
  );

  router.delete("/api/crew/:role/icon", (req, res) => {
    const member = memberOf(req.params.role);
    if (!member?.acp_agent) {
      res.status(404).json({ error: "Unknown crew role" });
      return;
    }
    deleteCrewIcon(deps.fleetRoot, member.acp_agent);
    res.json({ status: "ok" });
  });

  return router;
}
