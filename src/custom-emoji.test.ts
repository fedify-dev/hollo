import { parseHTML } from "linkedom";
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

  it.each([
    'https://remote.example/emoji.png" onerror="alert(1)',
    'https://remote.example/emoji.png"><script>alert(1)</script>',
    "https://remote.example/emoji.png?a=1&b=2",
    "https://remote.example/emoji.png?literal=&quot;&lt;&amp;",
    "/emoji.png",
  ])("contains the URL within the image src: %s", (url) => {
    const html = renderCustomEmojis(":hello:", { hello: url }, baseUrl);
    const { document } = parseHTML(`<div>${html}</div>`);
    const image = document.querySelector("img");

    expect(image?.getAttribute("src")).toBe(url);
    expect(image?.getAttribute("alt")).toBe(":hello:");
    expect(image?.classList.contains("not-prose")).toBe(true);
    expect(image?.getAttributeNames().sort()).toEqual([
      "alt",
      "class",
      "src",
      "style",
    ]);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(document.querySelector("div")?.children).toHaveLength(1);
  });

  it.each(["hello", ":hello:"])("supports the %s map key", (key) => {
    const { document } = parseHTML(
      `<div>${renderCustomEmojis("Hi :hello:!", { [key]: "https://remote.example/e" }, baseUrl)}</div>`,
    );
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "https://remote.example/e",
    );
    expect(document.querySelector("div")?.textContent).toBe("Hi !");
  });

  it("leaves attributes and unknown shortcodes intact", () => {
    const html = renderCustomEmojis(
      '<a title=":hello:">:unknown: :hello:</a>',
      { hello: "https://remote.example/e" },
      baseUrl,
    );
    const { document } = parseHTML(`<div>${html}</div>`);
    const link = document.querySelector("a");
    expect(link?.getAttribute("title")).toBe(":hello:");
    expect(link?.textContent).toBe(":unknown: ");
    expect(link?.querySelector("img")?.getAttribute("alt")).toBe(":hello:");
  });

  it("does not render inherited non-string values as URLs", () => {
    expect(renderCustomEmojis(":constructor: :__proto__:", {}, baseUrl)).toBe(
      ":constructor: :__proto__:",
    );
  });

  it("preserves null and empty inputs", () => {
    expect(renderCustomEmojis(null, {}, baseUrl)).toBeNull();
    expect(renderCustomEmojis("", {}, baseUrl)).toBe("");
  });
});
