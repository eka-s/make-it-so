import type { MemoryStatus } from "./memory-document.js";

// The `index.md` of a directory of the Memory bundle: a table of contents the server writes itself after every change, so it never
// drifts from the files and the crew never has to keep it up. It lists only what is directly in its directory; the bundle root also
// leads to the subdirectories, so a reader (or a crew member) walks down from there.

export type IndexConcept = {
  /** File name inside the directory. */
  file: string;
  type: string;
  title: string;
  description: string;
  status: MemoryStatus;
  /** Bundle path (`/a/b.md`) of what replaces a deprecated concept. */
  supersededBy?: string;
};

export type IndexSubdir = { name: string; count: number };

/** Escapes what would end the text of a Markdown link. */
function linkText(text: string): string {
  return text.replace(/[[\]\\]/g, "\\$&");
}

function linkTarget(target: string): string {
  return target.replace(/ /g, "%20").replace(/\)/g, "%29");
}

function entryLine(concept: IndexConcept): string {
  const title = concept.title !== "" ? concept.title : concept.file;
  const parts = [`- [${linkText(title)}](${linkTarget(concept.file)})`];
  if (concept.description !== "") parts.push(`: ${concept.description.replace(/\s+/g, " ")}`);
  if (concept.status === "deprecated") {
    parts.push(concept.supersededBy ? ` (deprecated; superseded by [${linkText(concept.supersededBy)}](${linkTarget(concept.supersededBy)}))` : " (deprecated)");
  }
  return parts.join("");
}

/** The Markdown body of the `index.md` of one directory: subdirectories first, then its concepts, grouped by `type`. */
export function renderIndexBody(heading: string, concepts: IndexConcept[], subdirs: IndexSubdir[]): string {
  const lines = [`# ${heading}`, ""];
  if (subdirs.length > 0) {
    lines.push("## Directories", "");
    for (const dir of [...subdirs].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- [${linkText(dir.name)}/](${linkTarget(dir.name)}/index.md): ${dir.count} ${dir.count === 1 ? "concept" : "concepts"}`);
    }
    lines.push("");
  }
  const byType = new Map<string, IndexConcept[]>();
  for (const concept of concepts) {
    const group = byType.get(concept.type) ?? [];
    group.push(concept);
    byType.set(concept.type, group);
  }
  for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push(`## ${type}`, "");
    const group = byType.get(type) ?? [];
    group.sort((a, b) => (a.title || a.file).localeCompare(b.title || b.file) || a.file.localeCompare(b.file));
    for (const concept of group) lines.push(entryLine(concept));
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
