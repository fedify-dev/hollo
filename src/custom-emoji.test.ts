import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";

import { renderCustomEmojis } from "./custom-emoji";

const baseUrl = "https://hollo.test";

describe("renderCustomEmojis", () => {
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
