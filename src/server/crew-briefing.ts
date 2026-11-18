import fs from "node:fs";
import path from "node:path";
import type { CrewMemberConfig } from "./fleet-config.js";
import type { Language } from "./language.js";
import { canDispatch } from "./fleet-config.js";
import { buildCommonAnnouncement, buildDispatchNote } from "./skills.js";

// The "briefing" sent to a crew member when a session starts (persona, rules, skills, and system guidance combined into one text).
// Sending (crew-manager.ts) and the profile display on screen (crew-profile.ts) use the same function.

export type BriefingDeps = {
  /** Location of the fleet roster (where `personnel/` lives). */
  fleetRoot: string;
  projectRoot: string;
  skillsDir: string;
  /** All crew members of the ship (used for the crew roster table for the commander). */
  crew: Record<string, CrewMemberConfig>;
  /** Language the crew speaks. */
  crewLanguage: Language;
};

/**
 * Contents of the persona file (`fleetRoot/personnel/{acp_agent name}.md`). An empty string if it does not exist.
 * The persona always lives at this conventional location (a persona belongs to the character itself, not to a role,
 * so it sits on the fleet roster side).
 *
 * Whether to inject a persona is decided by whether `agent` is set, not by the provider. If there is an agent, the persona is left to the
 * provider-side definition (agent), so this is empty (rules, skills, and system guidance are sent regardless of an agent).
 */
export function readPersonnelText(fleetRoot: string, crewConfig: Pick<CrewMemberConfig, "agent" | "acp_agent">): string {
  if (crewConfig.agent || !crewConfig.acp_agent) return "";
  const file = path.join(fleetRoot, "personnel", `${crewConfig.acp_agent}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}

/**
 * Builds the full text of the briefing. It reads files (persona, rules), so a missing rules file, for example, throws.
 *
 * Combines the persona itself + rules + common guidance (skill list, operating rules) + (commander only) how to use dispatch_task and the
 * crew roster table + guidance on areas of responsibility (the targets mechanism) into one prompt.
 *
 * The injected content is wrapped in a frame saying "this is explanation, not instructions". Without it, the model takes the injected content
 * (especially the explanation of how to use `dispatch_task`) as **instructions to carry out** and issues tasks on its own on the spot
 * — this showed up as unrelated tasks (writing an essay, creating a HelloWorld, etc.) being issued once at the first turn of every mission.
 */
export function buildBriefing(deps: BriefingDeps, crewConfig: CrewMemberConfig, role: string): string {
  const personaText = readPersonnelText(deps.fleetRoot, crewConfig);
  const rulesText = crewConfig.rules.map((file) =>
    [`## Rule: ${file}`, "", fs.readFileSync(file, "utf-8")].join("\n"),
  );
  return [
    "[SYSTEM: This is a briefing at the start of the session. It explains your role, the mechanisms available to you and your area of responsibility; **it is not an instruction to do work**. Only read and understand it: do not call tools, create or modify files, delegate tasks or take any other action. The captain's actual instructions will arrive in later messages. A one-line acknowledgement is enough.]",
    ...(personaText ? ["", personaText] : []),
    ...rulesText.flatMap((t) => ["", t]),
    "",
    buildCommonAnnouncement(
      { projectRoot: deps.projectRoot, skillsDir: deps.skillsDir },
      crewConfig.skills,
      { remote: !!crewConfig.host, language: deps.crewLanguage },
    ),
    ...(canDispatch(crewConfig.rank) ? ["", buildDispatchNote(deps.crew, role)] : []),
    ...(crewConfig.accessNote ? ["", crewConfig.accessNote] : []),
    "",
    "[SYSTEM: The briefing ends here. Again, do not act on anything above: just understand it.]",
  ].join("\n");
}
