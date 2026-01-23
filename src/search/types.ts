/**
 * Search query AST (Abstract Syntax Tree) type definitions.
 *
 * This module defines the types for representing parsed search queries
 * as an abstract syntax tree, which can then be converted to SQL conditions.
 */

/**
 * Operator for filtering posts by attachments.
 * - `media`: Posts with media attachments (images, videos, audio)
 * - `poll`: Posts with polls
 */
export interface HasOperator {
  type: "has";
  value: "media" | "poll";
}

/**
 * Operator for filtering posts by their characteristics.
 * - `reply`: Posts that are replies to other posts
 * - `sensitive`: Posts marked as sensitive
 */
export interface IsOperator {
  type: "is";
  value: "reply" | "sensitive";
}

/**
 * Operator for filtering posts by language.
 * Value should be an ISO 639-1 language code (e.g., "en", "ko", "ja").
 */
export interface LanguageOperator {
  type: "language";
  value: string;
}

/**
 * Operator for filtering posts by author.
 * Supports various username formats:
 * - `alice` (local username)
 * - `alice@example.com` (full handle with domain)
 */
export interface FromOperator {
  type: "from";
  value: string;
}

/**
 * Operator for filtering posts that mention a specific user.
 * Supports the same username formats as FromOperator.
 */
export interface MentionsOperator {
  type: "mentions";
  value: string;
}

/**
 * Operator for filtering posts published before a specific date.
 * The date itself is NOT included in the results.
 * Value should be in YYYY-MM-DD format.
 */
export interface BeforeOperator {
  type: "before";
  value: string;
}

/**
 * Operator for filtering posts published after a specific date.
 * The date itself IS included in the results.
 * Value should be in YYYY-MM-DD format.
 */
export interface AfterOperator {
  type: "after";
  value: string;
}

/**
 * Operator for plain text search.
 * Searches in post content using case-insensitive matching.
 */
export interface TextOperator {
  type: "text";
  value: string;
}

/**
 * Union type of all supported search operators.
 */
export type Operator =
  | HasOperator
  | IsOperator
  | LanguageOperator
  | FromOperator
  | MentionsOperator
  | BeforeOperator
  | AfterOperator
  | TextOperator;

/**
 * A terminal node in the search AST representing a single search term.
 * Can be negated with the `-` prefix.
 */
export interface TermNode {
  type: "term";
  operator: Operator;
  negated: boolean;
}

/**
 * A node representing a logical AND of multiple search conditions.
 * All children must match for a post to be included.
 */
export interface AndNode {
  type: "and";
  children: SearchNode[];
}

/**
 * A node representing a logical OR of multiple search conditions.
 * At least one child must match for a post to be included.
 */
export interface OrNode {
  type: "or";
  children: SearchNode[];
}

/**
 * Union type of all AST node types.
 */
export type SearchNode = TermNode | AndNode | OrNode;
