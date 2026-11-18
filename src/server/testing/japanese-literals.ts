import ts from "typescript";

// Finds Japanese text inside string literals, template literals and JSX text of a
// TypeScript source. Comments are ignored on purpose (they are rewritten separately).
// Used by the test that keeps user-visible text out of the source: UI text lives in
// the message dictionaries, and prompts / developer messages are written in English.

const JAPANESE = /[ぁ-んァ-ヶ一-龠]/;

export type JapaneseLiteral = { line: number; text: string };

export function findJapaneseLiterals(source: string, fileName: string): JapaneseLiteral[] {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const hits: JapaneseLiteral[] = [];
  const visit = (node: ts.Node): void => {
    const k = node.kind;
    if (
      k === ts.SyntaxKind.StringLiteral ||
      k === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      k === ts.SyntaxKind.TemplateHead ||
      k === ts.SyntaxKind.TemplateMiddle ||
      k === ts.SyntaxKind.TemplateTail ||
      k === ts.SyntaxKind.JsxText
    ) {
      const text = k === ts.SyntaxKind.JsxText ? node.getText() : (node as ts.LiteralLikeNode).text;
      if (JAPANESE.test(text)) {
        hits.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: text.replace(/\s+/g, " ").trim() });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}
