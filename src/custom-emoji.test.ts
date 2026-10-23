import { describe, expect, it } from "vitest";

import { renderCustomEmojis } from "./custom-emoji";

const emojis = { smile: "https://example.com/smile.png" };
const baseUrl = "https://hollo.example/";

describe("renderCustomEmojis", () => {
  it("preserves MathML presentation and TeX annotations", () => {
    const math =
      '<math><semantics><mtext>:smile:</mtext><annotation encoding="application/x-tex">\\text{:smile:}</annotation></semantics></math>';
    const result = renderCustomEmojis(math + " :smile:", emojis, baseUrl);
    expect(result).toContain(math);
    expect(result.match(/<img /g)).toHaveLength(1);
  });

  it.each(["span", "div"])("preserves nested literal math in %s", (tag) => {
    const fallback = `<${tag} class="hollo-math hollo-markdown-preserve">$<${tag}>:smile:</${tag}> :smile:$</${tag}>`;
    const result = renderCustomEmojis(fallback + " :smile:", emojis, baseUrl);
    expect(result).toContain(fallback);
    expect(result.match(/<img /g)).toHaveLength(1);
  });

  it("recognizes single-quoted classes and uppercase MathML tags", () => {
    const math =
      "<MATH><mtext>:smile:</mtext></MATH><span class='hollo-math'>:smile:</span>";
    expect(renderCustomEmojis(math, emojis, baseUrl)).toBe(math);
  });

  it("continues rendering ordinary text and code while preserving attributes", () => {
    const result = renderCustomEmojis(
      '<a title=":smile: >">:smile:</a><code>:smile:</code>',
      emojis,
      baseUrl,
    );
    expect(result).toContain('title=":smile: >"');
    expect(result.match(/<img /g)).toHaveLength(2);
  });

  it("does not treat another class name as protected math", () => {
    expect(
      renderCustomEmojis(
        '<span class="hollo-math-extra">:smile:</span>',
        emojis,
        baseUrl,
      ),
    ).toContain("<img ");
    expect(
      renderCustomEmojis(
        '<span title=" class=hollo-math">:smile:</span>',
        emojis,
        baseUrl,
      ),
    ).toContain("<img ");
  });

  it("keeps missing emoji URLs literal and preserves null", () => {
    expect(renderCustomEmojis(":missing:", emojis, baseUrl)).toBe(":missing:");
    expect(renderCustomEmojis(null, emojis, baseUrl)).toBeNull();
  });
});
