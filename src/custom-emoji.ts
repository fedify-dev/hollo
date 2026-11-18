import { escape } from "es-toolkit";

import { proxyUrl } from "./media-proxy";

const CUSTOM_EMOJI_REGEXP = /:([a-z0-9_-]+):/gi;
const HTML_ELEMENT_REGEXP = /<\/?[^>]+>/g;

export { CUSTOM_EMOJI_REGEXP };

export function renderCustomEmojis(
  html: string,
  emojis: Record<string, string>,
  baseUrl: URL | string,
): string;
export function renderCustomEmojis(
  html: null,
  emojis: Record<string, string>,
  baseUrl: URL | string,
): null;
export function renderCustomEmojis(
  html: string | null,
  emojis: Record<string, string>,
  baseUrl: URL | string,
): string | null;

export function renderCustomEmojis(
  html: string | null,
  emojis: Record<string, string>,
  baseUrl: URL | string,
): string | null {
  if (html == null) return null;
  let result = "";
  let index = 0;
  for (const match of html.matchAll(HTML_ELEMENT_REGEXP)) {
    result += replaceEmojis(html.substring(index, match.index));
    result += match[0];
    index = match.index + match[0].length;
  }
  result += replaceEmojis(html.substring(index));
  return result;

  function replaceEmojis(input: string): string {
    return input.replaceAll(CUSTOM_EMOJI_REGEXP, (match) => {
      const emoji = emojis[match] ?? emojis[match.replace(/^:|:$/g, "")];
      if (typeof emoji !== "string") return match;
      // proxyUrl returns null for non-http(s) schemes; drop the image and
      // keep the literal :shortcode: rather than expose the raw URL.
      const url = proxyUrl(emoji, baseUrl);
      if (url == null) return match;
      return `<img src="${escape(url)}" alt="${match}" class="not-prose" style="display: inline-block; height: 1em; margin: 0; vertical-align: -0.125em">`;
    });
  }
}
