import { hashtag } from "@fedify/markdown-it-hashtag";
import { mention } from "@fedify/markdown-it-mention";
import { type DocumentLoader, isActor, lookupObject } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import Shiki from "@shikijs/markdown-it";
import * as cheerio from "cheerio";
import { type ExtractTablesWithRelations, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { escape } from "es-toolkit";
import MarkdownIt from "markdown-it";
import replaceLink from "markdown-it-replace-link";
import { persistAccount } from "./federation/account";
import { type ASPost, isPost } from "./federation/post";
import * as schema from "./schema";
import type { Uuid } from "./uuid";

const logger = getLogger(["hollo", "text"]);

// biome-ignore lint/complexity/useLiteralKeys: tsc claims about this
const ALLOW_HTML = process.env["ALLOW_HTML"]?.trim()?.toLowerCase() === "true";

export interface FormatResult {
  html: string;
  mentions: Uuid[];
  hashtags: string[];
  emojis: Record<string, string>;
  previewLink: string | null;
  quoteTarget: ASPost | null;
}

interface Env {
  hashtags: string[];
  previewLink: string | null;
  links: string[];
}

const CUSTOM_EMOJI_REGEXP = /:([a-z0-9_-]+):/gi;

const shiki = await Shiki({
  themes: {
    light: "one-light",
    dark: "one-dark-pro",
  },
  defaultColor: "light-dark()",
});

export async function formatText(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  text: string,
  options: {
    url: URL | string;
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  },
): Promise<FormatResult> {
  // List all mentions:
  const draft = new MarkdownIt({ linkify: true, html: ALLOW_HTML })
    .use(mention, {})
    .use(hashtag, {});
  const draftEnv: { mentions: string[] } = { mentions: [] };
  draft.render(text, draftEnv);

  // Collect already persisted accounts:
  const handles: Record<string, { id: Uuid; href: string }> = {};
  const handleList =
    draftEnv.mentions.length > 0
      ? await db
          .select({
            handle: schema.accounts.handle,
            id: schema.accounts.id,
            url: schema.accounts.url,
            iri: schema.accounts.iri,
          })
          .from(schema.accounts)
          .where(inArray(schema.accounts.handle, draftEnv.mentions))
      : [];
  for (const { handle, id, url, iri } of handleList) {
    handles[handle] = { href: url ?? iri, id };
  }

  // Persist new accounts:
  for (const mention of draftEnv.mentions) {
    if (mention in handles) continue;
    const actor = await lookupObject(mention, options);
    if (!isActor(actor) || actor.id == null) continue;
    const account = await persistAccount(db, actor, options.url, options);
    if (account == null) continue;
    handles[account.handle] = {
      href: account.url ?? account.iri,
      id: account.id,
    };
  }

  // Collect custom emojis:
  const emojis: string[] = [];
  for (const m of text.matchAll(CUSTOM_EMOJI_REGEXP)) emojis.push(m[1]);
  const customEmojis =
    emojis.length > 0
      ? await db.query.customEmojis.findMany({
          where: inArray(schema.customEmojis.shortcode, emojis),
        })
      : [];

  // Render the final HTML:
  const md = new MarkdownIt({ linkify: true, html: ALLOW_HTML })
    .use(mention, {
      link(handle) {
        if (handle in handles) return handles[handle].href;
        return null;
      },
      linkAttributes(handle: string) {
        return {
          "data-account-id": handles[handle].id,
          "data-account-handle": handle,
          translate: "no",
          class: "h-card u-url mention",
        };
      },
      label(handle: string) {
        const bareHandle = handle.replaceAll(/(?:^@)|(?:@[^@]+$)/g, "");
        return `@<span>${escape(bareHandle)}</span>`;
      },
    })
    .use(hashtag, {
      link(tag) {
        return new URL(
          `/tags/${encodeURIComponent(tag.substring(1))}`,
          options.url,
        ).href;
      },
      linkAttributes(tag: string) {
        return {
          "data-tag": tag.substring(1),
          class: "mention hashtag",
          rel: "tag",
        };
      },
      label(tag: string) {
        return `#<span>${escape(tag.substring(1))}</span>`;
      },
    })
    // biome-ignore lint/suspicious/noExplicitAny: untyped
    .use(replaceLink as any, {
      processHTML: false,
      replaceLink(link: string, env: Env) {
        if (link.startsWith("http://") || link.startsWith("https://")) {
          env.links.push(link);
          env.previewLink = link;
          return link;
        }
        return new URL(link, new URL("/", options.url)).href;
      },
    })
    .use(shiki);
  const env: Env = {
    hashtags: [],
    previewLink: null,
    links: [],
  };
  const html = md.render(text, env);
  logger.debug("Markdown-It environment: {env}", { env });
  let quoteTarget: ASPost | null = null;
  for (const link of env.links) {
    const object = await lookupObject(link, options);
    if (isPost(object)) {
      quoteTarget = object;
      break;
    }
  }
  return {
    html: cleanupRedundantWhitespacesInHtml(html),
    mentions: Object.values(handles).map((v) => v.id),
    hashtags: env.hashtags,
    previewLink: env.previewLink,
    quoteTarget,
    emojis: Object.fromEntries(
      customEmojis.map((emoji) => [`:${emoji.shortcode}:`, emoji.url]),
    ),
  };
}

export function cleanupRedundantWhitespacesInHtml(html: string): string {
  return html.replaceAll(
    /(<\/(?:h[123456r]|li|ol|p|pre|ul)?>)\s+(<(?:h[123456r]|li|ol|p|pre|ul)>)/g,
    (_, a, b) => a + b,
  );
}

const HTML_ELEMENT_REGEXP = /<\/?[^>]+>/g;

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

  function replaceEmojis(html: string): string {
    return html.replaceAll(CUSTOM_EMOJI_REGEXP, (match) => {
      const emoji = emojis[match] ?? emojis[match.replace(/^:|:$/g, "")];
      if (emoji == null) return match;
      return `<img src="${emoji}" alt="${match}" style="height: 1em">`;
    });
  }
}

export async function extractCustomEmojis(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  text: string,
): Promise<Record<string, string>> {
  const emojis = new Set<string>();
  for (const m of text.matchAll(CUSTOM_EMOJI_REGEXP)) emojis.add(m[1]);
  const customEmojis =
    emojis.size > 0
      ? await db.query.customEmojis.findMany({
          where: inArray(schema.customEmojis.shortcode, [...emojis]),
        })
      : [];
  return Object.fromEntries(
    customEmojis.map((emoji) => [`:${emoji.shortcode}:`, emoji.url]),
  );
}

export function extractPreviewLink(html: string): string | null {
  const $ = cheerio.load(html);
  return $("a[href]:not([rel=tag]):not(.mention):last").attr("href") ?? null;
}

export function extractText(html: string | null): string | null {
  if (html == null) return null;
  const $ = cheerio.load(html);
  return $(":root").text();
}

// biome-ignore lint/complexity/useLiteralKeys: tsc claims about this
const SEONBI_URL = process.env["SEONBI_URL"];

export async function formatPostContent(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  text: string,
  language: string | null | undefined,
  options: {
    url: URL | string;
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  },
): Promise<FormatResult> {
  const result = await formatText(db, text, options);
  if (
    SEONBI_URL != null &&
    (language === "ko" || language?.startsWith("ko-"))
  ) {
    const response = await fetch(SEONBI_URL, {
      method: "POST",
      body: JSON.stringify({
        content: result.html,
        contentType: "text/html",
        quote: "HorizontalCornerBrackets",
        cite: "AngleQuotes",
        arrow: {
          bidirArrow: true,
          doubleArrow: true,
        },
        ellipsis: true,
        emDash: true,
        stop: "Horizontal",
        hanja: {
          rendering: "HanjaInRuby",
          reading: {
            initialSoundLaw: true,
            useDictionaries: ["kr-stdict"],
            dictionary: {},
          },
        },
      }),
    });
    try {
      const seonbiResult = await response.json();
      if (seonbiResult.success) {
        result.html = seonbiResult.content;
        if (
          Array.isArray(seonbiResult.warnings) &&
          seonbiResult.warnings.length > 0
        ) {
          logger.warn("Seonbi warnings: {warnings}", {
            warnings: seonbiResult.warnings,
          });
        }
      } else {
        logger.error("Seonbi failed to format post content: {message}", {
          message: seonbiResult.message,
        });
      }
    } catch (error) {
      logger.error("Failed to format post content with Seonbi: {error}", {
        error,
      });
    }
  }
  return result;
}

// cSpell: ignore linkify shiki shikijs
