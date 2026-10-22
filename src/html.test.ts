import { describe, expect, it } from "vitest";

import { extractPreviewLink, stripFootnoteIds } from "./html";

describe("footnote navigation", () => {
  it("ignores relative and known-document fragments, preserving external anchors", async () => {
    const html =
      '<a href="https://other.test/post#part">external</a><a href="#note">note</a><a href="https://local.test/post#fn">absolute</a>';
    expect(
      await extractPreviewLink(html, [], ["https://local.test/post"]),
    ).toBe("https://other.test/post#part");
  });
  it("removes only generated IDs from repeated cards", () => {
    expect(
      stripFootnoteIds(
        '<li id="fn-hollo-123-1"><a href="https://test/post#fnref-hollo-123-1" id="fnref-hollo-123-1:1">back</a></li><p id="custom">text</p>',
      ),
    ).toBe(
      '<li><a href="https://test/post#fnref-hollo-123-1">back</a></li><p id="custom">text</p>',
    );
  });
});
