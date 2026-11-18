import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdirPrivate } from "../private-dirs.js";
import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";

// Editing a YAML file in place. The file is changed through the parsed document, so comments, the order of keys and
// keys this code does not know are kept; only what the edit touches changes. The old file is kept as `<file>.bak`
// (one generation) and the new one is written to a temporary file and renamed, so a crash never leaves a half-written file.

/** The existing file is not valid YAML (it is left as it is, never overwritten). */
export class YamlUnreadableError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} could not be read: ${detail}`);
  }
}

/** Parses a file into a document (an empty one when the file does not exist). Throws YamlUnreadableError when it is broken. */
export function readYamlDocument(file: string): Document {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new YamlUnreadableError(file, doc.errors[0].message);
  return doc;
}

/**
 * Sets a value. A value that is already a scalar is changed in place, which keeps the comment on its line. A list is
 * written inline, like `[a, b]`, the style the sample config uses.
 */
export function setValue(doc: Document, keyPathAsGiven: string[], value: unknown): void {
  const keyPath = actualKeyPath(doc, keyPathAsGiven);
  const existing = doc.getIn(keyPath, true);
  if (isScalar(existing) && (value === null || typeof value !== "object")) {
    existing.value = value;
    return;
  }
  ensureMapParents(doc, keyPath);
  const node = doc.createNode(value);
  if (isSeq(node)) node.flow = true;
  doc.setIn(keyPath, node);
}

/**
 * The key path with each key spelled as the document has it. IDs come in as text, but a hand-written key such as `42` is read by YAML as
 * a number, and a lookup by the text "42" would miss it (and an edit would add a second, string key next to it).
 */
function actualKeyPath(doc: Document, keyPath: string[]): (string | number | boolean)[] {
  const result: (string | number | boolean)[] = [];
  let node: unknown = doc.contents;
  for (const key of keyPath) {
    let actual: string | number | boolean = key;
    let next: unknown;
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && (p.key.value === key || String(p.key.value) === key));
      if (pair && isScalar(pair.key) && (typeof pair.key.value === "number" || typeof pair.key.value === "boolean")) actual = pair.key.value;
      next = pair?.value;
    }
    result.push(actual);
    node = next;
  }
  return result;
}

/**
 * Makes sure every parent of `keyPath` is a map. A parent written as an empty key (`crew:` with nothing under it, or only
 * comments) parses as null, and setIn refuses to go through it; it is replaced by an empty map (keeping its comments).
 * A parent that holds a real value (a list, a text) is left alone, so the edit fails visibly instead of destroying data.
 */
function ensureMapParents(doc: Document, keyPath: (string | number | boolean)[]): void {
  for (let depth = 1; depth < keyPath.length; depth++) {
    const prefix = keyPath.slice(0, depth);
    const node = doc.getIn(prefix, true);
    if (isScalar(node) && node.value === null) {
      const map = doc.createNode({});
      map.commentBefore = node.commentBefore;
      map.comment = node.comment;
      doc.setIn(prefix, map);
    }
  }
}

/** Removes a key, and the parents that are left empty by it (so `acp: {}` is not left behind). */
export function deleteValue(doc: Document, keyPathAsGiven: string[]): void {
  const keyPath = actualKeyPath(doc, keyPathAsGiven);
  doc.deleteIn(keyPath);
  for (let depth = keyPath.length - 1; depth > 0; depth--) {
    const parentPath = keyPath.slice(0, depth);
    const parent = doc.getIn(parentPath);
    if (isMap(parent) && parent.items.length === 0) doc.deleteIn(parentPath);
    else break;
  }
}

/** Reads the file, lets `edit` change the document, and writes it back (creating the directory when needed). */
export function editYamlFile(file: string, edit: (doc: Document) => void): void {
  const doc = readYamlDocument(file);
  edit(doc);
  const text = doc.toString();
  mkdirPrivate(path.dirname(file));
  // A file that is a symlink (dotfiles setups) is edited where it really is: renaming over the link would replace the link
  // with a plain file and leave the real file untouched.
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : undefined;
  if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`);
  // A name of its own, so two processes saving at the same moment (several ships share some files) do not trip over one temp file.
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, target);
}
