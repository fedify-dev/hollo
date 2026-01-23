/**
 * Search query parsing and SQL building module.
 *
 * This module provides functionality to parse advanced search queries
 * and convert them into SQL conditions for filtering posts.
 *
 * @example
 * ```typescript
 * import { parseSearchQuery, buildSearchFilter } from "./search";
 *
 * const query = "from:alice has:media -is:sensitive";
 * const ast = parseSearchQuery(query);
 * if (ast) {
 *   const filter = buildSearchFilter(ast);
 *   const results = await db.query.posts.findMany({
 *     where: and(filter, isNull(posts.sharingId)),
 *   });
 * }
 * ```
 *
 * ## Supported Operators
 *
 * - `has:media` / `has:poll` - Filter by attachments
 * - `is:reply` / `is:sensitive` - Filter by post type
 * - `language:xx` - Filter by ISO 639-1 language code
 * - `from:username` - Filter by author (supports `@user`, `user@domain`)
 * - `mentions:username` - Filter by mentioned user
 * - `before:YYYY-MM-DD` / `after:YYYY-MM-DD` - Filter by date range
 * - Negation with `-` prefix (e.g., `-has:media`)
 * - `OR` operator for alternative matches
 * - Parentheses for grouping (e.g., `(from:alice OR from:bob) has:poll`)
 *
 * @module
 */

export { buildSearchFilter } from "./builder";
export { parseSearchQuery } from "./parser";
export type {
  AfterOperator,
  AndNode,
  BeforeOperator,
  FromOperator,
  HasOperator,
  IsOperator,
  LanguageOperator,
  MentionsOperator,
  Operator,
  OrNode,
  SearchNode,
  TermNode,
  TextOperator,
} from "./types";
