let cheerioPromise: Promise<typeof import("cheerio")> | undefined;

const HTML_ELEMENT_REGEXP = /<([a-z][\w:-]*)\b([^>]*)>[\s\S]*?<\/\1>/giu;
const CLASS_ATTRIBUTE_REGEXP =
  /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;

async function getCheerio() {
  if (cheerioPromise == null) {
    cheerioPromise = import("cheerio");
  }
  return await cheerioPromise;
}

export async function extractPreviewLink(
  html: string,
  ignoredLinks: Iterable<string> = [],
  documentUrls: Iterable<string> = [],
): Promise<string | null> {
  const cheerio = await getCheerio();
  const $ = cheerio.load(html);
  const ignored = new Set([...ignoredLinks].map(normalizeLink));
  const documents = new Set([...documentUrls].map(withoutFragment));
  const links = $("a[href]:not([rel=tag]):not(.mention)").toArray().reverse();
  for (const link of links) {
    const href = $(link).attr("href");
    if (
      href == null ||
      href.startsWith("#") ||
      ignored.has(normalizeLink(href))
    )
      continue;
    if (href.includes("#") && documents.has(withoutFragment(href))) continue;
    return href;
  }
  return null;
}

function normalizeLink(link: string): string {
  try {
    return new URL(link).href;
  } catch {
    return link;
  }
}

export async function extractText(html: string | null): Promise<string | null> {
  if (html == null) return null;
  const cheerio = await getCheerio();
  const $ = cheerio.load(html);
  return $(":root").text();
}

export function stripQuoteInlineFallbacks(html: string): string;
export function stripQuoteInlineFallbacks(html: null): null;
export function stripQuoteInlineFallbacks(html: string | null): string | null;

export function stripQuoteInlineFallbacks(html: string | null): string | null {
  if (html == null) return null;
  return html.replaceAll(HTML_ELEMENT_REGEXP, (element, _tag, attributes) =>
    hasQuoteInlineClass(attributes) ? "" : element,
  );
}

function hasQuoteInlineClass(attributes: string): boolean {
  const match = CLASS_ATTRIBUTE_REGEXP.exec(attributes);
  if (match == null) return false;
  return decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "")
    .split(/\s+/)
    .includes("quote-inline");
}

function decodeHtmlEntities(value: string): string {
  return value.replaceAll(
    /&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      const codePoint =
        decimal == null
          ? hexadecimal == null
            ? null
            : Number.parseInt(hexadecimal, 16)
          : Number.parseInt(decimal, 10);
      if (codePoint != null) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return entity;
        }
      }

      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
        case "&apos;":
          return "'";
        default:
          return entity;
      }
    },
  );
}

function withoutFragment(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value.split("#")[0];
  }
}

/** Repeated cards link to the canonical document without duplicating its IDs. */
export function stripFootnoteIds(html: string): string {
  return html.replaceAll(
    /(<(?:a|li)\b[^>]*?)\s+id="(?:fn|fnref)-hollo-[^"<>]+"/giu,
    "$1",
  );
}
