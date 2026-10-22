import {
  hashtag,
  type PluginOptions as HashtagOptions,
} from "@fedify/markdown-it-hashtag";
import {
  mention,
  type PluginOptions as MentionOptions,
} from "@fedify/markdown-it-mention";
import { ruby } from "@mdit/plugin-ruby";
import MarkdownIt, {
  type Env,
  type MarkdownIt as Parser,
  type StateCore,
  type StateInline,
  type Token,
} from "markdown-it";
import abbr from "markdown-it-abbr";
import deflist from "markdown-it-deflist";
import footnote from "markdown-it-footnote";
import ins from "markdown-it-ins";
import mark from "markdown-it-mark";
import sub from "markdown-it-sub";
import sup from "markdown-it-sup";

import { installDelimiterLinkify } from "./markdown-linkify";
import {
  installMath,
  MARKDOWN_PRESERVE_CLASS,
  MAX_MATH_INPUT,
} from "./markdown-math";
import type { MarkdownExtension } from "./markdown-settings";

export function createMarkdownIt(allowHtml = false): Parser {
  const md = new MarkdownIt({ linkify: true, html: allowHtml });
  md.linkify.set({ fuzzyLink: true, urlAuth: true });
  return md;
}

export interface PostMarkdownOptions {
  extensions: ReadonlySet<MarkdownExtension>;
  documentId: string;
  permalink: string;
  allowHtml?: boolean;
  draft?: boolean;
  mention?: MentionOptions;
  hashtag?: HashtagOptions;
}

// The Fedify plugins publish markdown-it 14 types but support the v15 API.
function plugin<T>(value: unknown): (md: Parser, options: T) => void {
  return value as (md: Parser, options: T) => void;
}

let katexPromise: Promise<typeof import("katex")> | undefined;

export async function createPostMarkdownIt(
  options: PostMarkdownOptions,
): Promise<Parser> {
  const md = createMarkdownIt(options.allowHtml);
  const enabled = options.extensions;
  if (enabled.has("deflist")) {
    md.use(deflist);
    md.renderer.rules.dt_close = () => ":<br></dt>\n";
    // Keep paragraphs even in a tight definition so removing dl/dt/dd does
    // not concatenate a term with its definition.
    md.core.ruler.push("definition_paragraphs", (state) => {
      let depth = 0;
      for (const token of state.tokens) {
        if (token.type === "dd_open") depth++;
        if (
          depth > 0 &&
          (token.type === "paragraph_open" || token.type === "paragraph_close")
        )
          token.hidden = false;
        if (token.type === "dd_close") depth--;
      }
    });
  }
  if (enabled.has("sub")) md.use(sub);
  if (enabled.has("sup")) md.use(sup);
  if (enabled.has("mark")) md.use(mark);
  if (enabled.has("ins")) md.use(ins);
  if (enabled.has("mark") || enabled.has("ins")) installDelimiterLinkify(md);
  if (enabled.has("ruby")) installRuby(md);
  if (enabled.has("abbr")) {
    md.use(abbr);
    md.core.ruler.at("abbr_replace", replaceAbbreviations);
  }
  md.use(plugin<MentionOptions>(mention), options.mention ?? {});
  md.use(plugin<HashtagOptions>(hashtag), options.hashtag ?? {});
  if (enabled.has("footnote")) {
    // after('inline') inserts before the already registered Fedify rules.
    md.use(footnote);
    installFootnoteRenderers(md, options.permalink);
  }
  if (enabled.has("tasklist")) installTasklists(md);
  if (enabled.has("math")) {
    // Loading KaTeX is opt-in. The draft still renders mention tokens, but
    // its math renderer never calls KaTeX.
    if (!options.draft) katexPromise ??= import("katex");
    const engine = options.draft
      ? () => ""
      : (await katexPromise!).renderToString;
    installMath(md, engine, options.draft);
  }
  md.core.ruler.before("block", "post_markdown_environment", (state) => {
    state.env.mentions = [];
    state.env.hashtags = [];
    state.env.links = [];
    state.env.previewLink = null;
    state.env.visibleText = [];
    state.env.docId = `hollo-${options.documentId}`;
    delete state.env.footnotes;
    delete state.env.abbreviations;
    if (enabled.has("math")) {
      const allowMath = state.src.length <= MAX_MATH_INPUT;
      if (allowMath) {
        md.inline.ruler.enable(["math_inline"]);
        md.block.ruler.enable(["math_block"]);
      } else {
        md.inline.ruler.disable(["math_inline"]);
        md.block.ruler.disable(["math_block"]);
      }
    }
  });
  md.core.ruler.push("post_markdown_metadata", (state) => {
    const links = state.env.links as string[];
    const visibleText = state.env.visibleText as string[];
    for (const token of walkTokens(state.tokens)) {
      if (token.type.startsWith("math_")) continue;
      if (token.type === "link_open" || token.type === "image") {
        const attribute = token.type === "image" ? "src" : "href";
        const link = token.attrGet(attribute);
        if (link != null) {
          const original = String(link);
          const external = /^https?:\/\//u.test(original);
          const absolute = external
            ? original
            : new URL(original, new URL("/", options.permalink)).href;
          token.attrSet(attribute, absolute);
          // Match legacy metadata: resolving a relative href must not start
          // a new preview or quote lookup.
          if (external) {
            links.push(absolute);
            state.env.previewLink = absolute;
          }
        }
      }
      if (token.children == null && token.content !== "")
        visibleText.push(token.content);
    }
  });
  return md;
}

export function* walkTokens(tokens: Token[]): Generator<Token> {
  for (const token of tokens) {
    yield token;
    if (
      token.children != null &&
      token.type !== "image" &&
      !token.type.startsWith("math_")
    )
      yield* walkTokens(token.children);
  }
}

function installFootnoteRenderers(md: Parser, permalink: string): void {
  const url = new URL(permalink);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Post permalink must be an HTTP(S) URL");
  const target = (id: string) => {
    const result = new URL(url);
    result.hash = id;
    return md.utils.escapeHtml(result.href);
  };
  const id = (token: Token, env: Env = {}) =>
    `${String(env.docId)}-${Number(token.meta?.id) + 1}`;
  const referenceId = (token: Token, env: Env = {}) =>
    `fnref-${id(token, env)}${Number(token.meta?.subId) > 0 ? `:${Number(token.meta?.subId)}` : ""}`;
  md.renderer.rules.footnote_ref = (tokens, idx, _opts, env) => {
    const token = tokens[idx];
    const name = referenceId(token, env);
    return `<sup class="footnote-ref"><a href="${target(`fn-${id(token, env)}`)}" id="${md.utils.escapeHtml(name)}">[${Number(token.meta?.id) + 1}]</a></sup>`;
  };
  md.renderer.rules.footnote_open = (tokens, idx, _opts, env) =>
    `<li id="${md.utils.escapeHtml(`fn-${id(tokens[idx], env)}`)}" class="footnote-item"><span class="footnote-number">[${Number(tokens[idx].meta?.id) + 1}]</span> `;
  md.renderer.rules.footnote_anchor = (tokens, idx, _opts, env) =>
    ` <a href="${target(referenceId(tokens[idx], env))}" class="footnote-backref">↩︎</a>`;
}

function installTasklists(md: Parser): void {
  md.core.ruler.before("inline", "tasklist_source", (state) => {
    for (let i = 0; i + 2 < state.tokens.length; i++) {
      const item = state.tokens[i];
      const paragraph = state.tokens[i + 1];
      const inline = state.tokens[i + 2];
      if (
        item.type !== "list_item_open" ||
        paragraph.type !== "paragraph_open" ||
        inline.type !== "inline"
      )
        continue;
      const match = /^\[([ xX])\](?:[ \t]+|$)/u.exec(inline.content);
      if (match == null) continue;
      inline.meta = {
        ...inline.meta,
        taskStatus: match[1].toLowerCase() === "x",
      };
      inline.content = inline.content.slice(match[0].length);
      item.attrJoin("class", "task-list-item");
    }
  });
  md.core.ruler.push("tasklist_marker", (state) => {
    for (const token of state.tokens) {
      if (
        token.type !== "inline" ||
        typeof token.meta?.taskStatus !== "boolean"
      )
        continue;
      const marker = new state.Token("text", "", 0);
      marker.content = token.meta.taskStatus ? "[x] " : "[ ] ";
      token.children?.unshift(marker);
    }
  });
}

function replaceAbbreviations(state: StateCore): void {
  const definitions = state.env.abbreviations as
    | Record<string, string>
    | undefined;
  if (definitions == null) return;
  const labels = Object.keys(definitions)
    .map((label) => label.slice(1))
    .sort((a, b) => b.length - a.length);
  if (labels.length === 0) return;
  const boundary = "[\\p{P}\\p{Z}\\s$+<=>^`|~]";
  const regexp = new RegExp(
    `(^|${boundary})(${labels.map(RegExp.escape).join("|")})(?=$|${boundary})`,
    "gu",
  );
  const expanded = new Set<string>();
  for (const block of state.tokens) {
    if (block.type !== "inline" || block.children == null) continue;
    let depth = 0;
    let htmlDepth = 0;
    const output: Token[] = [];
    for (const token of block.children) {
      if (token.type === "link_open") depth++;
      if (token.type === "link_close") depth--;
      if (token.type === "html_inline") {
        if (/^<a(?:\s|>)/iu.test(token.content)) htmlDepth++;
        if (/^<\/a\s*>/iu.test(token.content))
          htmlDepth = Math.max(0, htmlDepth - 1);
      }
      if (token.type !== "text" || depth > 0 || htmlDepth > 0) {
        output.push(token);
        continue;
      }
      let pos = 0;
      for (const match of token.content.matchAll(regexp)) {
        const start = match.index + match[1].length;
        if (start > pos) {
          const text = new state.Token("text", "", 0);
          text.content = token.content.slice(pos, start);
          output.push(text);
        }
        const label = match[2];
        const title = definitions[`:${label}`];
        const open = new state.Token("abbr_open", "abbr", 1);
        open.attrs = [["title", title]];
        const text = new state.Token("text", "", 0);
        text.content = label;
        output.push(open, text, new state.Token("abbr_close", "abbr", -1));
        if (!expanded.has(label)) {
          const expansion = new state.Token("text", "", 0);
          expansion.content = ` (${title})`;
          output.push(expansion);
          expanded.add(label);
        }
        pos = start + label.length;
      }
      if (pos < token.content.length) {
        const rest = new state.Token("text", "", 0);
        rest.content = token.content.slice(pos);
        output.push(rest);
      }
    }
    block.children = output;
  }
}

function installRuby(md: Parser): void {
  const previous = new Set(md.inline.ruler.getRules(""));
  md.use(ruby);
  const rule = md.inline.ruler
    .getRules("")
    .find((candidate) => !previous.has(candidate))!;
  // Limit ruby to a non-nested brace pair. Pre-index failed candidates so
  // malformed '{' runs cannot make the upstream scanner quadratic.
  const cache = new WeakMap<
    StateInline,
    { colon: Int32Array; close: Int32Array; open: Int32Array }
  >();
  md.inline.ruler.at("ruby", (state, silent) => {
    if (silent || state.src[state.pos] !== "{") return false;
    let index = cache.get(state);
    if (index == null) {
      const n = state.src.length;
      index = {
        colon: new Int32Array(n + 1).fill(-1),
        close: new Int32Array(n + 1).fill(-1),
        open: new Int32Array(n + 1).fill(-1),
      };
      let colon = -1;
      let close = -1;
      let open = -1;
      for (let i = n - 1; i >= 0; i--) {
        index.colon[i] = colon;
        index.close[i] = close;
        index.open[i] = open;
        if (state.src[i - 1] === "\\") continue;
        if (state.src[i] === ":") colon = i;
        if (state.src[i] === "}") close = i;
        if (state.src[i] === "{") open = i;
      }
      cache.set(state, index);
    }
    const start = state.pos;
    const close = index.close[start];
    const colon = index.colon[start];
    if (
      close < 0 ||
      close >= state.posMax ||
      colon <= start + 1 ||
      colon >= close - 1 ||
      (index.open[start] >= 0 && index.open[start] < close)
    )
      return false;
    return rule(state, silent);
  });
  md.renderer.rules.ruby_open = () =>
    `<ruby class="${MARKDOWN_PRESERVE_CLASS}">`;
  md.renderer.rules.rt_open = () => "<rp>(</rp><rt>";
  md.renderer.rules.rt_close = () => "</rt><rp>)</rp>";
}
