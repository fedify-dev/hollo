import MarkdownIt, {
  type Delimiter,
  type MarkdownIt as Parser,
  type StateInline,
} from "markdown-it";

// Obtain the built-in rule through the public Ruler API, without importing
// markdown-it's private files or copying its URL parsing implementation.
const reference = new MarkdownIt();
reference.inline.ruler.enableOnly(["linkify"]);
const [linkify] = reference.inline.ruler.getRules("");

export const DELIMITER_SCAN_WORK = Symbol("delimiter scan work");

export function installDelimiterLinkify(md: Parser): void {
  const closerCache = new WeakMap<StateInline, Map<number, Int32Array>>();
  const balanceCache = new WeakMap<
    Delimiter[],
    { index: number; counts: Map<number, number> }
  >();
  function openMarkers(state: StateInline): number[] {
    const delimiters = state.delimiters;
    let cached = balanceCache.get(delimiters);
    if (cached == null || cached.index > delimiters.length) {
      cached = { index: 0, counts: new Map() };
      balanceCache.set(delimiters, cached);
    }
    while (cached.index < delimiters.length) {
      const d = delimiters[cached.index++];
      if (d.marker !== 61 && d.marker !== 43) continue;
      const count = cached.counts.get(d.marker) ?? 0;
      if (d.close && count > 0) cached.counts.set(d.marker, count - 1);
      else if (d.open) cached.counts.set(d.marker, count + 1);
    }
    return [...cached.counts]
      .filter(([, count]) => count > 0)
      .map(([marker]) => marker);
  }
  function closers(state: StateInline): Map<number, Int32Array> {
    const existing = closerCache.get(state);
    if (existing != null) return existing;
    const result = new Map([
      [61, new Int32Array(state.src.length + 1).fill(-1)],
      [43, new Int32Array(state.src.length + 1).fill(-1)],
    ]);
    let slashes = 0;
    let work = 0;
    const originalMax = state.posMax;
    state.posMax = state.src.length;
    try {
      for (let i = 0; i < state.src.length; i++) {
        work++;
        const marker = state.src.charCodeAt(i);
        const escaped = slashes % 2 !== 0;
        slashes = marker === 92 ? slashes + 1 : 0;
        if (escaped || (marker !== 61 && marker !== 43)) continue;
        const scanned = state.scanDelims(i, true);
        if (scanned.length >= 2 && scanned.can_close)
          result.get(marker)![i] = i;
        i += scanned.length - 1;
        work += scanned.length - 1;
      }
    } finally {
      state.posMax = originalMax;
    }
    for (const list of result.values()) {
      let next = -1;
      for (let i = state.src.length - 1; i >= 0; i--) {
        work++;
        const current = list[i];
        list[i] = next;
        if (current >= 0) next = current;
      }
    }
    state.env[DELIMITER_SCAN_WORK] =
      Number(state.env[DELIMITER_SCAN_WORK] ?? 0) + work;
    closerCache.set(state, result);
    return result;
  }
  md.inline.ruler.at("linkify", (state, silent) => {
    if (
      state.src[state.pos] !== ":" ||
      state.linkLevel > 0 ||
      !md.options.linkify
    )
      return linkify(state, silent);
    const markers = openMarkers(state);
    if (markers.length === 0) return linkify(state, silent);
    const scheme = /[a-z][a-z\d+.-]*$/iu.exec(state.pending.slice(-10))?.[0];
    if (scheme == null) return linkify(state, silent);
    const start = state.pos - scheme.length;
    const match = md.linkify.matchAtStart(state.src.slice(start));
    if (match == null) return linkify(state, silent);
    let end = start + match.url.length;
    for (const marker of markers) {
      const close = closers(state).get(marker)![state.pos];
      if (close >= state.pos && close < end && close < state.posMax)
        end = close;
    }
    if (end === start + match.url.length) return linkify(state, silent);
    const source = state.src;
    const pos = state.pos;
    const max = state.posMax;
    state.src = source.slice(start, end);
    state.pos = scheme.length;
    state.posMax = state.src.length;
    let matched = false;
    let consumed = 0;
    try {
      matched = linkify(state, silent);
      consumed = state.pos - scheme.length;
      return matched;
    } finally {
      state.src = source;
      state.pos = matched ? pos + consumed : pos;
      state.posMax = max;
    }
  });
}
