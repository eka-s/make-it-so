import { parse, stringify } from "yaml";

// A concept file of the Memory bundle: YAML frontmatter, then a Markdown body (OKF v0.3). Keys this module does not know are kept as
// they are when a file is written again, because the format asks consumers to tolerate and keep what they do not understand.

// A memo has no tags: it is kept by where it lives. A flag is all it can carry, and a memo with none is the normal, settled kind
// (`stable`), which is therefore not written to the file.
// OKF requires a `type`, which the format means for telling kinds of concept apart. A Memory is a notebook of memos written as they come
// to mind, where the kinds mix in one document, so the server writes one fixed value and the directory is the only classification.
export const MEMORY_TYPE = "note";
export const MEMORY_STATUSES = ["draft", "stable", "deprecated"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** The frontmatter keys this module reads and writes itself; every other key is kept untouched. */
const KNOWN_KEYS = ["type", "title", "description", "status", "superseded_by", "generated", "x-make-it-so-crew"];

export type MemoryFront = {
  type: string;
  title: string;
  description: string;
  status: MemoryStatus;
  supersededBy?: string;
  /** The tool that wrote it last (`generated.by`). */
  generatedBy?: string;
  /** When it was written last (`generated.at`). */
  generatedAt?: string;
  /** The crew member who wrote it last. */
  crew?: string;
  /** Keys of the file this module does not know. */
  extra: Record<string, unknown>;
};

export type ParsedMemoryFile = { front: MemoryFront; body: string; rawFront: string };

const FRONT_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

function asStatus(value: unknown): MemoryStatus {
  return (MEMORY_STATUSES as readonly string[]).includes(value as string) ? (value as MemoryStatus) : "stable";
}

/**
 * Reads a concept file. Null when it is not one: no frontmatter, a YAML error, or an empty `type` (a Markdown file without a type is
 * not a concept, so a file edited by hand into that shape drops out of the index instead of breaking it).
 */
export function parseMemoryFile(content: string): ParsedMemoryFile | null {
  const match = content.match(FRONT_BLOCK);
  if (!match) return null;
  let data: unknown;
  try {
    data = parse(match[1]);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const type = asString(record.type).trim();
  if (type === "") return null;
  const generated = typeof record.generated === "object" && record.generated !== null ? (record.generated as Record<string, unknown>) : {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!KNOWN_KEYS.includes(key)) extra[key] = value;
  }
  const supersededBy = asString(record.superseded_by).trim();
  return {
    front: {
      type,
      title: asString(record.title).trim(),
      description: asString(record.description).trim(),
      status: asStatus(record.status),
      ...(supersededBy !== "" ? { supersededBy } : {}),
      ...(generated.by !== undefined ? { generatedBy: asString(generated.by) } : {}),
      ...(generated.at !== undefined ? { generatedAt: asString(generated.at) } : {}),
      ...(record["x-make-it-so-crew"] !== undefined ? { crew: asString(record["x-make-it-so-crew"]) } : {}),
      extra,
    },
    body: content.slice(match[0].length),
    rawFront: match[1],
  };
}

/** The text of a concept file: the known keys in a fixed order, then the keys this module does not know. */
export function serializeMemoryFile(front: MemoryFront, body: string): string {
  const data: Record<string, unknown> = { type: front.type };
  if (front.title !== "") data.title = front.title;
  data.description = front.description;
  if (front.status !== "stable") data.status = front.status;
  if (front.supersededBy) data.superseded_by = front.supersededBy;
  if (front.generatedBy !== undefined || front.generatedAt !== undefined) {
    data.generated = {
      ...(front.generatedBy !== undefined ? { by: front.generatedBy } : {}),
      ...(front.generatedAt !== undefined ? { at: front.generatedAt } : {}),
    };
  }
  if (front.crew) data["x-make-it-so-crew"] = front.crew;
  Object.assign(data, front.extra);
  // lineWidth 0: a long description stays on one line, so a change shows as one line in the history.
  const yaml = stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}
