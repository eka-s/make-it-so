import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { LANGUAGE_NAMES, type Language } from "./language.js";

// This module does not depend on the ship config (config.ts). The ship root and the Skill directory are received
// from the caller as `SkillsContext` — if merely importing it loaded the ship config,
// the building of the guidance text could not be tested.
//
// make-it-so's own provider-neutral Skill mechanism. It does not depend on a special tool such as Claude Native Skills; it reproduces
// "progressive disclosure" with generic tools that crew members, including the commander, already have: the guidance text
// this module builds at session start tells them only the names of the available Skills + their trigger conditions
// (the equivalent of frontmatter). The body (the detailed instructions) is read by the model itself when it decides
// "this is relevant" — this side has no judgment logic whatsoever. A local crew member reads the Skill file; a remote
// host crew member, who does not have the main side's files, reads it with the `get_skill` tool (see `loadAnnouncedSkills`).

// Static, universal operating rules common to all personas (the content is always the same for everyone,
// so they do not go through the trigger-conditioned lazy loading that Skills use).
//
// With the relative path `workspace/` left as is, the model would be left room to interpret what it is relative to (cwd or
// the ship root) — a problem of the same kind found with real-machine tests on the accessNote of the targets mechanism.
// `projectRoot` (the ship root; it does not necessarily match cwd) is already known,
// so we simply build an absolute path and pass it.
const workspaceNote = (projectRoot: string): string =>
  `Put temporary files and free-form working files in ${path.join(projectRoot, "workspace")}.`;

// Task delegation works as a "bulletin board". The notice of a new task is only a short message and does not contain the actual instruction —
// this is a consequence of the design "no matter who delegates, the delivery path is always the same short notice", and is not a missing
// format. Everyone (commander and crew alike) may receive this notice, so it is placed in the common operating rules, not in a Skill.
const TASK_NOTIFICATION_NOTE = "When you receive a notification saying \"A new task has arrived\", read the task with the `get_task` tool (using the given taskId) before you start working on it.";

// report differs in nature from the user-defined Skills under `skills/` (it is not something the captain adds or
// removes at will; it is a function that make-it-so itself has from the start).
// It has no coupling with the mechanism any more (no marker is used), so only the visual format (screening rules, format, the message when there are 0 items)
// is kept in `report-format.md` (directly under the project root, outside the Skill discovery scan),
// so that the captain can edit it freely. Here we only guarantee, at all times, the awareness that "there is something to read".
// The path is made absolute for the same reason as `workspaceNote` (leave no room for interpretation).
//
// However, a ship created by `init` and the sample fleet do not have this file. If the crew were told to read a missing file,
// they would report "the file does not exist", so when the ship has no `report-format.md`, the default format is included in the guidance
// directly (DEFAULT_REPORT_FORMAT). If the ship has the file, that takes priority.
const reportFormatNote = (projectRoot: string): string => {
  const file = path.join(projectRoot, "report-format.md");
  if (fs.existsSync(file)) {
    return `When you make a "report", read ${file} and follow its formatting (that you should use the \`list_unreported_tasks\` tool is already clear from the tool's own description).`;
  }
  return `When you make a "report", use the \`list_unreported_tasks\` tool, then follow this format:\n${DEFAULT_REPORT_FORMAT}`;
};

/** Default report format used when the ship has no `report-format.md` (written in the crew's language). */
export const DEFAULT_REPORT_FORMAT = [
  "  - The tool is the only source of information; do not look for result files. If it returns no tasks, reply only that every task has already been reported.",
  "  - Do not leave out cautions or risks. Include what a crew member judged unnecessary, together with the reason, and the assumptions behind a conclusion. When in doubt, include it.",
  "  - For each task: the crew member and task id, a short summary of the result, then any cautions or risks as bullets.",
  "  - End with the points the captain has to decide (if any) and your own recommendation.",
].join("\n");

/**
 * The language the crew must speak (a setting of its own, separate from the UI language). The persona
 * files are written by the user and may be in another language, so this has to be explicit.
 */
export function languageNote(language: Language): string {
  return [
    "## Language",
    "",
    `Always respond in ${LANGUAGE_NAMES[language]}. This applies even if the captain writes to you in another language, and regardless of the language used in your persona or instructions. Use another language only if the captain explicitly asks you to.`,
  ].join("\n");
}

/** Ship information needed to build the guidance text (passed by the caller from the ship config). */
export type SkillsContext = {
  /** Ship root (where workspace/ and report-format.md live). */
  projectRoot: string;
  /** Directory for the ship's own Skills (`{projectRoot}/skills`). */
  skillsDir: string;
};

type SkillSummary = {
  name: string;
  description: string;
  // Absolute path of the skill.md itself. By embedding it in the guidance text as is, the model is spared the wasted
  // effort of exploring directories (Glob/ls, etc.) after it decides "this looks relevant" (the same policy as workspaceNote/reportFormatNote:
  // state absolute paths explicitly).
  path: string;
};

// The block at the top of a skill file: the YAML between the first two `---` lines.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Extracts only the YAML frontmatter (`name` + `description`) at the top of `skill.md`. The body is not read.
 * A value YAML reads as a number (`name: 123`) is taken as its text, so what is announced can be asked for by that name.
 */
export function parseFrontmatter(content: string): { name: string; description: string } | null {
  const match = content.match(FRONTMATTER);
  if (!match) return null;
  try {
    const data = parse(match[1]) as { name?: unknown; description?: unknown } | null;
    if (!data?.name || !data?.description) return null;
    return { name: String(data.name), description: String(data.description) };
  } catch {
    return null;
  }
}

/** The frontmatter of a skill file, or null when it is invalid or the file cannot be read (a file may vanish after the config was checked). */
function readSummary(file: string): { name: string; description: string } | null {
  try {
    return parseFrontmatter(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Scans under `skillsDir` and returns the list of available Skills.
 * Persona definitions live in `{fleetRoot}/personnel/` (on the fleet roster side, independent of the ship),
 * so under the ship's `skillsDir` there are only Skills. Only the frontmatter of the `skill.md` in each Skill directory is read —
 * the body is not read here.
 */
function listSkills(skillsDir: string): SkillSummary[] {
  if (!fs.existsSync(skillsDir)) return [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(skillsDir, entry.name, "skill.md");
    if (!fs.existsSync(skillMdPath)) continue;
    const summary = readSummary(skillMdPath);
    if (summary) skills.push({ ...summary, path: skillMdPath });
  }
  return skills;
}

/**
 * Reads the frontmatter of the skill files explicitly given in `skills:` of the roster/ship (absolute paths,
 * verified to exist in config.ts). The format is the same as the ship's `skills/*\/skill.md`
 * (`name` + `description`). A file with no/invalid frontmatter, or one that cannot be read any more, is excluded with a warning.
 */
function listExplicitSkills(files: string[]): SkillSummary[] {
  const skills: SkillSummary[] = [];
  for (const file of files) {
    const summary = readSummary(file);
    if (summary) skills.push({ ...summary, path: file });
    else console.warn(`[Skills] ${file} has no valid frontmatter (name/description), or cannot be read — skipping`);
  }
  return skills;
}

/** The skills announced to a crew member: the ship's `skills/` directory first, then the explicitly given files. On a name clash, the first one wins. */
function collectSkills(ctx: SkillsContext, extraSkillFiles: string[]): SkillSummary[] {
  const seen = new Set<string>();
  return [...listSkills(ctx.skillsDir), ...listExplicitSkills(extraSkillFiles)].filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}

/** The skills announced to one crew member, as `get_skill` serves them. */
export type AnnouncedSkills = {
  names: string[];
  /** The body (the file without its frontmatter) of the skill `name`, or undefined when it is not announced or cannot be read. */
  read: (name: string) => string | undefined;
};

/**
 * Scans once and returns what a crew member may read through `get_skill`. Only announced skills can be read, so a crew member
 * cannot use it to read other files, and nothing that fails to read shows a path to the crew.
 */
export function loadAnnouncedSkills(ctx: SkillsContext, extraSkillFiles: string[]): AnnouncedSkills {
  const skills = collectSkills(ctx, extraSkillFiles);
  return {
    names: skills.map((s) => s.name),
    read: (name) => {
      const skill = skills.find((s) => s.name === name);
      if (!skill) return undefined;
      try {
        return fs.readFileSync(skill.path, "utf-8").replace(FRONTMATTER, "").trim();
      } catch (err) {
        console.warn(`[Skills] ${skill.path} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    },
  };
}

/**
 * The common guidance prompt appended to the end of the persona at session start.
 * The two blocks of different nature — "fixed-text operating rules" and the "dynamic Skill list" —
 * are built separately and not mixed together.
 *
 * `extraSkillFiles` are the skills explicitly given for that member in the roster (personal)/ship. They are placed after the automatically
 * scanned ones from the ship's `skills/` directory (on a name clash, the first one wins).
 *
 * `options.remote` is for a crew member running on a remote host. The workspace and the report format point to
 * local paths on the main side, and the remote does not have those files, so they are left out (a current limitation).
 * The Skills are announced by name only, to be read with the `get_skill` tool instead of from a file.
 */
export function buildCommonAnnouncement(
  ctx: SkillsContext,
  extraSkillFiles: string[] = [],
  options: { remote?: boolean; language?: Language } = {},
): string {
  const languageSection = options.language ? ["", languageNote(options.language)] : [];
  const skills = collectSkills(ctx, extraSkillFiles);
  if (options.remote) {
    return [
      "## Common operating rules",
      "",
      `- ${TASK_NOTIFICATION_NOTE}`,
      ...(skills.length > 0
        ? ["", "## Available skills", "", "When you are asked to do related work, read the corresponding skill with the `get_skill` tool (pass its name) and follow it. It gives the text of the skill only: files it mentions beside it are not available to you.", "", ...skills.map((s) => `- ${s.name}: ${s.description}`)]
        : []),
      ...languageSection,
    ].join("\n");
  }
  const skillList = skills.length > 0
    ? skills.map((s) => `- ${s.name} (${s.path}): ${s.description}`).join("\n")
    : "(No skills are registered at the moment.)";

  return [
    "## Common operating rules",
    "",
    `- ${workspaceNote(ctx.projectRoot)}`,
    `- ${TASK_NOTIFICATION_NOTE}`,
    `- ${reportFormatNote(ctx.projectRoot)}`,
    "",
    "## Available skills",
    "",
    "When you are asked to do related work, read the corresponding `skill.md` file yourself and follow it.",
    "",
    skillList,
    ...languageSection,
  ].join("\n");
}

/**
 * Explanation of usage + the current crew roster table of the ship (excluding oneself), sent only to crew members who can issue tasks
 * (`dispatch_task`) (commander and chief). Separate from `buildCommonAnnouncement()`, which is common to all crew members.
 *
 * Only how to use the mechanism and its constraints are written (fixed content on the system side — if the captain rewrote it by mistake the mechanism
 * would break). Behavioral personality, such as "delegate everything" or "do the work yourself", is not written here but decided in the persona
 * file. The crew roster table is generated dynamically each time from the ship's composition (`crew`) (so that it does not
 * drift from the actual assignments in ship.yml).
 */
export function buildDispatchNote(crew: Record<string, { name: string }>, selfRole: string): string {
  const rows = Object.entries(crew)
    .filter(([role]) => role !== selfRole)
    .map(([role, member]) => `| ${role} | ${member.name} |`);

  return [
    "## Delegating tasks",
    "",
    "You can delegate work to other crew members with the `dispatch_task` tool. Never use the `Agent` tool for this: crew members are independent AI agents managed by the main process, and using the `Agent` tool bypasses the main process's crew management entirely, so the result is not kept in the system and is not shown in real time in the captain's UI (Bridge Console).",
    "",
    "Delegation procedure:",
    "1. Call `dispatch_task(agent, task_name, instruction)`",
    "2. The moment you call it, an ID is assigned and the assignee is notified automatically",
    "3. The result is recorded on the bulletin board (DB). Read it with `get_task(taskId)`",
    "",
    "## Current crew of the ship",
    "",
    "| agent | Crew member |",
    "|---|---|",
    ...rows,
  ].join("\n");
}
