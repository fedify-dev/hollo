import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGukhanmunPreset,
  matchesGukhanmunLocale,
  transformPostHtmlWithGukhanmun,
} from "./gukhanmun";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("matchesGukhanmunLocale", () => {
  it.each([
    ["ko", "ko,ko-*", true],
    ["ko-KR", "ko,ko-*", true],
    ["ko-Kore-KR", "ko,ko-*", true],
    ["KO-kp", "ko,ko-*", true],
    ["ko", "ko-*", false],
    ["kor-KR", "ko,ko-*", false],
    ["en", "*", true],
    ["ko-KR", " en , KO-kr, ", true],
    ["ko-KP", "", false],
    ["ko-KP", undefined, false],
    [null, "ko,ko-*", false],
  ] as const)(
    "matches locale %s against configuration %s",
    (locale, configuredLocales, expected) => {
      expect(matchesGukhanmunLocale(locale, configuredLocales)).toBe(expected);
    },
  );
});

describe("getGukhanmunPreset", () => {
  it.each([
    ["ko-KP", "ko-kp"],
    ["ko-Kore-KP", "ko-kp"],
    ["ko-KR", "ko-kr"],
    ["ko", "ko-kr"],
    ["not_a_locale", "ko-kr"],
  ] as const)("selects %s for %s", (locale, expected) => {
    expect(getGukhanmunPreset(locale)).toBe(expected);
  });
});

describe("transformPostHtmlWithGukhanmun", () => {
  it("adds South Korean readings to matching HTML", async () => {
    vi.stubEnv("GUKHANMUN", "ko,ko-*");

    await expect(
      transformPostHtmlWithGukhanmun("<p>漢字와 來日</p>", "ko-Kore-KR"),
    ).resolves.toBe(
      "<p><ruby>漢字<rp>(</rp><rt>한자</rt><rp>)</rp></ruby>와 " +
        "<ruby>來日<rp>(</rp><rt>내일</rt><rp>)</rp></ruby></p>",
    );
  });

  it("adds North Korean readings to matching HTML", async () => {
    vi.stubEnv("GUKHANMUN", "ko,ko-*");

    await expect(
      transformPostHtmlWithGukhanmun("<p>來日</p>", "ko-KP"),
    ).resolves.toBe(
      "<p><ruby>來日<rp>(</rp><rt>래일</rt><rp>)</rp></ruby></p>",
    );
  });

  it.each([
    ["South Korean", "ko-KR", "내일"],
    ["North Korean", "ko-KP", "래일"],
  ] as const)(
    "preserves translate=no regions with %s readings",
    async (_name, locale, reading) => {
      vi.stubEnv("GUKHANMUN", "ko,ko-*");
      const html =
        '<p><a href="https://example.com/@x" translate="no" ' +
        'class="h-card u-url mention">@<span>來日</span></a>와 來日</p>';

      await expect(transformPostHtmlWithGukhanmun(html, locale)).resolves.toBe(
        '<p><a href="https://example.com/@x" translate="no" ' +
          'class="h-card u-url mention">@<span>來日</span></a>와 ' +
          `<ruby>來日<rp>(</rp><rt>${reading}</rt><rp>)</rp></ruby></p>`,
      );
    },
  );

  it("preserves code and non-matching locales", async () => {
    vi.stubEnv("GUKHANMUN", "ko,ko-*");

    await expect(
      transformPostHtmlWithGukhanmun("<p><code>漢字</code>와 漢字</p>", "ko"),
    ).resolves.toBe(
      "<p><code>漢字</code>와 " +
        "<ruby>漢字<rp>(</rp><rt>한자</rt><rp>)</rp></ruby></p>",
    );
    await expect(
      transformPostHtmlWithGukhanmun("<p>漢字</p>", "ja"),
    ).resolves.toBe("<p>漢字</p>");
  });
});
