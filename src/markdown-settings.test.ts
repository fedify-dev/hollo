import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getMarkdownExtensions,
  MARKDOWN_EXTENSIONS,
  parseMarkdownExtensions,
} from "./markdown-settings";

afterEach(() => vi.unstubAllEnvs());

describe("parseMarkdownExtensions", () => {
  it.each([undefined, "", "  , ,  "])("disables extensions for %s", (value) => {
    expect([...parseMarkdownExtensions(value)]).toEqual([]);
  });

  it("trims, ignores empty entries, and deduplicates explicit names", () => {
    expect([
      ...parseMarkdownExtensions(" math, footnote,math, ,ruby "),
    ]).toEqual(["math", "footnote", "ruby"]);
  });

  it("accepts every documented extension", () => {
    expect([...parseMarkdownExtensions(MARKDOWN_EXTENSIONS.join(","))]).toEqual(
      MARKDOWN_EXTENSIONS,
    );
  });

  it.each(["Math", "all", "footnotes", "math,unknown"])(
    "rejects unknown names instead of silently changing behavior: %s",
    (value) => {
      expect(() => parseMarkdownExtensions(value)).toThrow(
        /Unknown MARKDOWN_EXTENSIONS value:/u,
      );
    },
  );

  it("reads the current environment rather than caching the first value", () => {
    vi.stubEnv("MARKDOWN_EXTENSIONS", "math");
    expect([...getMarkdownExtensions()]).toEqual(["math"]);
    vi.stubEnv("MARKDOWN_EXTENSIONS", "ruby,sub");
    expect([...getMarkdownExtensions()]).toEqual(["ruby", "sub"]);
    vi.stubEnv("MARKDOWN_EXTENSIONS", undefined);
    expect([...getMarkdownExtensions()]).toEqual([]);
  });
});
