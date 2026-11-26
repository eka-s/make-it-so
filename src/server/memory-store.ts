import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import git from "isomorphic-git";
import { stringify } from "yaml";
import { lineDiff } from "./memory-diff.js";
import { MEMORY_STATUSES, parseMemoryFile, serializeMemoryFile, type MemoryFront, type MemoryStatus } from "./memory-document.js";
import { renderIndexBody, type IndexConcept } from "./memory-index-md.js";
import { memoryDirOf, memoryDirProblem, memoryDirsUp, memoryPathProblem } from "./memory-path.js";
import { insideRoot, isRealDirectory, linkInPath, MAX_MEMORY_FILE_BYTES, readRegularFile, writeFileAtomic } from "./memory-files.js";
import { mkdirPrivate } from "./private-dirs.js";

// The Memory of a ship: an OKF bundle (a directory of Markdown files) the crew writes through MCP tools and the captain reads in the
// viewer. The files are the truth and git keeps the history (one commit per change); SQLite only holds what is read from the files,
// for listing and searching, and can be filled again from them at any time.
//
// Every change goes through one queue, so two crew members writing at once are applied one after the other, and a write that quotes an
// out-of-date version of a file is refused instead of overwriting what another wrote.

/** Past these, a write still succeeds but says so: the point is to notice, not to forbid. */
export const MEMORY_BODY_WARN_BYTES = 1024 * 1024;
export const MEMORY_COUNT_WARN = 50_000;
/** The version of OKF the bundle is written in. */
const OKF_VERSION = "0.3";
const ROOT_INDEX = "index.md";
const COMMIT_EMAIL = "memory@make-it-so.local";
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
/** A diff longer than this is cut, so one history call cannot flood a crew member's context. */
const MAX_DIFF_CHARS = 20_000;
const REBUILD_BATCH = 500;
const MAX_QUERY_CHARS = 1000;
const MAX_QUERY_TERMS = 32;
const MAX_QUERY_TAGS = 20;
// A word under three characters is searched by scanning every body, so only a few are looked at.
const MAX_SHORT_TERMS = 4;
/** How far back the history of a deleted memo is looked for. */
const SCAN_COMMITS = 1000;

export type MemoryErrorCode = "invalid" | "conflict" | "not_found";

export class MemoryError extends Error {
  /** For `conflict`: what the file holds now, so the caller can merge and try again. */
  current?: MemoryDocument;
  constructor(readonly code: MemoryErrorCode, message: string, current?: MemoryDocument) {
    super(message);
    this.name = "MemoryError";
    this.current = current;
  }
}

export type MemorySummary = {
  path: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  status: MemoryStatus;
  supersededBy?: string;
  crew?: string;
  updatedAt?: string;
};

export type MemoryDocument = MemorySummary & {
  /** The frontmatter as it is in the file (YAML text), for the viewer to show as it is. */
  frontmatter: string;
  body: string;
  /** The git blob id of the file: a write that updates the file quotes it as `base`. */
  version: string;
};

export type MemoryWriteInput = {
  path: string;
  type: string;
  title?: string;
  description: string;
  body: string;
  tags?: string[];
  status?: MemoryStatus;
  /** The change in a sentence: it becomes the commit message. */
  message: string;
  /** The crew member writing. */
  crew: string;
  /** The `version` read before; required when the file exists. */
  base?: string;
};

export type MemoryWriteResult = { path: string; version: string; created: boolean; warnings: string[] };

export type MemorySearchQuery = {
  query?: string;
  type?: string;
  tags?: string[];
  statuses?: MemoryStatus[];
  /** Only paths that start with this. */
  pathPrefix?: string;
  limit?: number;
  offset?: number;
};

export type MemoryBrowse = {
  dir: string;
  dirs: Array<{ name: string; path: string; count: number }>;
  docs: MemorySummary[];
};

export type MemoryHistoryEntry = { commit: string; message: string; author: string; at: string; diff?: string };

export type MemoryStoreDeps = {
  /** The bundle: `<ship>/knowledge`. Created when something is first written. */
  dir: string;
  /** Where the search index lives (it must already be migrated). */
  db: DatabaseSync;
  /** Shown as the title of the bundle's root index. */
  shipName: string;
  /** Who wrote it, as OKF records it: `make-it-so/<version>`. */
  producer: string;
  now?: () => Date;
  /** Called after the bundle changed, so the viewer can be told. */
  onChange?: () => void;
  log?: (message: string) => void;
};

type DocRow = {
  path: string;
  dir: string;
  type: string;
  title: string;
  description: string;
  tags_json: string;
  status: string;
  superseded_by: string | null;
  crew: string | null;
  updated_at: string | null;
  version: string;
  size: number;
};

const SUMMARY_COLUMNS = "d.path, d.dir, d.type, d.title, d.description, d.tags_json, d.status, d.superseded_by, d.crew, d.updated_at, d.version, d.size";

function toSummary(row: DocRow): MemorySummary {
  return {
    path: row.path,
    type: row.type,
    title: row.title,
    description: row.description,
    tags: JSON.parse(row.tags_json) as string[],
    status: row.status as MemoryStatus,
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.crew ? { crew: row.crew } : {}),
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

/** The git blob id of a file's bytes, computed here so a version never needs git to be read. */
function blobId(content: Buffer): string {
  return crypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "ENOENT" || (err as { name?: string } | null)?.name === "NotFoundError";
}

export function createMemoryStore(deps: MemoryStoreDeps) {
  const { dir, db } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  let repoReady = false;
  let queue: Promise<unknown> = Promise.resolve();

  /** Runs `job` after every job queued before it has finished, whether those succeeded or not. */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function absolute(rel: string): string {
    return path.join(dir, ...rel.split("/"));
  }

  function timestamp(): string {
    return now().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /** A directory or file of the bundle that is a link is not followed: a link could lead a write out of the bundle. */
  function assertNoLinks(rel: string): void {
    if (linkInPath(dir, rel)) throw new MemoryError("invalid", "The path goes through a symbolic link, which is not followed.");
  }

  // --- The search index ---

  function transaction(work: () => void): void {
    db.exec("BEGIN");
    try {
      work();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function rowOf(rel: string): { rowid: number; version: string } | undefined {
    return db.prepare("SELECT rowid, version FROM memory_docs WHERE path = ?").get(rel) as { rowid: number; version: string } | undefined;
  }

  function upsertDoc(rel: string, front: MemoryFront, body: string, version: string, size: number): void {
    const values = [memoryDirOf(rel), front.type, front.title, front.description, JSON.stringify(front.tags), front.status, front.supersededBy ?? null, front.crew ?? null, front.generatedAt ?? null, version, size, body] as SQLInputValue[];
    const existing = rowOf(rel);
    let rowid: number;
    if (existing) {
      rowid = existing.rowid;
      db.prepare("UPDATE memory_docs SET dir = ?, type = ?, title = ?, description = ?, tags_json = ?, status = ?, superseded_by = ?, crew = ?, updated_at = ?, version = ?, size = ?, body = ? WHERE path = ?").run(...values, rel);
      db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(rowid);
    } else {
      const result = db.prepare("INSERT INTO memory_docs (path, dir, type, title, description, tags_json, status, superseded_by, crew, updated_at, version, size, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(rel, ...values);
      rowid = Number(result.lastInsertRowid);
    }
    db.prepare("INSERT INTO memory_fts (rowid, title, description, tags, body) VALUES (?, ?, ?, ?, ?)").run(rowid, front.title, front.description, front.tags.join(" "), body);
  }

  function deleteDoc(rel: string): void {
    const existing = rowOf(rel);
    if (!existing) return;
    db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(existing.rowid);
    db.prepare("DELETE FROM memory_docs WHERE path = ?").run(rel);
  }

  function countDocs(): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM memory_docs").get() as { n: number }).n;
  }

  // --- index.md of each directory ---

  function conceptsIn(directory: string): IndexConcept[] {
    const rows = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM memory_docs d WHERE d.dir = ?`).all(directory) as DocRow[];
    return rows.map((row) => ({
      file: row.path.slice(directory === "" ? 0 : directory.length + 1),
      type: row.type,
      title: row.title,
      description: row.description,
      status: row.status as MemoryStatus,
      ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    }));
  }

  /** The directories directly under `directory` that hold concepts (at any depth), with how many. */
  function subdirsOf(directory: string): Array<{ name: string; count: number }> {
    const prefix = directory === "" ? "" : `${directory}/`;
    const rows = db.prepare("SELECT dir FROM memory_docs WHERE dir LIKE ? ESCAPE '\\' AND dir <> ?").all(`${escapeLike(prefix)}%`, directory) as Array<{ dir: string }>;
    const counts = new Map<string, number>();
    for (const row of rows) {
      const name = row.dir.slice(prefix.length).split("/")[0];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count }));
  }

  function renderIndexFile(directory: string): string | null {
    const concepts = conceptsIn(directory);
    const subdirs = subdirsOf(directory);
    if (directory !== "" && concepts.length === 0 && subdirs.length === 0) return null;
    const body = renderIndexBody(directory === "" ? deps.shipName : directory, concepts, subdirs);
    if (directory !== "") return body;
    // The root keeps its own frontmatter (the captain may have added to it); a bundle without one gets the minimum.
    const existing = readRegularFile(absolute(ROOT_INDEX));
    const front = existing.kind === "ok" ? existing.content.toString("utf-8").match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0] : undefined;
    return `${front ?? `---\n${stringify({ okf_version: OKF_VERSION, title: deps.shipName }, { lineWidth: 0 })}---\n`}${body}`;
  }

  /**
   * Brings the `index.md` of these directories up to date; returns every one that exists afterwards (`present`) and the ones it removed
   * (bundle paths). `present` includes files that were already right: one that a rebuild fixed earlier, without a commit, is committed
   * with the next change in its directory.
   */
  function syncIndexes(directories: string[]): { present: string[]; removed: string[] } {
    const present: string[] = [];
    const removed: string[] = [];
    for (const directory of directories) {
      // A directory that is a link (swapped in after it was indexed) is left alone: nothing in it is the bundle's to write or delete.
      if (directory !== "" && linkInPath(dir, directory)) continue;
      const rel = directory === "" ? ROOT_INDEX : `${directory}/${ROOT_INDEX}`;
      const file = absolute(rel);
      const content = renderIndexFile(directory);
      if (content === null) {
        let exists = true;
        try { fs.lstatSync(file); } catch { exists = false; }
        if (exists) {
          // Removing a link removes the link, not what it points to.
          try { fs.rmSync(file); } catch { continue; }
          removed.push(rel);
          try { fs.rmdirSync(absolute(directory)); } catch { /* not empty: it holds files that are not concepts */ }
        }
        continue;
      }
      const current = readRegularFile(file);
      present.push(rel);
      if (current.kind === "ok" && current.content.toString("utf-8") === content) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(dir, file, content);
    }
    return { present, removed };
  }

  // --- git ---

  async function ensureRepo(): Promise<void> {
    if (repoReady) return;
    mkdirPrivate(dir);
    const gitDir = path.join(dir, ".git");
    let exists = true;
    try { fs.lstatSync(gitDir); } catch { exists = false; }
    if (!exists) {
      await git.init({ fs, dir, defaultBranch: "main" });
      const { present } = syncIndexes([""]);
      await commitFiles("Create the memory bundle", "make-it-so", present, []);
    }
    repoReady = true;
  }

  async function commitFiles(message: string, author: string, changed: string[], removed: string[]): Promise<void> {
    // git reads the working tree itself and follows links there: anything that is not an ordinary file inside the bundle is left out.
    changed = changed.filter((file) => !linkInPath(dir, file) && readRegularFile(absolute(file)).kind === "ok");
    for (const file of changed) await git.add({ fs, dir, filepath: file });
    for (const file of removed) await git.remove({ fs, dir, filepath: file });
    await git.commit({ fs, dir, message, author: { name: author, email: COMMIT_EMAIL, timestamp: Math.floor(now().getTime() / 1000) } });
  }

  // --- Reading ---

  /** A memo as the file holds it, or undefined when there is no such file, it is not an ordinary one, it is too large, or it is not a memo. */
  function readParsed(rel: string): { content: Buffer; parsed: NonNullable<ReturnType<typeof parseMemoryFile>> } | undefined {
    const file = readRegularFile(absolute(rel));
    if (file.kind !== "ok") return undefined;
    const parsed = parseMemoryFile(file.content.toString("utf-8"));
    return parsed ? { content: file.content, parsed } : undefined;
  }

  function readDocument(rel: string): MemoryDocument | undefined {
    const read = readParsed(rel);
    if (!read) return undefined;
    const { content, parsed } = read;
    const { front } = parsed;
    return {
      path: rel,
      type: front.type,
      title: front.title,
      description: front.description,
      tags: front.tags,
      status: front.status,
      ...(front.supersededBy ? { supersededBy: front.supersededBy } : {}),
      ...(front.crew ? { crew: front.crew } : {}),
      ...(front.generatedAt ? { updatedAt: front.generatedAt } : {}),
      frontmatter: parsed.rawFront,
      body: parsed.body,
      version: blobId(content),
    };
  }

  function read(raw: string): MemoryDocument | undefined {
    const rel = raw.normalize("NFC");
    if (memoryPathProblem(rel) !== null) return undefined;
    assertNoLinks(rel);
    return readDocument(rel);
  }

  // --- Writing ---

  function checkInput(input: MemoryWriteInput): { type: string; title: string; description: string; message: string; tags: string[] | undefined } {
    const problem = memoryPathProblem(input.path);
    if (problem) throw new MemoryError("invalid", problem);
    const type = oneLine(input.type ?? "");
    if (type === "" || type.length > 64) throw new MemoryError("invalid", "`type` is required (a short word such as note, procedure, decision, reference, issue or glossary, up to 64 characters).");
    const description = oneLine(input.description ?? "");
    if (description === "") throw new MemoryError("invalid", "`description` is required: one line saying what the memo is and when it helps.");
    const title = oneLine(input.title ?? "");
    if (title.length > 200) throw new MemoryError("invalid", "`title` is longer than 200 characters.");
    const message = oneLine(input.message ?? "");
    if (message === "") throw new MemoryError("invalid", "`message` is required: the change in a sentence.");
    if (input.status !== undefined && !MEMORY_STATUSES.includes(input.status)) throw new MemoryError("invalid", `\`status\` must be one of ${MEMORY_STATUSES.join(", ")}.`);
    let tags: string[] | undefined;
    if (input.tags !== undefined) {
      tags = [...new Set(input.tags.map(oneLine).filter((tag) => tag !== ""))];
      if (tags.length > 50 || tags.some((tag) => tag.length > 64)) throw new MemoryError("invalid", "`tags` takes up to 50 tags of up to 64 characters.");
    }
    if (oneLine(input.crew ?? "") === "") throw new MemoryError("invalid", "The writer could not be identified.");
    return { type, title, description, message, tags };
  }

  /** Writes a concept file, records it in the index, brings the index.md files up to date, and commits all of that as one change. */
  async function persist(rel: string, front: MemoryFront, body: string, message: string, crew: string): Promise<{ version: string; warnings: string[] }> {
    const warnings: string[] = [];
    const content = serializeMemoryFile(front, body);
    const bytes = Buffer.from(content, "utf-8");
    const version = blobId(bytes);
    try {
      assertNoLinks(rel);
      fs.mkdirSync(path.dirname(absolute(rel)), { recursive: true });
      writeFileAtomic(dir, absolute(rel), bytes);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOTDIR" || code === "EISDIR" || code === "EEXIST") throw new MemoryError("invalid", "A file and a directory of the bundle have the same name along this path.");
      throw err;
    }
    let changed: string[] = [rel];
    let removed: string[] = [];
    try {
      transaction(() => upsertDoc(rel, front, body, version, bytes.length));
      const indexes = syncIndexes(memoryDirsUp(memoryDirOf(rel)));
      changed = [rel, ...indexes.present];
      removed = indexes.removed;
    } catch (err) {
      log(`[Memory] The search index could not be updated for ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      warnings.push("The search index could not be updated for this memo; it is filled again from the files at the next start.");
    }
    try {
      await commitFiles(message, crew, changed, removed);
    } catch (err) {
      log(`[Memory] The history could not be recorded for ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      warnings.push("The memo was saved, but the history could not be recorded.");
    }
    if (bytes.length > MEMORY_BODY_WARN_BYTES) warnings.push(`This memo is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, over the 1 MB guide: consider splitting it.`);
    const total = countDocs();
    if (total > MEMORY_COUNT_WARN) warnings.push(`The bundle holds ${total} memos, over the ${MEMORY_COUNT_WARN} guide: consider deprecating or deleting memos nobody needs.`);
    deps.onChange?.();
    return { version, warnings };
  }

  /**
   * An existing path that is the same as `rel` or one of its directories except for letter case. The disk of a Mac or a Windows machine
   * treats such names as one, so writing both would put two memos in one directory and make a mess of the index.md files.
   */
  function caseClash(rel: string): string | undefined {
    // SQLite folds the case of ASCII letters only; a name with other letters (Ä, É, ...) is compared here, over every path.
    // eslint-disable-next-line no-control-regex
    if (/[^\u0000-\u007f]/.test(rel)) {
      const folded = rel.toLowerCase();
      const all = db.prepare("SELECT path FROM memory_docs").all() as Array<{ path: string }>;
      for (const { path: existing } of all) {
        if (existing === rel) continue;
        const lower = existing.toLowerCase();
        for (let at = folded.indexOf("/"); ; at = folded.indexOf("/", at + 1)) {
          const end = at < 0 ? folded.length : at + 1;
          if (lower.startsWith(folded.slice(0, end)) && !existing.startsWith(rel.slice(0, end))) return existing.slice(0, end);
          if (at < 0) break;
        }
      }
      return undefined;
    }
    const segments = rel.split("/");
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join("/") + (i < segments.length ? "/" : "");
      const row = db.prepare("SELECT path FROM memory_docs WHERE lower(substr(path, 1, ?)) = lower(?) AND substr(path, 1, ?) <> ? LIMIT 1").get(prefix.length, prefix, prefix.length, prefix) as { path: string } | undefined;
      if (row) return row.path.slice(0, prefix.length);
    }
    return undefined;
  }

  function write(raw: MemoryWriteInput): Promise<MemoryWriteResult> {
    // The same name in another Unicode form (a Mac may hand back the decomposed one) must be the same memo.
    const input = { ...raw, path: raw.path.normalize("NFC") };
    return enqueue(async () => {
      const checked = checkInput(input);
      assertNoLinks(input.path);
      await ensureRepo();
      const clash = caseClash(input.path);
      if (clash) throw new MemoryError("invalid", `${clash} already exists and differs from this path only by letter case.`);
      const existing = readDocument(input.path);
      // A file that is there but is not a memo (a hand edit took its frontmatter away) is not replaced either: it is not ours to overwrite blindly.
      let onDisk = true;
      try { fs.lstatSync(absolute(input.path)); } catch { onDisk = false; }
      if (!existing && onDisk) {
        throw new MemoryError("conflict", `${input.path} exists but is not a valid memo (no frontmatter with a type). Choose another path, or ask the captain to fix the file.`);
      }
      if (!existing && input.base !== undefined) {
        throw new MemoryError("conflict", "The memo was deleted since you read it. Write it without `base` to create it again.");
      }
      if (existing && input.base !== existing.version) {
        throw new MemoryError("conflict", input.base === undefined ? "This memo already exists: read it with read_memory and pass its `version` as `base` to update it." : "The memo was changed by someone else since you read it (its version no longer matches `base`). Read it again and apply your change to the current text.", existing);
      }
      const previous = existing ? (readParsed(input.path)?.parsed ?? null) : null;
      const front: MemoryFront = {
        type: checked.type,
        title: checked.title,
        description: checked.description,
        tags: checked.tags ?? previous?.front.tags ?? [],
        status: input.status ?? previous?.front.status ?? "stable",
        ...(previous?.front.supersededBy && (input.status ?? previous.front.status) === "deprecated" ? { supersededBy: previous.front.supersededBy } : {}),
        generatedBy: deps.producer,
        generatedAt: timestamp(),
        crew: input.crew,
        extra: previous?.front.extra ?? {},
      };
      const { version, warnings } = await persist(input.path, front, input.body ?? "", checked.message, input.crew);
      return { path: input.path, version, created: !existing, warnings };
    });
  }

  function deprecate(raw: { path: string; supersededBy?: string; message: string; crew: string }): Promise<MemoryWriteResult> {
    const input = { ...raw, path: raw.path.normalize("NFC") };
    return enqueue(async () => {
      const problem = memoryPathProblem(input.path);
      if (problem) throw new MemoryError("invalid", problem);
      const message = oneLine(input.message ?? "");
      if (message === "") throw new MemoryError("invalid", "`message` is required: the change in a sentence.");
      if (oneLine(input.crew ?? "") === "") throw new MemoryError("invalid", "The writer could not be identified.");
      const replacement = input.supersededBy?.trim();
      if (replacement !== undefined && replacement !== "" && (!replacement.startsWith("/") || memoryPathProblem(replacement.slice(1)) !== null)) {
        throw new MemoryError("invalid", "`superseded_by` must be the bundle path of the memo that replaces this one, starting with / (for example /procedures/deploy-v2.md).");
      }
      assertNoLinks(input.path);
      await ensureRepo();
      const parsed = readParsed(input.path)?.parsed;
      if (!parsed) throw new MemoryError("not_found", `There is no memo at ${input.path}.`);
      const front: MemoryFront = {
        ...parsed.front,
        status: "deprecated",
        ...(replacement ? { supersededBy: replacement } : {}),
        generatedBy: deps.producer,
        generatedAt: timestamp(),
        crew: input.crew,
      };
      const { version, warnings } = await persist(input.path, front, parsed.body, message, input.crew);
      return { path: input.path, version, created: false, warnings };
    });
  }

  function remove(raw: { path: string; message: string; crew: string }): Promise<{ path: string }> {
    const input = { ...raw, path: raw.path.normalize("NFC") };
    return enqueue(async () => {
      const problem = memoryPathProblem(input.path);
      if (problem) throw new MemoryError("invalid", problem);
      const message = oneLine(input.message ?? "");
      if (message === "") throw new MemoryError("invalid", "`message` is required: the change in a sentence.");
      if (oneLine(input.crew ?? "") === "") throw new MemoryError("invalid", "The writer could not be identified.");
      assertNoLinks(input.path);
      await ensureRepo();
      if (!readDocument(input.path)) throw new MemoryError("not_found", `There is no memo at ${input.path}.`);
      // Checked again right before the delete: the directory may have been swapped for a link while the repository was being opened.
      if (linkInPath(dir, input.path) || !insideRoot(dir, absolute(input.path))) throw new MemoryError("invalid", "The path goes through a symbolic link, which is not followed.");
      fs.rmSync(absolute(input.path), { force: true });
      let changed: string[] = [];
      let removed: string[] = [input.path];
      try {
        transaction(() => deleteDoc(input.path));
        const indexes = syncIndexes(memoryDirsUp(memoryDirOf(input.path)));
        changed = indexes.present;
        removed = [input.path, ...indexes.removed];
      } catch (err) {
        log(`[Memory] The search index could not be updated for ${input.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await commitFiles(message, input.crew, changed, removed);
      } catch (err) {
        log(`[Memory] The history could not be recorded for ${input.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      deps.onChange?.();
      return { path: input.path };
    });
  }

  // --- Searching and browsing ---

  function filterClauses(query: Pick<MemorySearchQuery, "type" | "tags" | "statuses" | "pathPrefix">, clauses: string[], params: SQLInputValue[]): void {
    if (query.type) { clauses.push("d.type = ?"); params.push(query.type); }
    for (const tag of (query.tags ?? []).slice(0, MAX_QUERY_TAGS)) { clauses.push("EXISTS (SELECT 1 FROM json_each(d.tags_json) WHERE value = ?)"); params.push(tag); }
    if (query.statuses && query.statuses.length > 0) {
      clauses.push(`d.status IN (${query.statuses.map(() => "?").join(", ")})`);
      params.push(...query.statuses);
    }
    if (query.pathPrefix) { clauses.push("d.path LIKE ? ESCAPE '\\'"); params.push(`${escapeLike(query.pathPrefix.replace(/^\//, ""))}%`); }
  }

  function search(query: MemorySearchQuery): { total: number; items: MemorySummary[] } {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    const ftsTerms: string[] = [];
    let shortTerms = 0;
    // A query is a few words; the caps keep one of a hundred thousand from tying the server up.
    for (const term of (query.query ?? "").slice(0, MAX_QUERY_CHARS).split(/\s+/).filter((t) => t !== "").slice(0, MAX_QUERY_TERMS)) {
      if ([...term].length >= 3) {
        ftsTerms.push(`"${term.replace(/"/g, '""')}"`);
      } else if (shortTerms++ < MAX_SHORT_TERMS) {
        // Too short for the trigram index: look at the text itself.
        const like = `%${escapeLike(term)}%`;
        clauses.push("(d.title LIKE ? ESCAPE '\\' OR d.description LIKE ? ESCAPE '\\' OR d.tags_json LIKE ? ESCAPE '\\' OR d.body LIKE ? ESCAPE '\\')");
        params.push(like, like, like, like);
      }
    }
    const matchParams: SQLInputValue[] = [];
    let from = "memory_docs d";
    let order = "d.path";
    if (ftsTerms.length > 0) {
      from = "memory_fts f JOIN memory_docs d ON d.rowid = f.rowid";
      clauses.unshift("memory_fts MATCH ?");
      matchParams.push(ftsTerms.join(" AND "));
      order = "f.rank, d.path";
    }
    filterClauses(query, clauses, params);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const all = [...matchParams, ...params];
    const limit = Math.min(Math.max(Math.floor(query.limit ?? DEFAULT_SEARCH_LIMIT), 1), MAX_SEARCH_LIMIT);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${where}`).get(...all) as { n: number }).n;
    const rows = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM ${from} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...all, limit, offset) as DocRow[];
    return { total, items: rows.map(toSummary) };
  }

  /** What is directly in one directory: its subdirectories (with how many memos each holds) and its memos. */
  function browse(directory: string, statuses?: MemoryStatus[]): MemoryBrowse {
    const problem = memoryDirProblem(directory);
    if (problem) throw new MemoryError("invalid", problem);
    const filter = { statuses };
    const clauses = ["d.dir = ?"];
    const params: SQLInputValue[] = [directory];
    filterClauses(filter, clauses, params);
    const rows = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM memory_docs d WHERE ${clauses.join(" AND ")} ORDER BY d.type, d.title, d.path`).all(...params) as DocRow[];

    const prefix = directory === "" ? "" : `${directory}/`;
    const deepClauses = ["d.dir LIKE ? ESCAPE '\\'", "d.dir <> ?"];
    const deepParams: SQLInputValue[] = [`${escapeLike(prefix)}%`, directory];
    filterClauses(filter, deepClauses, deepParams);
    const deep = db.prepare(`SELECT d.dir FROM memory_docs d WHERE ${deepClauses.join(" AND ")}`).all(...deepParams) as Array<{ dir: string }>;
    const counts = new Map<string, number>();
    for (const row of deep) {
      const name = row.dir.slice(prefix.length).split("/")[0];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const dirs = [...counts].map(([name, count]) => ({ name, path: `${prefix}${name}`, count })).sort((a, b) => a.name.localeCompare(b.name));
    return { dir: directory, dirs, docs: rows.map(toSummary) };
  }

  // --- History ---

  async function blobAt(oid: string | undefined, filepath: string): Promise<string | undefined> {
    if (!oid) return undefined;
    try {
      return (await git.readBlob({ fs, dir, oid, filepath })).oid;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /** The commits that changed `filepath`, newest first, looking back from `from` (the latest commit when omitted). */
  async function commitsTouching(filepath: string, limit: number, from?: string): Promise<Awaited<ReturnType<typeof git.log>>> {
    const recent = await git.log({ fs, dir, depth: SCAN_COMMITS, ...(from ? { ref: from } : {}) });
    const blobs = new Map<string, string | undefined>();
    const blobOf = async (oid: string | undefined): Promise<string | undefined> => {
      if (!oid) return undefined;
      if (!blobs.has(oid)) blobs.set(oid, await blobAt(oid, filepath));
      return blobs.get(oid);
    };
    const touching: typeof recent = [];
    for (const entry of recent) {
      if (touching.length >= limit) break;
      if ((await blobOf(entry.oid)) !== (await blobOf(entry.commit.parent[0]))) touching.push(entry);
    }
    return touching;
  }

  async function history(raw: { path?: string; limit?: number; diff?: boolean }): Promise<MemoryHistoryEntry[]> {
    const input = { ...raw, path: raw.path?.normalize("NFC") };
    if (input.path !== undefined) {
      const problem = memoryPathProblem(input.path);
      if (problem) throw new MemoryError("invalid", problem);
    }
    if (!isRealDirectory(path.join(dir, ".git"))) return [];
    const depth = Math.min(Math.max(Math.floor(input.limit ?? DEFAULT_HISTORY_LIMIT), 1), MAX_HISTORY_LIMIT);
    let commits: Awaited<ReturnType<typeof git.log>>;
    try {
      commits = await git.log({ fs, dir, depth, ...(input.path ? { filepath: input.path } : {}) });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      // git cannot follow a path that no longer exists at the latest commit, and the history of a deleted memo is kept on purpose:
      // look through the recent commits for the ones that changed it.
      commits = input.path ? await commitsTouching(input.path, depth) : [];
    }
    // git stops following a path at the commit that deleted it, so the earlier life of a memo that was deleted and written again is looked
    // for in the commits before the oldest one it returned.
    const oldest = commits[commits.length - 1];
    if (input.path && oldest && commits.length < depth && oldest.commit.parent[0]) {
      commits = [...commits, ...(await commitsTouching(input.path, depth - commits.length, oldest.commit.parent[0]))];
    }
    const textAt = async (oid: string | undefined): Promise<string> => {
      if (!oid || !input.path) return "";
      try {
        const { blob } = await git.readBlob({ fs, dir, oid, filepath: input.path });
        return Buffer.from(blob).toString("utf-8");
      } catch (err) {
        if (isNotFound(err)) return "";
        throw err;
      }
    };
    const entries: MemoryHistoryEntry[] = [];
    for (const { oid, commit } of commits) {
      const entry: MemoryHistoryEntry = {
        commit: oid.slice(0, 10),
        message: commit.message.trim(),
        author: commit.author.name,
        at: new Date(commit.author.timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      };
      if (input.diff && input.path) {
        const text = lineDiff(await textAt(commit.parent[0]), await textAt(oid));
        entry.diff = text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n... (the diff is cut here)` : text;
      }
      entries.push(entry);
    }
    return entries;
  }

  // --- Filling the index from the files ---

  /** Reads the bundle from disk into the search index (what hand edits made since the last start included) and fixes the index.md files. */
  function rebuild(): Promise<{ count: number }> {
    return enqueue(async () => {
      const seen = new Set<string>();
      async function walk(rel: string): Promise<void> {
        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(rel === "" ? dir : absolute(rel), { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
          const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) await walk(childRel);
          else if (entry.isFile() && memoryPathProblem(childRel) === null) seen.add(childRel);
        }
      }
      await walk("");

      const known = new Map((db.prepare("SELECT path, version FROM memory_docs").all() as Array<{ path: string; version: string }>).map((r) => [r.path, r.version]));
      const paths = [...seen];
      const indexed = new Set<string>();
      for (let start = 0; start < paths.length; start += REBUILD_BATCH) {
        // Between batches the server answers what is waiting, so a large Memory does not hold it still.
        if (start > 0) await new Promise<void>((resolve) => setImmediate(resolve));
        // Read inside the transaction, one file at a time, so a batch never holds more than one file in memory.
        transaction(() => {
          for (const rel of paths.slice(start, start + REBUILD_BATCH)) {
            // A directory may have been swapped for a link since the walk.
            if (linkInPath(dir, rel)) continue;
            let file: ReturnType<typeof readRegularFile>;
            try {
              file = readRegularFile(absolute(rel));
            } catch (err) {
              log(`[Memory] ${rel} could not be read, so it is not indexed: ${err instanceof Error ? err.message : String(err)}`);
              continue;
            }
            if (file.kind === "too-large") log(`[Memory] ${rel} is ${Math.round(file.size / 1024 / 1024)} MB, over the ${MAX_MEMORY_FILE_BYTES / 1024 / 1024} MB a memo is read at, so it is not indexed.`);
            if (file.kind !== "ok") continue;
            const parsed = parseMemoryFile(file.content.toString("utf-8"));
            if (!parsed) continue;
            indexed.add(rel);
            const version = blobId(file.content);
            if (known.get(rel) === version) continue;
            upsertDoc(rel, parsed.front, parsed.body, version, file.content.length);
          }
        });
      }
      const gone = [...known.keys()].filter((rel) => !indexed.has(rel));
      transaction(() => {
        for (const rel of gone) deleteDoc(rel);
      });
      // The index.md files may be out of date after hand edits; they are brought up to date without a commit (the next change commits them).
      if (fs.existsSync(dir)) {
        const directories = new Set<string>([""]);
        for (const rel of [...indexed, ...gone]) for (const d of memoryDirsUp(memoryDirOf(rel))) directories.add(d);
        syncIndexes([...directories].sort((a, b) => b.length - a.length));
      }
      deps.onChange?.();
      return { count: indexed.size };
    });
  }

  return { write, deprecate, remove, read, search, browse, history, rebuild };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
