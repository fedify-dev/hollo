import { MATH_CLASS } from "./markdown-math";
import { proxyUrl } from "./media-proxy";

const CUSTOM_EMOJI_REGEXP = /:([a-z0-9_-]+):/gi;
const HTML_ELEMENT_REGEXP =
  /<!--[\s\S]*?-->|<\/?[a-z][a-z0-9:-]*(?:"[^"]*"|'[^']*'|[^'">])*>/gi;

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
  let protectedTag: string | undefined;
  let protectedDepth = 0;
  for (const match of html.matchAll(HTML_ELEMENT_REGEXP)) {
    const text = html.substring(index, match.index);
    result += protectedDepth > 0 ? text : replaceEmojis(text);
    result += match[0];
    index = match.index + match[0].length;
    const tag = /^<(\/)?([a-z][a-z0-9:-]*)\b/i.exec(match[0]);
    if (tag == null) continue;
    const name = tag[2].toLowerCase();
    if (protectedDepth > 0) {
      if (name === protectedTag) {
        if (tag[1]) protectedDepth--;
        else if (!/\/\s*>$/.test(match[0])) protectedDepth++;
      }
    } else if (!tag[1] && !/\/\s*>$/.test(match[0])) {
      // Consume whole attribute values so a class-looking string inside a
      // title or other quoted value cannot suppress ordinary emoji rendering.
      const attributes = match[0]
        .substring(tag[0].length)
        .matchAll(
          /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
        );
      let classes: string[] = [];
      for (const attribute of attributes) {
        if (attribute[1].toLowerCase() === "class") {
          classes = (attribute[2] ?? attribute[3] ?? attribute[4] ?? "").split(
            /\s+/,
          );
          break;
        }
      }
      if (
        name === "math" ||
        ((name === "span" || name === "div") && classes.includes(MATH_CLASS))
      ) {
        protectedTag = name;
        protectedDepth = 1;
      }
    }
  }
  const tail = html.substring(index);
  result += protectedDepth > 0 ? tail : replaceEmojis(tail);
  return result;

  function replaceEmojis(input: string): string {
    return input.replaceAll(CUSTOM_EMOJI_REGEXP, (match) => {
      const emoji = emojis[match] ?? emojis[match.replace(/^:|:$/g, "")];
      if (emoji == null) return match;
      // proxyUrl returns null for non-http(s) schemes; drop the image and
      // keep the literal :shortcode: rather than expose the raw URL.
      const url = proxyUrl(emoji, baseUrl);
      if (url == null) return match;
      return `<img src="${url}" alt="${match}" class="not-prose" style="display: inline-block; height: 1em; margin: 0; vertical-align: -0.125em">`;
    });
  }
}
