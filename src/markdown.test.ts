import { load } from "cheerio";
import type { KatexOptions } from "katex";
import MarkdownIt, { type Env } from "markdown-it";
import { describe, expect, it, vi } from "vitest";

import { createMarkdownIt, createPostMarkdownIt } from "./markdown";
import {
  installMath,
  MARKDOWN_PRESERVE_CLASS,
  MATH_SCAN_WORK,
  MAX_MATH_INPUT,
  scanMathDelimiters,
} from "./markdown-math";
import {
  MARKDOWN_EXTENSIONS,
  type MarkdownExtension,
} from "./markdown-settings";

const permalink = "https://example.com/@alice/post";

async function render(
  source: string,
  extensions: readonly MarkdownExtension[] = MARKDOWN_EXTENSIONS,
  options: { documentId?: string; allowHtml?: boolean; draft?: boolean } = {},
) {
  const md = await createPostMarkdownIt({
    extensions: new Set(extensions),
    documentId: "post-a",
    permalink,
    ...options,
  });
  const env: Env = {};
  const html = md.render(source, env);
  return { html, $: load(html), env };
}

describe("post Markdown extensions", () => {
  it.each([
    ["footnote", "word[^a]\n\n[^a]: Note", "[id].footnote-item"],
    ["deflist", "Term\n: Definition", "dl dt"],
    ["sub", "H~2~O", "sub"],
    ["sup", "x^2^", "sup"],
    ["mark", "==marked==", "mark"],
    ["ruby", "{漢字:かんじ}", "ruby rt"],
    ["ins", "++inserted++", "ins"],
    ["abbr", "HTML\n\n*[HTML]: Hypertext Markup Language", "abbr"],
    ["tasklist", "- [x] done", "li.task-list-item"],
    ["math", "$x^2$", "math"],
  ] as const)(
    "enables %s independently",
    async (extension, source, selector) => {
      const { $ } = await render(source, [extension]);
      expect($(selector).length).toBeGreaterThan(0);
    },
  );

  it("keeps optional syntax literal when extensions are disabled", async () => {
    const { $, html } = await render(
      "H~2~O x^2^ ==mark== ++ins++ {漢字:かんじ} $x$\n\n- [x] done",
      [],
    );
    expect($("sub,sup,mark,ins,ruby,math").length).toBe(0);
    expect(html).toContain("[x] done");
    expect($("body").text()).toContain("$x$");
  });

  it("renders all extensions together without losing their structure", async () => {
    const { $ } = await render(
      "HTML H~2~O x^2^ ==mark== ++ins++ {漢字:かんじ} $x$ note[^a]\n\n" +
        "- [x] done\n\nTerm\n: Definition\n\n*[HTML]: Hypertext Markup Language\n\n[^a]: Footnote",
    );
    for (const tag of [
      "abbr",
      "sub",
      "sup",
      "mark",
      "ins",
      "ruby",
      "math",
      "dl",
    ]) {
      expect($(tag).length).toBeGreaterThan(0);
    }
    expect($("input,label").length).toBe(0);
    expect($("li").text()).toContain("[x]");
    expect($(".footnote-item").text()).toContain("Footnote");
  });

  it("retains baseline fuzzy links, credentials, and URL punctuation", () => {
    const md = createMarkdownIt();
    for (const url of [
      "https://user:pass@example.com/a_b*c",
      "https://example.com/?a==b",
    ]) {
      expect(load(md.renderInline(url))("a").attr("href")).toBe(url);
    }
    expect(load(md.renderInline("example.com"))("a").attr("href")).toBe(
      "http://example.com",
    );
  });

  it.each([
    ["mark", "==https://example.com/a==", "mark"],
    ["ins", "++https://example.com/a++", "ins"],
  ] as const)(
    "keeps %s delimiters out of a bare URL",
    async (extension, source, tag) => {
      const { $ } = await render(source + " https://example.com/?a==b", [
        extension,
      ]);
      expect($(`${tag} a`).attr("href")).toBe("https://example.com/a");
      expect($("a").last().attr("href")).toBe("https://example.com/?a==b");
    },
  );

  it.each([
    ["mark", "==", "mark"],
    ["ins", "++", "ins"],
  ] as const)(
    "respects link-label boundaries for %s without nesting autolinks",
    async (extension, delimiter, tag) => {
      const bounded = await render(
        `[${delimiter}https://inner.example/a${delimiter}](https://outer.example/)`,
        [extension],
      );
      expect(bounded.$("a").length).toBe(1);
      expect(bounded.$("a").attr("href")).toBe("https://outer.example/");
      expect(bounded.$(`a ${tag}`).text()).toBe("https://inner.example/a");

      const unbounded = await render(
        `[${delimiter}https://inner.example/a](https://outer.example/) tail${delimiter}`,
        [extension],
      );
      expect(unbounded.$("a").length).toBe(1);
      expect(unbounded.$("a").attr("href")).toBe("https://outer.example/");
      expect(unbounded.$(tag).length).toBe(0);
      expect(unbounded.$("a").text()).toBe(
        `${delimiter}https://inner.example/a`,
      );
    },
  );

  it("resolves relative links without adding preview or quote lookups", async () => {
    const { $, env } = await render("[jump](#part) [path](/about)", []);
    expect($("a").first().attr("href")).toBe("https://example.com/#part");
    expect($("a").last().attr("href")).toBe("https://example.com/about");
    expect(env.links).toEqual([]);
    expect(env.previewLink).toBeNull();
  });

  it("ignores links hidden in image labels while collecting image sources", async () => {
    const { env } = await render(
      "![alt [hidden](https://remote.example/post)](/image.png) ![visible](https://images.example/a.png)",
      [],
    );
    expect(env.links).toEqual(["https://images.example/a.png"]);
    expect(env.previewLink).toBe("https://images.example/a.png");
  });

  it("retains literal math in image alternative text", async () => {
    const { $, env } = await render("![Equation $x^2$](/plot.png)", ["math"]);
    expect($("img").attr("alt")).toBe("Equation $x^2$");
    expect(env.links).toEqual([]);
  });

  it("does not consume another list item as display math", async () => {
    const { $ } = await render("- $$\n  x\n\n- second\n  $$", ["math"]);
    expect($("li").length).toBe(2);
    expect($("li").last().text()).toContain("second");
    expect($("math").length).toBe(0);
  });

  it("preserves absolute HTTP hrefs without eager URL validation", async () => {
    const { $, env } = await render(
      "[quote](https://remote.example/post) [broken](http://)",
      [],
    );
    expect($("a").last().attr("href")).toBe("http://");
    expect(env.links).toEqual(["https://remote.example/post", "http://"]);
  });

  it.each([
    "\\href{https://example.com}{click}",
    "\\href{foo}{click}",
    "\\url{https://example.com}",
    "\\includegraphics{https://example.com/picture.png}",
    "\\htmlId{example}{x}",
    "\\href{1x:y}{click}",
    "\\url{:x}",
    "\\includegraphics{1:x}",
    "\\href{x&colon;y}{click}",
  ])(
    "shows the complete source for a blocked math command: %s",
    async (expression) => {
      const { $, env } = await render(`$${expression}$`, ["math"]);
      expect($("math").length).toBe(0);
      expect($(`.${MARKDOWN_PRESERVE_CLASS}`).text()).toBe(`$${expression}$`);
      expect(env.links).toEqual([]);
    },
  );

  it("uses absolute, document-specific footnote links with actual numbers", async () => {
    const source = "One[^b], two[^a], again[^b].\n\n[^a]: A\n[^b]: B";
    const first = await render(source, ["footnote"], { documentId: "post-a" });
    const second = await render(source, ["footnote"], { documentId: "post-b" });
    expect(first.$(".footnote-ref").first().text()).toContain("1");
    expect(first.$(".footnote-ref").eq(1).text()).toContain("2");
    for (const anchor of first
      .$(".footnote-ref a,.footnote-backref")
      .toArray()) {
      const href = first.$(anchor).attr("href");
      expect(href).toMatch(/^https:\/\/example\.com\/@alice\/post#/u);
      expect(first.$(`[id="${new URL(href!).hash.slice(1)}"]`).length).toBe(1);
    }
    const ids = first
      .$("[id]")
      .toArray()
      .map((element) => first.$(element).attr("id"));
    expect(
      second
        .$("[id]")
        .toArray()
        .map((element) => second.$(element).attr("id")),
    ).not.toEqual(expect.arrayContaining(ids));
    expect(first.env.links).toEqual([]);
    expect(first.env.previewLink).toBeNull();
  });

  it("collects only referenced footnote mentions, hashtags, and preview links", async () => {
    const { env } = await render(
      "Visible[^used]\n\n[^unused]: @hidden@example.net #hidden https://hidden.example/\n" +
        "[^used]: @visible@example.net #visible https://visible.example/",
      ["footnote"],
    );
    expect(env.mentions).toEqual(["@visible@example.net"]);
    expect(env.hashtags).toEqual(["#visible"]);
    expect(env.links).toContain("https://visible.example/");
    expect(env.links).not.toContain("https://hidden.example/");
    expect(env.previewLink).toBe("https://visible.example/");
  });

  it("preserves ordinary punctuation in definition terms and definitions", async () => {
    const { $ } = await render("C++: why?\n: Use a:b; c,d!", ["deflist"]);
    expect($("dt").text()).toBe("C++: why?:");
    expect($("dt br").length).toBe(1);
    expect($("dd").text().trim()).toBe("Use a:b; c,d!");
  });

  it("keeps subscript, superscript, and footnotes distinct", async () => {
    const { $ } = await render("H~2~O x^2^ note[^n]\n\n[^n]: Note", [
      "sub",
      "sup",
      "footnote",
    ]);
    expect($("sub").text()).toBe("2");
    expect($("sup").not(".footnote-ref").text()).toBe("2");
    expect($(".footnote-ref").length).toBe(1);
  });

  it("renders ruby fallback parentheses and marks its container for preservation", async () => {
    const { $ } = await render("{漢字:かんじ}", ["ruby"]);
    expect($("ruby").hasClass(MARKDOWN_PRESERVE_CLASS)).toBe(true);
    expect($("ruby rt").text()).toBe("かんじ");
    expect($("ruby rp").length).toBe(2);
  });

  it("expands the first unlinked abbreviation and preserves Korean word boundaries", async () => {
    const { $ } = await render(
      '[HTML](https://example.org/) <a href="https://example.net/">HTML</a> ' +
        "HTML HTML. HTML은 HTML이다.\n\n*[HTML]: Hypertext Markup Language",
      ["abbr"],
      { allowHtml: true },
    );
    expect($("a abbr").length).toBe(0);
    expect($("abbr").length).toBe(2);
    expect($("abbr").first().text()).toBe("HTML");
    expect($("body").text()).toContain("HTML은 HTML이다.");
    expect($("abbr").attr("title")).toBe("Hypertext Markup Language");
    expect(
      $("body")
        .text()
        .match(/Hypertext Markup Language/gu),
    ).toHaveLength(1);
  });

  it("does not expand abbreviations inside mentions and hashtags", async () => {
    const { $ } = await render(
      "@HTML@example.org #HTML HTML\n\n*[HTML]: Hypertext Markup Language",
      ["abbr"],
    );
    expect($("a abbr").length).toBe(0);
    expect($("abbr").length).toBe(1);
  });

  it("renders accessible text task markers without form controls or stealing references", async () => {
    const { $ } = await render(
      "- [ ] waiting\n- [x] done\n- [X] also done\n\n[x]: https://example.com/\n\n[x]",
      ["tasklist"],
    );
    expect($("input,label").length).toBe(0);
    expect($("li.task-list-item").length).toBe(3);
    expect($("li").eq(0).text()).toContain("[ ]");
    expect($("li").eq(1).text()).toContain("[x]");
    expect($("li").eq(2).text()).toContain("[x]");
    expect($("a").last().attr("href")).toBe("https://example.com/");
  });

  it("uses MathML with original-source annotation and excludes math from visible text", async () => {
    const { $, env } = await render(
      "Before $x^2$ after.\n\n$$\ny = x + 1\n$$",
      ["math"],
    );
    expect($("math").length).toBe(2);
    expect($("annotation[encoding='application/x-tex']").first().text()).toBe(
      "x^2",
    );
    expect(
      $("math").first().closest(`.${MARKDOWN_PRESERVE_CLASS}`).length,
    ).toBe(1);
    const visibleText = (env.visibleText as string[]).join("");
    expect(visibleText).toContain("Before");
    expect(visibleText).toContain("after.");
    expect(visibleText).not.toContain("x^2");
    expect(visibleText).not.toContain("y = x + 1");
  });

  it("keeps currency, escaped dollars, and code literal", async () => {
    const { $, html } = await render("$20 and $30. \\$x$ `$x$`\n\n    $x$", [
      "math",
    ]);
    expect($("math").length).toBe(0);
    expect($("code").text()).toContain("$x$");
    expect(html).toContain("$20");
  });

  it("protects invalid math and keeps TeX macros isolated between formulas", async () => {
    const { $, html } = await render(
      "$\\gdef\\leak{SECRET}$ $\\leak$ $\\notACommand$",
      ["math"],
    );
    expect($("body").text()).toContain("$\\leak$");
    expect($("body").text()).toContain("$\\notACommand$");
    expect(html).toContain(MARKDOWN_PRESERVE_CLASS);
    expect($("math").length).toBeLessThan(3);
  });

  it("keeps draft math literal while preserving final mention discovery", async () => {
    const { $, env } = await render(
      "$@hidden@example.net$ @visible@example.net",
      ["math"],
      { draft: true },
    );
    expect($("math").length).toBe(0);
    expect($("body").text()).toContain("$@hidden@example.net$");
    expect(env.mentions).toEqual(["@visible@example.net"]);
  });

  it("allows math at the UTF-16 document boundary", async () => {
    const source = "$x$ " + "a".repeat(MAX_MATH_INPUT - 4);
    const { $ } = await render(source, ["math"]);
    expect(source.length).toBe(MAX_MATH_INPUT);
    expect($("math").length).toBe(1);
  });

  it("disables math above the document limit while retaining ordinary Markdown", async () => {
    const { $, html } = await render(
      "**bold** $x$ " + "a".repeat(MAX_MATH_INPUT),
      ["math"],
    );
    expect($("math").length).toBe(0);
    expect($("strong").text()).toBe("bold");
    expect(html).toContain("$x$");
  });
});

function mathParser(
  engine = (_source: string, _options: KatexOptions) =>
    "<math><mi>x</mi></math>",
) {
  const md = new MarkdownIt();
  installMath(md, engine);
  return md;
}

describe("math resource limits", () => {
  it("renders at most 64 formulas and resets that budget for every render", () => {
    const engine = vi.fn(() => "<math><mi>x</mi></math>");
    const md = mathParser(engine);
    const source = Array.from({ length: 65 }, () => "$x$").join(" ");
    const html = md.render(source);
    expect(engine).toHaveBeenCalledTimes(64);
    expect(load(html)("math").length).toBe(64);
    expect(load(html)("body").text()).toContain("$x$");
    md.render("$x$");
    expect(engine).toHaveBeenCalledTimes(65);
  });

  it("does not send an oversized expression to the engine", () => {
    const engine = vi.fn(() => "<math><mi>x</mi></math>");
    const $ = load(mathParser(engine).render("$" + "x".repeat(8_193) + "$"));
    expect(engine).not.toHaveBeenCalled();
    expect($("math").length).toBe(0);
    expect($("body").text()).toContain("$" + "x".repeat(8_193) + "$");
  });

  it("falls back to escaped protected text when the engine fails", () => {
    const md = mathParser(() => {
      throw new Error("invalid math");
    });
    const $ = load(md.render("$<script>alert(1)</script>$"));
    expect($("script").length).toBe(0);
    expect($(`.${MARKDOWN_PRESERVE_CLASS}`).text()).toBe(
      "$<script>alert(1)</script>$",
    );
  });

  it("limits both individual and aggregate MathML output in bytes", () => {
    const large = "<math>" + "é".repeat(131_073) + "</math>";
    expect(load(mathParser(() => large).render("$x$"))("math").length).toBe(0);
    const medium = "<math>" + "x".repeat(220_000) + "</math>";
    const html = mathParser(() => medium).render("$a$ $b$ $c$ $d$ $e$");
    expect(load(html)("math").length).toBe(4);
    expect(load(html)("body").text()).toContain("$e$");
  });

  it("gives every expression a separate untrusted, bounded macro environment", () => {
    const macros: NonNullable<KatexOptions["macros"]>[] = [];
    const md = mathParser((_source, options) => {
      macros.push(options.macros!);
      expect(options).toMatchObject({
        output: "mathml",
        trust: expect.any(Function),
        maxExpand: 1_000,
        maxSize: 10,
      });
      expect(options.macros).toEqual({});
      options.macros!["\\example"] = "changed";
      return "<math><mi>x</mi></math>";
    });
    md.render("$a$ $b$");
    expect(macros[0]).not.toBe(macros[1]);
  });

  it("indexes hostile unmatched delimiter input with linear scan work", () => {
    const source = "$a ".repeat(5_000) + "\\$".repeat(2_000);
    expect(scanMathDelimiters(source).visits).toBeLessThanOrEqual(
      source.length * 3,
    );
    const env: Env = {};
    mathParser().render(source, env);
    expect(env[MATH_SCAN_WORK]).toBeLessThanOrEqual(source.length * 6);
  });

  it("respects inline parser boundaries during silent link lookahead", () => {
    const $ = load(
      mathParser().render("[label $x](https://example.com/) tail$"),
    );
    expect($("a").attr("href")).toBe("https://example.com/");
    expect($("a").text()).toBe("label $x");
    expect($("a math").length).toBe(0);
  });

  it("renders bounded inline math inside a Markdown link label", () => {
    const $ = load(mathParser().render("[label $x$](https://example.com/)"));
    expect($("a").attr("href")).toBe("https://example.com/");
    expect($("a math").length).toBe(1);
  });

  it("does not borrow a block math closer from outside its list container", () => {
    const $ = load(mathParser().render("- $$\n  x\n\noutside\n$$"));
    expect($("li math").length).toBe(0);
    expect($("p").text()).toContain("outside");
  });
});
