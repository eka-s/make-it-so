// Structured logging. Console output stays as it is (so the feel during development does not change), and the same content
// is also written to `logs/app.log` directly under the ship root (see logsDir in config.ts; kept separate from the DB's
// `data/` as a different concern).
//
// Replacing existing `console.*` calls with this module is done separately: the mechanism itself comes first,
// with its settings (level, rotation) fixed, and callers are migrated afterwards.
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { mkdirPrivate } from "./private-dirs.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Logger settings. This module does not depend on the ship config (config.ts) — if it did,
 * every module that uses the logger would load the ship config just by being imported,
 * and could not be tested. index.ts passes the settings at startup via `configureLogger()`.
 */
export type LoggerOptions = {
  /** Messages below this level are written to neither the console nor the file. */
  level: LogLevel;
  /** Size limit for rotation (MB). */
  maxFileSizeMb: number;
  /**
   * Directory where the log file goes. When omitted (undefined), nothing is written to a file and output goes to the console only.
   */
  logsDir?: string;
};

// Defaults before configuration: info level, console only (no file output).
let minLevel = LEVEL_ORDER.info;
let maxBytes = 5 * 1024 * 1024;
let logsDir: string | undefined;

/** Configures the logger. Call it once at startup, before any other log output. */
export function configureLogger(options: LoggerOptions): void {
  minLevel = LEVEL_ORDER[options.level];
  maxBytes = options.maxFileSizeMb * 1024 * 1024;
  logsDir = options.logsDir;
}

function logFilePath(dir: string): string {
  return path.join(dir, "app.log");
}

/**
 * If the size limit is exceeded, moves the file aside (one generation only) and then creates a new one
 * (`app.log` → `app.log.1`). It does not rely on an external log-rotation tool; this process decides at write time —
 * one generation is enough at the scale of this tool (one person running a few ships).
 */
function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // The file does not exist yet — no rotation needed
  }
  if (size < maxBytes) return;
  const rotated = `${file}.1`;
  try {
    fs.rmSync(rotated, { force: true });
    fs.renameSync(file, rotated);
  } catch (err) {
    // A rotation failure is not a reason to stop logging —
    // the appendFileSync below just keeps appending to the existing file.
    console.error("[Logger] Failed to rotate log file:", err);
  }
}

/**
 * Appends one line to the file in exactly the same format as the console (`util.format` — the same formatting rules as the internals of console.*).
 */
function writeToFile(level: LogLevel, args: unknown[]): void {
  if (!logsDir) return; // File output is not configured (console only)
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${format(...args)}\n`;
  try {
    mkdirPrivate(logsDir);
    const file = logFilePath(logsDir);
    rotateIfNeeded(file);
    fs.appendFileSync(file, line);
  } catch (err) {
    // A file write failure (disk full, permissions, etc.) does not stop the app itself
    // — console output carries on as usual.
    console.error("[Logger] Failed to write log file:", err);
  }
}

function emit(level: LogLevel, console_: (...args: unknown[]) => void, args: unknown[]): void {
  if (LEVEL_ORDER[level] < minLevel) return;
  console_(...args);
  writeToFile(level, args);
}

/**
 * A logger with levels and file output that can be used like `console.log`/`warn`/`error` (variadic arguments;
 * non-strings can be formatted as is with `util.format`). Messages below the level set by `configureLogger()` are written to
 * neither the console nor the file.
 */
export const logger = {
  debug: (...args: unknown[]) => emit("debug", console.log, args),
  info:  (...args: unknown[]) => emit("info",  console.log, args),
  warn:  (...args: unknown[]) => emit("warn",  console.warn, args),
  error: (...args: unknown[]) => emit("error", console.error, args),
};
