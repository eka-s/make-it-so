import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureLogger, logger } from "./logger.js";

// logger does not depend on config.ts, so it can be loaded without a mock.
let dir: string;
let consoleLog: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mis-logger-"));
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  // Back to the default (console only, info) so as not to affect other tests
  configureLogger({ level: "info", maxFileSizeMb: 5 });
});

const logFile = () => path.join(dir, "app.log");

describe("logger", () => {
  it("messages below the configured level go to neither the console nor the file", () => {
    configureLogger({ level: "warn", maxFileSizeMb: 5, logsDir: dir });
    logger.info("hidden");
    logger.warn("shown");

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith("shown");
    const text = fs.readFileSync(logFile(), "utf-8");
    expect(text).toContain("[WARN] shown");
    expect(text).not.toContain("hidden");
  });

  it("the file gets one line appended at a time, with an ISO time and the level", () => {
    configureLogger({ level: "debug", maxFileSizeMb: 5, logsDir: dir });
    logger.info("first");
    logger.error("second", 42);

    const lines = fs.readFileSync(logFile(), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[INFO\] first$/);
    expect(lines[1]).toMatch(/\[ERROR\] second 42$/);
  });

  it("without logsDir, no file is created and output goes only to the console", () => {
    configureLogger({ level: "info", maxFileSizeMb: 5 });
    logger.info("console only");
    expect(consoleLog).toHaveBeenCalledWith("console only");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("when the size limit is exceeded, it is moved aside to app.log.1 (one generation only) and a new file is written", () => {
    // A setting that is exceeded at about 100 bytes
    configureLogger({ level: "info", maxFileSizeMb: 0.0001, logsDir: dir });
    for (let i = 0; i < 10; i++) logger.info(`line ${i} ${"x".repeat(20)}`);

    expect(fs.existsSync(`${logFile()}.1`)).toBe(true);
    expect(fs.existsSync(logFile())).toBe(true);
    // only one generation
    expect(fs.existsSync(`${logFile()}.2`)).toBe(false);
  });
});
