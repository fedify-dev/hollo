import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";

import { renderCustomEmojis } from "./custom-emoji";

describe("renderCustomEmojis", () => {
  it.each([
    'https://remote.example/emoji.png" onerror="alert(1)',
    'https://remote.example/emoji.png"><script>alert(1)</script>',
    "https://remote.example/emoji.png?a=1&b=2",
    "https://remote.example/emoji.png?literal=&quot;&lt;&amp;",
    "/emoji.png",
  ])("contains the URL within the image src: %s", (url) => {
    const html = renderCustomEmojis(":hello:", { hello: url });
    const { document } = parseHTML(`<div>${html}</div>`);
    const image = document.querySelector("img");

    expect(image?.getAttribute("src")).toBe(url);
    expect(image?.getAttribute("alt")).toBe(":hello:");
    expect(image?.getAttribute("style")).toBe("height: 1em");
    expect(image?.getAttributeNames().sort()).toEqual(["alt", "src", "style"]);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(document.querySelector("div")?.children).toHaveLength(1);
  });

  it.each(["hello", ":hello:"])("supports the %s map key", (key) => {
    expect(
      renderCustomEmojis("Hi :hello:!", { [key]: "https://remote.example/e" }),
    ).toBe(
      'Hi <img src="https://remote.example/e" alt=":hello:" style="height: 1em">!',
    );
  });

  it("leaves attributes and unknown shortcodes intact", () => {
    expect(
      renderCustomEmojis('<a title=":hello:">:unknown: :hello:</a>', {
        hello: "https://remote.example/e",
      }),
    ).toBe(
      '<a title=":hello:">:unknown: <img src="https://remote.example/e" alt=":hello:" style="height: 1em"></a>',
    );
  });

  it("does not render inherited non-string values as URLs", () => {
    expect(renderCustomEmojis(":constructor: :__proto__:", {})).toBe(
      ":constructor: :__proto__:",
    );
  });

  it("preserves null and empty inputs", () => {
    expect(renderCustomEmojis(null, {})).toBeNull();
    expect(renderCustomEmojis("", {})).toBe("");
  });
});
