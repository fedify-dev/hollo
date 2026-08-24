/**
 * Search query SQL builder.
 *
 * Converts a parsed search AST into Drizzle ORM SQL conditions.
 */

import {
  and,
  eq,
  gte,
  ilike,
  isNotNull,
  lt,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { posts } from "../schema";
import type {
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

/**
 * Build a SQL filter condition from a search AST node.
 *
 * @param node The search AST node to convert.
 * @returns A Drizzle SQL condition that can be used in a where clause.
 *
 * @example
 * ```typescript
 * const ast = parseSearchQuery("from:alice has:media");
 * const results = await db.query.posts.findMany({
 *   where: {
 *     RAW: (posts, { and, isNull }) =>
 *       and(buildSearchFilter(ast, posts), isNull(posts.sharingId)),
 *   },
 * });
 * ```
 */
type PostsTable = typeof posts;

export function buildSearchFilter(
  node: SearchNode,
  table: PostsTable = posts,
): SQL {
  switch (node.type) {
    case "term":
      return buildTermFilter(node, table);
    case "and":
      return buildAndFilter(node, table);
    case "or":
      return buildOrFilter(node, table);
  }
}

/**
 * Build filter for a single term node.
 */
function buildTermFilter(node: TermNode, table: PostsTable): SQL {
  const condition = buildOperatorFilter(node.operator, table);
  return node.negated ? not(condition)! : condition;
}

/**
 * Build filter for an AND node.
 */
function buildAndFilter(node: AndNode, table: PostsTable): SQL {
  const conditions = node.children.map((child) =>
    buildSearchFilter(child, table),
  );
  return and(...conditions)!;
}

/**
 * Build filter for an OR node.
 */
function buildOrFilter(node: OrNode, table: PostsTable): SQL {
  const conditions = node.children.map((child) =>
    buildSearchFilter(child, table),
  );
  return or(...conditions)!;
}

/**
 * Build filter for a specific operator.
 */
function buildOperatorFilter(operator: Operator, table: PostsTable): SQL {
  switch (operator.type) {
    case "text":
      return buildTextFilter(operator, table);
    case "has":
      return buildHasFilter(operator, table);
    case "is":
      return buildIsFilter(operator, table);
    case "language":
      return buildLanguageFilter(operator, table);
    case "from":
      return buildFromFilter(operator, table);
    case "mentions":
      return buildMentionsFilter(operator, table);
    case "before":
      return buildBeforeFilter(operator, table);
    case "after":
      return buildAfterFilter(operator, table);
  }
}

/**
 * Build filter for text search.
 * Uses case-insensitive LIKE matching on content.
 */
function buildTextFilter(operator: TextOperator, table: PostsTable): SQL {
  // Escape special LIKE characters
  const escapedValue = operator.value.replace(/%/g, "\\%").replace(/_/g, "\\_");
  return ilike(table.contentHtml, `%${escapedValue}%`);
}

/**
 * Build filter for has: operator.
 */
function buildHasFilter(operator: HasOperator, table: PostsTable): SQL {
  switch (operator.value) {
    case "media":
      // EXISTS (SELECT 1 FROM media WHERE media.post_id = posts.id)
      return sql`EXISTS (SELECT 1 FROM media WHERE media.post_id = ${table.id})`;
    case "poll":
      return isNotNull(table.pollId);
  }
}

/**
 * Build filter for is: operator.
 */
function buildIsFilter(operator: IsOperator, table: PostsTable): SQL {
  switch (operator.value) {
    case "reply":
      return isNotNull(table.replyTargetId);
    case "sensitive":
      return eq(table.sensitive, true);
  }
}

/**
 * Build filter for language: operator.
 */
function buildLanguageFilter(
  operator: LanguageOperator,
  table: PostsTable,
): SQL {
  return eq(table.language, operator.value);
}

/**
 * Build filter for from: operator.
 * Matches accounts by username (without domain) or full handle (with domain).
 */
function buildFromFilter(operator: FromOperator, table: PostsTable): SQL {
  const value = operator.value;

  if (value.includes("@")) {
    // Full handle: username@domain - match exactly as @username@domain
    return sql`EXISTS (SELECT 1 FROM accounts WHERE accounts.id = ${table.accountId} AND accounts.handle = ${`@${value}`})`;
  }
  // Username only - match @username@% pattern
  return sql`EXISTS (SELECT 1 FROM accounts WHERE accounts.id = ${table.accountId} AND accounts.handle LIKE ${`@${value}@%`})`;
}

/**
 * Build filter for mentions: operator.
 * Finds posts that mention a specific user.
 */
function buildMentionsFilter(
  operator: MentionsOperator,
  table: PostsTable,
): SQL {
  const value = operator.value;

  if (value.includes("@")) {
    // Full handle: username@domain
    return sql`EXISTS (SELECT 1 FROM mentions
      JOIN accounts ON accounts.id = mentions.account_id
        WHERE mentions.post_id = ${table.id}
        AND accounts.handle = ${`@${value}`})`;
  }
  // Username only
  return sql`EXISTS (SELECT 1 FROM mentions
      JOIN accounts ON accounts.id = mentions.account_id
      WHERE mentions.post_id = ${table.id}
      AND accounts.handle LIKE ${`@${value}@%`})`;
}

/**
 * Build filter for before: operator.
 * The specified date is NOT included (exclusive).
 */
function buildBeforeFilter(operator: BeforeOperator, table: PostsTable): SQL {
  const date = new Date(operator.value);
  // Set to start of day (00:00:00) for exclusive comparison
  date.setUTCHours(0, 0, 0, 0);
  return lt(table.published, date);
}

/**
 * Build filter for after: operator.
 * The specified date IS included (inclusive).
 */
function buildAfterFilter(operator: AfterOperator, table: PostsTable): SQL {
  const date = new Date(operator.value);
  // Set to start of day (00:00:00) for inclusive comparison
  date.setUTCHours(0, 0, 0, 0);
  return gte(table.published, date);
}
