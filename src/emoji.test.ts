import { describe, expect, it } from "vitest";

import { normalizeUnicodeEmoji } from "./emoji";

describe("normalizeUnicodeEmoji", () => {
  it.each([
    "👍",
    "🎉",
    "🙏",
    "🍎",
    "❤️",
    "✌️",
    "☹️",
    "🏳️‍🌈",
    "👨‍👩‍👧",
    "👨🏾‍⚕️",
    "👍🏾",
    "🏾",
    "🇰🇷",
    "1️⃣",
    "#️⃣",
    "*️⃣",
    "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  ])("preserves a single RGI emoji: %s", (emoji) => {
    expect(normalizeUnicodeEmoji(emoji)).toBe(emoji);
  });

  it.each([
    ["❤", "❤️"],
    ["✌", "✌️"],
    ["☹", "☹️"],
    ["☃", "☃️"],
  ])("repairs %s to %s idempotently", (bare, qualified) => {
    expect(normalizeUnicodeEmoji(bare)).toBe(qualified);
    expect(normalizeUnicodeEmoji(normalizeUnicodeEmoji(bare)!)).toBe(qualified);
  });

  it.each([
    "",
    "hello",
    "3*14159",
    "1",
    "#",
    "*",
    "👍🎉🙏🍎",
    "❤❤❤",
    ":custom:",
    "\uFE0F",
    "\u200D",
    "👍\n",
    " 👍",
    "1\u20E3",
    "🏳\u200D🌈",
    "🇰",
  ])("rejects non-RGI content: %j", (emoji) => {
    expect(normalizeUnicodeEmoji(emoji)).toBeUndefined();
  });
});
