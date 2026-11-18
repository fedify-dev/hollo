const RGI_EMOJI = /^\p{RGI_Emoji}$/v;

/**
 * Accepts one RGI emoji, repairing bare forms such as ❤ with U+FE0F.
 * The accepted Unicode version is determined by the JavaScript runtime.
 */
export function normalizeUnicodeEmoji(emoji: string): string | undefined {
  if (RGI_EMOJI.test(emoji)) return emoji;
  const qualified = `${emoji}\uFE0F`;
  return RGI_EMOJI.test(qualified) ? qualified : undefined;
}
