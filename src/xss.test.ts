import { renderToString } from "katex";
import { describe, expect, it } from "vitest";

import { sanitizeHtml } from "./xss";

describe("sanitizeHtml Markdown extensions", () => {
  it.each([
    String.raw`\sum_{i=0}^{n} \frac{1}{x_i}`,
    String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
    String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`,
    String.raw`\overbrace{x+y}^{z} \not= \sqrt[3]{x} \mathbb{R} \text{漢字}`,
    String.raw`\color{red}{x} \rule{1em}{1ex} \overset{a}{\to} \pmod{n}`,
    String.raw`\displaystyle\bigl(\small x\bigr) + \mathop{f}\limits_{x}`,
  ])("preserves MathML semantics generated for %s", (source) => {
    const html = renderToString(source, {
      output: "mathml",
      displayMode: true,
      trust: false,
      strict: "ignore",
    }).replace("<math ", '<math class="hollo-math hollo-markdown-preserve" ');
    // XSS normalizes XML-style empty MathML tags to HTML-style closing syntax.
    expect(sanitizeHtml(html)).toBe(html.replaceAll(/\s*\/>/g, " />"));
    expect(sanitizeHtml(html)).toContain('encoding="application/x-tex"');
  });

  it("retains authored ruby protection and semantic extension elements", () => {
    const html =
      '<ruby class="hollo-markdown-preserve">漢字<rp>(</rp><rt>한자</rt><rp>)</rp></ruby><mark>highlight</mark><ins>added</ins><sub>2</sub><sup>3</sup><abbr title="Hypertext">HTML</abbr>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("keeps scripts, event handlers, URLs, and unapproved MathML attributes filtered", () => {
    const html =
      '<math display="block" onclick="alert(1)"><mi href="javascript:alert(1)" style="position:fixed">x</mi></math><svg onload="alert(1)"><foreignObject><iframe src="https://example.com"></iframe></foreignObject></svg>';
    const result = sanitizeHtml(html);
    expect(result).not.toMatch(/<(?:iframe|foreignObject)\b/i);
    expect(result).not.toContain('onclick="');
    expect(result).not.toContain('onload="');
    expect(result).not.toContain('href="javascript:');
    expect(result).not.toContain('style="position:');
    expect(sanitizeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });
});
