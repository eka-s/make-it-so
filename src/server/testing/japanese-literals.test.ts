import { describe, expect, it } from "vitest";
import { findJapaneseLiterals } from "./japanese-literals.js";

describe("findJapaneseLiterals", () => {
  it("finds Japanese in string, template and JSX text, with line numbers", () => {
    const source = [
      'const a = "こんにちは";',
      "const b = `値は${x}です`;",
      "const c = <p>保存</p>;",
      'const d = "English only";',
    ].join("\n");
    expect(findJapaneseLiterals(source, "x.tsx")).toEqual([
      { line: 1, text: "こんにちは" },
      { line: 2, text: "値は" },
      { line: 2, text: "です" },
      { line: 3, text: "保存" },
    ]);
  });

  it("ignores comments (line, block and JSX comments)", () => {
    const source = [
      "// 日本語のコメント",
      "/* 複数行の",
      "   コメント */",
      "const c = <p>{/* JSXのコメント */}ok</p>;",
    ].join("\n");
    expect(findJapaneseLiterals(source, "x.tsx")).toEqual([]);
  });
});
