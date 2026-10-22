// These plugins have no declarations for markdown-it 15.  Hollo uses only
// their default, single-argument plugin entry points.
declare module "markdown-it-footnote" {
  const plugin: (md: import("markdown-it").MarkdownIt) => void;
  export default plugin;
}
declare module "markdown-it-deflist" {
  const plugin: (md: import("markdown-it").MarkdownIt) => void;
  export default plugin;
}
declare module "markdown-it-sub" {
  const plugin: (md: import("markdown-it").MarkdownIt) => void;
  export default plugin;
}
declare module "markdown-it-sup" {
  const plugin: (md: import("markdown-it").MarkdownIt) => void;
  export default plugin;
}
declare module "markdown-it-mark" {
  const plugin: (md: import("markdown-it").MarkdownIt) => void;
  export default plugin;
}
declare module "markdown-it-ins" {
  const plugin: (md: import("markdown-it").MarkdownIt) => void;
  export default plugin;
}
declare module "markdown-it-abbr" {
  const plugin: (md: import("markdown-it").MarkdownIt) => void;
  export default plugin;
}
