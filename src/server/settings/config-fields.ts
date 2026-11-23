import path from "node:path";
import { isNode, type Document } from "yaml";
import { CONFIG_DEFAULTS, LOG_LEVELS, PROVIDERS } from "../config-defaults.js";
import { DEFAULT_LANGUAGE, LANGUAGES } from "../language.js";
import { DEFAULT_THEME, THEMES } from "../theme.js";
import { deleteValue, editYamlFile, readYamlDocument, setValue } from "./yaml-edit.js";

// The form for config.yml. The fields (their kind, choices and defaults) are defined here, and the screen only draws
// what GET returns. A value equal to the default is not written (the key is removed), so the file stays short.

type FieldBase = { key: string; group: "general" | "acp" | "server" | "logging" };
type FieldKind =
  | { type: "enum"; options: readonly string[]; /** Unset means "same as another setting", not a fixed value. */ default: string | null }
  | { type: "text"; default: string }
  | { type: "boolean"; default: boolean }
  | { type: "number"; default: number; min: number; max: number }
  | { type: "list"; default: string[] };
export type ConfigField = FieldBase & FieldKind;

export const CONFIG_FIELDS: ConfigField[] = [
  { key: "language", group: "general", type: "enum", options: LANGUAGES, default: DEFAULT_LANGUAGE },
  { key: "crew_language", group: "general", type: "enum", options: LANGUAGES, default: null },
  { key: "theme", group: "general", type: "enum", options: THEMES, default: DEFAULT_THEME },
  { key: "acp.provider", group: "acp", type: "enum", options: PROVIDERS, default: CONFIG_DEFAULTS.provider },
  { key: "acp.kiro.command", group: "acp", type: "text", default: CONFIG_DEFAULTS.kiro.command },
  { key: "acp.kiro.args", group: "acp", type: "list", default: CONFIG_DEFAULTS.kiro.args },
  { key: "acp.claude.command", group: "acp", type: "text", default: CONFIG_DEFAULTS.claude.command },
  { key: "acp.claude.args", group: "acp", type: "list", default: CONFIG_DEFAULTS.claude.args },
  { key: "server.host", group: "server", type: "text", default: CONFIG_DEFAULTS.host },
  { key: "debug", group: "server", type: "boolean", default: CONFIG_DEFAULTS.debug },
  { key: "logging.level", group: "logging", type: "enum", options: LOG_LEVELS, default: CONFIG_DEFAULTS.logLevel },
  { key: "logging.maxFileSizeMb", group: "logging", type: "number", default: CONFIG_DEFAULTS.maxFileSizeMb, min: 1, max: 1024 },
];

export type ConfigFieldState = ConfigField & {
  /** The value in the file, or null when the key is not set (the default applies). */
  value: unknown;
};

export type ConfigState = { file: string; exists: boolean; fields: ConfigFieldState[] };

/** Why a value was refused: a message key the screen translates. */
export type FieldError = "settings.error.notAnOption" | "settings.error.notAText" | "settings.error.notABoolean" | "settings.error.notANumber" | "settings.error.outOfRange" | "settings.error.notAList" | "settings.error.empty";

const pathOf = (key: string) => key.split(".");

function currentValue(doc: Document, key: string): unknown {
  const node = doc.getIn(pathOf(key), true);
  if (node === undefined || node === null) return null;
  return isNode(node) ? node.toJS(doc) : node;
}

export function readConfigState(dir: string): ConfigState {
  const file = path.join(dir, "config.yml");
  const doc = readYamlDocument(file);
  const exists = doc.contents !== null;
  return { file, exists, fields: CONFIG_FIELDS.map((f) => ({ ...f, value: currentValue(doc, f.key) })) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Checks one submitted value against its field. Returns the normalized value (null = "use the default"), or the error. */
function normalize(field: ConfigField, input: unknown): { value: unknown } | { error: FieldError } {
  if (input === null || input === "") {
    return { value: null }; // cleared: use the default
  }
  switch (field.type) {
    case "enum":
      return typeof input === "string" && field.options.includes(input) ? { value: input } : { error: "settings.error.notAnOption" };
    case "text": {
      if (typeof input !== "string") return { error: "settings.error.notAText" };
      return input.trim() === "" ? { error: "settings.error.empty" } : { value: input.trim() };
    }
    case "boolean":
      return typeof input === "boolean" ? { value: input } : { error: "settings.error.notABoolean" };
    case "number": {
      if (typeof input !== "number" || !Number.isFinite(input) || !Number.isInteger(input)) return { error: "settings.error.notANumber" };
      return input < field.min || input > field.max ? { error: "settings.error.outOfRange" } : { value: input };
    }
    case "list": {
      if (!Array.isArray(input) || !input.every((x) => typeof x === "string")) return { error: "settings.error.notAList" };
      const items = input.map((x) => x.trim()).filter((x) => x !== "");
      return items.length === 0 ? { value: null } : { value: items };
    }
  }
}

export type ApplyResult = { ok: true; state: ConfigState } | { ok: false; errors: Record<string, FieldError> };

/**
 * Applies the submitted values (key → value; only the keys given are touched). Nothing is written unless every
 * value is valid. A value equal to the default removes the key; a value equal to what is already there is left alone
 * (so the comments and the form of the file are not disturbed).
 */
export function applyConfigValues(dir: string, values: Record<string, unknown>): ApplyResult {
  const errors: Record<string, FieldError> = {};
  const changes: { field: ConfigField; value: unknown }[] = [];
  for (const [key, input] of Object.entries(values)) {
    const field = CONFIG_FIELDS.find((f) => f.key === key);
    if (!field) {
      errors[key] = "settings.error.notAnOption"; // an unknown key: nothing to edit
      continue;
    }
    const result = normalize(field, input);
    if ("error" in result) errors[key] = result.error;
    else changes.push({ field, value: result.value });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const file = path.join(dir, "config.yml");
  editYamlFile(file, (doc) => {
    for (const { field, value } of changes) {
      const current = currentValue(doc, field.key);
      // What is in effect now and what is asked for; an unchanged value (even an explicit one equal to the default) is left alone.
      if (same(current ?? field.default, value ?? field.default)) continue;
      if (value === null || same(value, field.default)) deleteValue(doc, pathOf(field.key));
      else setValue(doc, pathOf(field.key), value);
    }
  });
  return { ok: true, state: readConfigState(dir) };
}
