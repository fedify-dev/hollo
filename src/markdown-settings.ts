export const MARKDOWN_EXTENSIONS = [
  "footnote",
  "deflist",
  "sub",
  "sup",
  "mark",
  "ruby",
  "ins",
  "abbr",
  "tasklist",
  "math",
] as const;

export type MarkdownExtension = (typeof MARKDOWN_EXTENSIONS)[number];

export function parseMarkdownExtensions(
  value: string | undefined,
): ReadonlySet<MarkdownExtension> {
  const result = new Set<MarkdownExtension>();
  for (const item of value?.split(",") ?? []) {
    const name = item.trim();
    if (name === "") continue;
    if (!MARKDOWN_EXTENSIONS.includes(name as MarkdownExtension)) {
      throw new Error(
        `Unknown MARKDOWN_EXTENSIONS value: ${name}. Valid values: ${MARKDOWN_EXTENSIONS.join(", ")}`,
      );
    }
    result.add(name as MarkdownExtension);
  }
  return result;
}

export function getMarkdownExtensions(): ReadonlySet<MarkdownExtension> {
  // oxlint-disable-next-line typescript/dot-notation
  return parseMarkdownExtensions(process.env["MARKDOWN_EXTENSIONS"]);
}
