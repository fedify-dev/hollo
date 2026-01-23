/**
 * Search query parser.
 *
 * Parses search query strings into an AST (Abstract Syntax Tree) that can
 * be converted to SQL conditions.
 *
 * Grammar (informal):
 *   query     = orExpr
 *   orExpr    = andExpr ("OR" andExpr)*
 *   andExpr   = term+
 *   term      = "-"? (group | operator | quotedString | word)
 *   group     = "(" orExpr ")"
 *   operator  = operatorName ":" value
 *   quotedString = '"' ... '"' | "'" ... "'"
 *   word      = [^\s()]+
 */

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

// Token types
type TokenType =
  | "LPAREN"
  | "RPAREN"
  | "OR"
  | "NEGATION"
  | "OPERATOR"
  | "QUOTED"
  | "WORD"
  | "EOF";

interface Token {
  type: TokenType;
  value: string;
  operatorName?: string; // For OPERATOR tokens: "has", "is", etc.
  operatorValue?: string; // For OPERATOR tokens: the value after ":"
}

/**
 * Tokenizer: converts input string into tokens.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  const isWhitespace = (ch: string) => /\s/.test(ch);
  const isSpecial = (ch: string) => ch === "(" || ch === ")";

  while (pos < input.length) {
    // Skip whitespace
    if (isWhitespace(input[pos])) {
      pos++;
      continue;
    }

    // Parentheses
    if (input[pos] === "(") {
      tokens.push({ type: "LPAREN", value: "(" });
      pos++;
      continue;
    }
    if (input[pos] === ")") {
      tokens.push({ type: "RPAREN", value: ")" });
      pos++;
      continue;
    }

    // Negation (must be followed by non-space)
    if (
      input[pos] === "-" &&
      pos + 1 < input.length &&
      !isWhitespace(input[pos + 1])
    ) {
      tokens.push({ type: "NEGATION", value: "-" });
      pos++;
      continue;
    }

    // Quoted string
    if (input[pos] === '"' || input[pos] === "'") {
      const quote = input[pos];
      let value = "";
      pos++; // skip opening quote

      let closed = false;
      while (pos < input.length) {
        if (input[pos] === "\\") {
          // Escape sequence
          pos++;
          if (pos < input.length) {
            value += input[pos];
            pos++;
          }
        } else if (input[pos] === quote) {
          closed = true;
          pos++; // skip closing quote
          break;
        } else {
          value += input[pos];
          pos++;
        }
      }

      if (closed) {
        tokens.push({ type: "QUOTED", value });
      } else {
        // Unclosed quote - treat as literal text including the opening quote
        tokens.push({ type: "WORD", value: quote + value });
      }
      continue;
    }

    // Word or operator
    let word = "";
    while (
      pos < input.length &&
      !isWhitespace(input[pos]) &&
      !isSpecial(input[pos])
    ) {
      word += input[pos];
      pos++;
    }

    if (word.length > 0) {
      // Check for OR keyword (case-sensitive, must be uppercase)
      if (word === "OR") {
        tokens.push({ type: "OR", value: "OR" });
        continue;
      }

      // Check for operator pattern: name:value
      const colonIndex = word.indexOf(":");
      if (colonIndex > 0 && colonIndex < word.length - 1) {
        const operatorName = word.substring(0, colonIndex).toLowerCase();
        const operatorValue = word.substring(colonIndex + 1);
        tokens.push({
          type: "OPERATOR",
          value: word,
          operatorName,
          operatorValue,
        });
      } else {
        tokens.push({ type: "WORD", value: word });
      }
    }
  }

  tokens.push({ type: "EOF", value: "" });
  return tokens;
}

/**
 * Parser: converts tokens into AST.
 */
class Parser {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  private current(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const token = this.current();
    if (token.type !== "EOF") {
      this.pos++;
    }
    return token;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  /**
   * Parse the entire query.
   */
  parse(): SearchNode | null {
    const result = this.parseOrExpr();
    return result ? this.simplify(result) : null;
  }

  /**
   * Parse OR expression: andExpr ("OR" andExpr)*
   */
  private parseOrExpr(): SearchNode | null {
    const children: SearchNode[] = [];

    const first = this.parseAndExpr();
    if (first) {
      children.push(first);
    }

    while (this.peek().type === "OR") {
      this.advance(); // consume OR
      const next = this.parseAndExpr();
      if (next) {
        children.push(next);
      }
    }

    if (children.length === 0) {
      return null;
    }
    if (children.length === 1) {
      return children[0];
    }
    return { type: "or", children } as OrNode;
  }

  /**
   * Parse AND expression (implicit): term+
   */
  private parseAndExpr(): SearchNode | null {
    const children: SearchNode[] = [];

    while (true) {
      const token = this.peek();
      // Stop at OR (only if we already have children), RPAREN, or EOF
      // If OR is the first token in this context, treat it as plain text
      if (token.type === "OR" && children.length > 0) {
        break;
      }
      if (token.type === "OR" && children.length === 0) {
        // Treat standalone OR as plain text
        this.advance();
        const operator: TextOperator = { type: "text", value: "OR" };
        children.push({ type: "term", operator, negated: false } as TermNode);
        continue;
      }
      if (token.type === "RPAREN" || token.type === "EOF") {
        break;
      }

      const term = this.parseTerm();
      if (term) {
        children.push(term);
      }
    }

    if (children.length === 0) {
      return null;
    }
    if (children.length === 1) {
      return children[0];
    }
    return { type: "and", children } as AndNode;
  }

  /**
   * Parse a single term: "-"? (group | operator | quotedString | word)
   */
  private parseTerm(): SearchNode | null {
    let negated = false;

    // Check for negation
    if (this.peek().type === "NEGATION") {
      this.advance();
      negated = true;
    }

    const token = this.peek();

    // Group: "(" orExpr ")"
    if (token.type === "LPAREN") {
      this.advance(); // consume "("
      const inner = this.parseOrExpr();
      if (this.peek().type === "RPAREN") {
        this.advance(); // consume ")"
      }
      // If negated, apply De Morgan's law: -(a OR b) = (-a AND -b)
      if (inner && negated) {
        return this.negateNode(inner);
      }
      return inner;
    }

    // Operator
    if (token.type === "OPERATOR") {
      this.advance();
      const operator = this.parseOperator(
        token.operatorName!,
        token.operatorValue!,
        token.value,
      );
      return { type: "term", operator, negated } as TermNode;
    }

    // Quoted string
    if (token.type === "QUOTED") {
      this.advance();
      const operator: TextOperator = { type: "text", value: token.value };
      return { type: "term", operator, negated } as TermNode;
    }

    // Word
    if (token.type === "WORD") {
      this.advance();
      const operator: TextOperator = { type: "text", value: token.value };
      return { type: "term", operator, negated } as TermNode;
    }

    return null;
  }

  /**
   * Parse an operator token into the appropriate Operator type.
   */
  private parseOperator(
    name: string,
    value: string,
    originalText: string,
  ): Operator {
    switch (name) {
      case "has": {
        if (value === "media" || value === "poll") {
          return { type: "has", value } as HasOperator;
        }
        // Invalid value - treat as plain text
        return { type: "text", value: originalText } as TextOperator;
      }

      case "is": {
        if (value === "reply" || value === "sensitive") {
          return { type: "is", value } as IsOperator;
        }
        // Invalid value - treat as plain text
        return { type: "text", value: originalText } as TextOperator;
      }

      case "language": {
        // Normalize to lowercase
        return {
          type: "language",
          value: value.toLowerCase(),
        } as LanguageOperator;
      }

      case "from": {
        // Strip leading @ if present
        const normalizedValue = value.startsWith("@")
          ? value.substring(1)
          : value;
        return { type: "from", value: normalizedValue } as FromOperator;
      }

      case "mentions": {
        // Strip leading @ if present
        const normalizedValue = value.startsWith("@")
          ? value.substring(1)
          : value;
        return { type: "mentions", value: normalizedValue } as MentionsOperator;
      }

      case "before": {
        if (this.isValidDate(value)) {
          return { type: "before", value } as BeforeOperator;
        }
        // Invalid date - treat as plain text
        return { type: "text", value: originalText } as TextOperator;
      }

      case "after": {
        if (this.isValidDate(value)) {
          return { type: "after", value } as AfterOperator;
        }
        // Invalid date - treat as plain text
        return { type: "text", value: originalText } as TextOperator;
      }

      default:
        // Unknown operator - treat as plain text
        return { type: "text", value: originalText } as TextOperator;
    }
  }

  /**
   * Validate date format YYYY-MM-DD.
   */
  private isValidDate(value: string): boolean {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(value)) {
      return false;
    }

    const [year, month, day] = value.split("-").map(Number);

    // Basic validation
    if (month < 1 || month > 12) {
      return false;
    }
    if (day < 1 || day > 31) {
      return false;
    }

    // More precise validation using Date
    const date = new Date(year, month - 1, day);
    return (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    );
  }

  /**
   * Apply negation to a node (De Morgan's law).
   * -(a OR b) becomes (-a AND -b)
   * -(a AND b) becomes (-a OR -b)
   */
  private negateNode(node: SearchNode): SearchNode {
    switch (node.type) {
      case "term":
        return { ...node, negated: !node.negated };

      case "or":
        // -(a OR b) = -a AND -b
        return {
          type: "and",
          children: node.children.map((child) => this.negateNode(child)),
        };

      case "and":
        // -(a AND b) = -a OR -b
        return {
          type: "or",
          children: node.children.map((child) => this.negateNode(child)),
        };
    }
  }

  /**
   * Simplify the AST by removing unnecessary nesting.
   */
  private simplify(node: SearchNode): SearchNode {
    if (node.type === "term") {
      return node;
    }

    // Recursively simplify children
    const simplifiedChildren = node.children
      .map((child) => this.simplify(child))
      .filter((child) => child !== null);

    // Flatten nested same-type nodes
    const flattenedChildren: SearchNode[] = [];
    for (const child of simplifiedChildren) {
      if (child.type === node.type) {
        // Same type - flatten
        flattenedChildren.push(...(child as AndNode | OrNode).children);
      } else {
        flattenedChildren.push(child);
      }
    }

    if (flattenedChildren.length === 0) {
      // This shouldn't happen in practice, but handle it
      return null as unknown as SearchNode;
    }
    if (flattenedChildren.length === 1) {
      return flattenedChildren[0];
    }

    return { type: node.type, children: flattenedChildren } as AndNode | OrNode;
  }
}

/**
 * Parse a search query string into an AST.
 *
 * @param query The search query string to parse.
 * @returns The parsed AST, or null if the query is empty.
 *
 * @example
 * ```typescript
 * // Simple text search
 * parseSearchQuery("hello world")
 * // => { type: "and", children: [{ type: "term", operator: { type: "text", value: "hello" }, ... }, ...] }
 *
 * // With operators
 * parseSearchQuery("from:alice has:media")
 * // => { type: "and", children: [{ type: "term", operator: { type: "from", value: "alice" }, ... }, ...] }
 *
 * // With OR
 * parseSearchQuery("cat OR dog")
 * // => { type: "or", children: [...] }
 *
 * // With parentheses
 * parseSearchQuery("(cat OR dog) has:media")
 * // => { type: "and", children: [{ type: "or", ... }, { type: "term", operator: { type: "has", value: "media" }, ... }] }
 * ```
 */
export function parseSearchQuery(query: string): SearchNode | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const tokens = tokenize(trimmed);
  const parser = new Parser(tokens);
  return parser.parse();
}
