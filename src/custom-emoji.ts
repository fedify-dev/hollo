const CUSTOM_EMOJI_REGEXP = /:([a-z0-9_-]+):/gi;
const HTML_ELEMENT_REGEXP = /<\/?[^>]+>/g;

export { CUSTOM_EMOJI_REGEXP };

export function renderCustomEmojis(
  html: string,
  emojis: Record<string, string>,
): string;
export function renderCustomEmojis(
  html: null,
  emojis: Record<string, string>,
): null;
export function renderCustomEmojis(
  html: string | null,
  emojis: Record<string, string>,
): string | null;

export function renderCustomEmojis(
  html: string | null,
  emojis: Record<string, string>,
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
      if (emoji == null) return match;
      return `<img src="${emoji}" alt="${match}" class="not-prose" style="display: inline-block; height: 1em; margin: 0; vertical-align: -0.125em">`;
    });
  }
}
