import { describe, expect, it } from "vitest";

import { createMarkdownIt } from "./text";

describe("createMarkdownIt", () => {
  it.each([
    {
      text: "example.com",
      expected: '<a href="http://example.com">example.com</a>',
    },
    {
      text: "https://user:pass@example.com/path",
      expected:
        '<a href="https://user:pass@example.com/path">' +
        "https://user:pass@example.com/path</a>",
    },
  ])("preserves linkification of $text", ({ text, expected }) => {
    expect(createMarkdownIt().renderInline(text)).toBe(expected);
  });
});
