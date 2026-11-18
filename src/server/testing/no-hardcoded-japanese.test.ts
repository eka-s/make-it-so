import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findJapaneseLiterals } from "./japanese-literals.js";

// Keeps Japanese out of the source, comments included.
//  - server: prompts for the crew and messages for developers are written in English.
//    Text the user sees in the UI goes through message keys (see messages.ts).
//  - client: all UI text goes through the message dictionaries (the only places with
//    Japanese are `i18n/ja.ts` and the language names in `i18n/languages.ts`).

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function offenders(dir: string, allowed: string[] = []): string[] {
  return sourceFiles(dir)
    .filter((file) => !allowed.some((a) => file.endsWith(a)))
    .flatMap((file) =>
      findJapaneseLiterals(fs.readFileSync(file, "utf-8"), file).map((hit) => `${path.relative(process.cwd(), file)}:${hit.line}: ${hit.text}`),
    );
}

// Japanese is allowed only in the Japanese dictionary and the language names (non-test source and CSS).
// Test files may contain Japanese as test data (e.g. to check Japanese search).
const JAPANESE_ALLOWED = [path.join("i18n", "ja.ts"), path.join("i18n", "languages.ts"), "LanguageSwitch.tsx", path.join("testing", "japanese-literals.ts"), path.join("testing", "no-hardcoded-japanese.test.ts")];

function allSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return allSourceFiles(full);
    return /\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("no Japanese anywhere in the source (comments included)", () => {
  it("only the allowed files contain Japanese characters", () => {
    const japanese = /[\u3040-\u30ff\u4e00-\u9fff]/;
    const found = allSourceFiles(path.resolve("src"))
      .filter((file) => !JAPANESE_ALLOWED.some((a) => file.endsWith(a)))
      .flatMap((file) =>
        fs
          .readFileSync(file, "utf-8")
          .split("\n")
          .flatMap((line, i) => (japanese.test(line) ? [`${path.relative(process.cwd(), file)}:${i + 1}: ${line.trim().slice(0, 80)}`] : [])),
      );
    expect(found).toEqual([]);
  });
});

describe("no hard-coded Japanese in the source", () => {
  it("server: no Japanese text", () => {
    expect(offenders(path.resolve("src/server"), [path.join("testing", "no-hardcoded-japanese.test.ts")])).toEqual([]);
  });

  it("client: Japanese text only in the Japanese dictionary", () => {
    expect(offenders(path.resolve("src/client"), [path.join("i18n", "ja.ts"), path.join("i18n", "languages.ts")])).toEqual([]);
  });
});
