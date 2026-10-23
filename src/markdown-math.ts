import type { KatexOptions } from "katex";
import type {
  Env,
  MarkdownIt,
  StateBlock,
  StateInline,
  Token,
} from "markdown-it";

export const MARKDOWN_PRESERVE_CLASS = "hollo-markdown-preserve";
export const MATH_CLASS = "hollo-math";
export const MAX_MATH_INPUT = 65_536;
export const MATH_SCAN_WORK = Symbol("math scan work");
const BUDGET = Symbol("math render budget");
const UNSUPPORTED_COLOR = "hollo-untrusted";
const MAX_EXPRESSION = 8_192;
const MAX_EXPRESSIONS = 64;
const MAX_EXPRESSION_OUTPUT = 256 * 1_024;
const MAX_TOTAL_OUTPUT = 1_024 * 1_024;

interface Delimiters {
  single: Int32Array;
  double: Int32Array;
  escaped: Uint8Array;
  visits: number;
}

/** Index each possible closer once, including failed and silent lookahead. */
export function scanMathDelimiters(source: string): Delimiters {
  const n = source.length;
  const single = new Int32Array(n + 1).fill(-1);
  const double = new Int32Array(n + 1).fill(-1);
  const escaped = new Uint8Array(n);
  const whitespace = new Uint8Array(n + 1);
  whitespace[n] = 1;
  let slashes = 0;
  for (let i = 0; i < n; i++) {
    escaped[i] = slashes % 2;
    slashes = source[i] === "\\" ? slashes + 1 : 0;
  }
  for (let i = n - 1; i >= 0; i--) {
    whitespace[i] =
      source[i] === "\n" || (/\s/u.test(source[i]) && whitespace[i + 1])
        ? 1
        : 0;
  }
  let nextSingle = -1;
  let nextDouble = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (source[i] === "\n") nextSingle = -1;
    single[i] = nextSingle;
    double[i] = nextDouble;
    if (source[i] !== "$" || escaped[i]) continue;
    if (source[i + 1] === "$" && whitespace[i + 2]) {
      nextDouble = i;
    }
    if (
      source[i - 1] !== "$" &&
      source[i + 1] !== "$" &&
      i > 0 &&
      !/\s/u.test(source[i - 1]) &&
      !/\d/u.test(source[i + 1] ?? "")
    ) {
      nextSingle = i;
    }
  }
  return { single, double, escaped, visits: n * 3 };
}

type MathEngine = (source: string, options: KatexOptions) => string;

export function installMath(
  md: MarkdownIt,
  engine: MathEngine,
  draft = false,
): void {
  const cache = new WeakMap<object, Delimiters>();
  // Container parsers temporarily rewrite line indentation. Cache boundaries
  // within each recursive tokenize call, restoring the outer scope afterward.
  const boundaries = new WeakMap<StateBlock, Map<number, Int32Array>>();
  const tokenize = md.block.tokenize;
  md.block.tokenize = function (state, startLine, endLine) {
    const previous = boundaries.get(state);
    boundaries.set(state, new Map());
    try {
      return tokenize.call(this, state, startLine, endLine);
    } finally {
      if (previous == null) boundaries.delete(state);
      else boundaries.set(state, previous);
    }
  };
  function nextBoundary(
    state: StateBlock,
    startLine: number,
    endLine: number,
  ): number {
    const scope = boundaries.get(state);
    let index = scope?.get(state.blkIndent);
    if (index == null) {
      index = new Int32Array(state.lineMax + 1).fill(endLine);
      let next = endLine;
      for (let line = endLine - 1; line >= startLine; line--) {
        if (!state.isEmpty(line) && state.sCount[line] < state.blkIndent)
          next = line;
        index[line] = next;
      }
      scope?.set(state.blkIndent, index);
      state.env[MATH_SCAN_WORK] =
        Number(state.env[MATH_SCAN_WORK] ?? 0) + endLine - startLine;
    }
    return index[startLine];
  }
  // MarkdownIt's plain-text renderer drops unknown token types in image alt
  // text. Give it a text view of math without rendering MathML or changing
  // the tokens used for metadata and normal HTML rendering.
  const inlineAsText = md.renderer.renderInlineAsText;
  md.renderer.renderInlineAsText = function (tokens, options, env) {
    return inlineAsText.call(
      this,
      tokens.map((token) => {
        if (token.type !== "math_inline") return token;
        const literal = Object.create(token) as Token;
        literal.type = "text";
        literal.content = `$${token.content}$`;
        return literal;
      }),
      options,
      env,
    );
  };

  function indices(state: StateInline | StateBlock): Delimiters {
    let result = cache.get(state);
    if (result == null) {
      result = scanMathDelimiters(state.src);
      cache.set(state, result);
      state.env[MATH_SCAN_WORK] =
        Number(state.env[MATH_SCAN_WORK] ?? 0) + result.visits;
    }
    return result;
  }
  md.core.ruler.before("block", "math_budget", (state) => {
    state.env[BUDGET] = { count: 0, bytes: 0 };
    state.env[MATH_SCAN_WORK] = 0;
  });
  md.inline.ruler.before("escape", "math_inline", (state, silent) => {
    // Link-label lookahead must still see its closing bracket. Actual label
    // parsing supplies posMax and can then recognize bounded math normally.
    if (silent) return false;
    const start = state.pos;
    if (
      state.src[start] !== "$" ||
      state.src[start + 1] === "$" ||
      state.src[start - 1] === "$" ||
      start + 1 >= state.posMax ||
      /\s/u.test(state.src[start + 1])
    )
      return false;
    const index = indices(state);
    if (index.escaped[start]) return false;
    const end = index.single[start];
    if (end < 0 || end >= state.posMax) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = state.src.slice(start + 1, end);
      token.markup = "$";
    }
    state.pos = end + 1;
    return true;
  });
  md.block.ruler.before(
    "fence",
    "math_block",
    (state, startLine, endLine, silent) => {
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const start = state.bMarks[startLine] + state.tShift[startLine];
      if (state.src.slice(start, start + 2) !== "$$") return false;
      const index = indices(state);
      const end = index.double[start + 1];
      if (
        end < 0 ||
        endLine <= startLine ||
        end + 2 > state.eMarks[endLine - 1]
      )
        return false;
      let low = startLine;
      let high = endLine;
      while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if (state.bMarks[middle] <= end) low = middle;
        else high = middle;
      }
      if (end < state.bMarks[low] || state.sCount[low] < state.blkIndent)
        return false;
      if (low >= nextBoundary(state, startLine, endLine)) return false;
      if (silent) return true;
      const body = state
        .getLines(startLine, low + 1, state.blkIndent, false)
        .trimStart();
      const token = state.push("math_block", "math", 0);
      token.block = true;
      token.markup = "$$";
      token.map = [startLine, low + 1];
      token.content = body.slice(2, body.lastIndexOf("$$"));
      state.line = low + 1;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );

  function render(source: string, block: boolean, env: Env = {}): string {
    const tag = block ? "div" : "span";
    const delimiters = block ? "$$" : "$";
    const literal = () =>
      `<${tag} class="${MATH_CLASS} ${MARKDOWN_PRESERVE_CLASS}">${md.utils.escapeHtml(delimiters + source + delimiters)}</${tag}>`;
    if (draft) return literal();
    const budget = env[BUDGET] as { count: number; bytes: number };
    if (++budget.count > MAX_EXPRESSIONS || source.length > MAX_EXPRESSION)
      return literal();
    try {
      const html = engine(source, {
        output: "mathml",
        displayMode: block,
        trust: () => {
          throw new Error("Untrusted math command");
        },
        strict: "ignore",
        errorColor: UNSUPPORTED_COLOR,
        throwOnError: true,
        maxExpand: 1_000,
        maxSize: 10,
        macros: {},
      });
      // KaTeX rejects malformed URL schemes before calling trust(). Its
      // unsupported-command renderer uses this distinct error color instead
      // of throwing; preserve all arguments through the same literal fallback.
      if (html.includes(`mathcolor="${UNSUPPORTED_COLOR}"`)) return literal();
      const bytes = Buffer.byteLength(html);
      if (
        bytes > MAX_EXPRESSION_OUTPUT ||
        budget.bytes + bytes > MAX_TOTAL_OUTPUT
      )
        return literal();
      budget.bytes += bytes;
      return html.replace(
        /<math(?=[ >])/u,
        `<math class="${MATH_CLASS} ${MARKDOWN_PRESERVE_CLASS}"`,
      );
    } catch {
      return literal();
    }
  }
  md.renderer.rules.math_inline = (tokens, idx, _options, env) =>
    render(tokens[idx].content, false, env);
  md.renderer.rules.math_block = (tokens, idx, _options, env) =>
    render(tokens[idx].content, true, env) + "\n";
}
