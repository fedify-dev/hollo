import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "./parser";

describe("parseSearchQuery", () => {
  describe("plain text search", () => {
    it("parses a single word", () => {
      expect.assertions(1);
      const result = parseSearchQuery("hello");
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: "hello" },
        negated: false,
      });
    });

    it("parses quoted string with spaces", () => {
      expect.assertions(1);
      const result = parseSearchQuery('"hello world"');
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: "hello world" },
        negated: false,
      });
    });

    it("parses quoted string with escaped quotes", () => {
      expect.assertions(1);
      const result = parseSearchQuery('"hello \\"world\\""');
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: 'hello "world"' },
        negated: false,
      });
    });

    it("parses single-quoted string", () => {
      expect.assertions(1);
      const result = parseSearchQuery("'hello world'");
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: "hello world" },
        negated: false,
      });
    });
  });

  describe("has: operator", () => {
    it("parses has:media", () => {
      expect.assertions(1);
      const result = parseSearchQuery("has:media");
      expect(result).toEqual({
        type: "term",
        operator: { type: "has", value: "media" },
        negated: false,
      });
    });

    it("parses has:poll", () => {
      expect.assertions(1);
      const result = parseSearchQuery("has:poll");
      expect(result).toEqual({
        type: "term",
        operator: { type: "has", value: "poll" },
        negated: false,
      });
    });

    it("treats invalid has: value as plain text", () => {
      expect.assertions(1);
      const result = parseSearchQuery("has:invalid");
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: "has:invalid" },
        negated: false,
      });
    });
  });

  describe("is: operator", () => {
    it("parses is:reply", () => {
      expect.assertions(1);
      const result = parseSearchQuery("is:reply");
      expect(result).toEqual({
        type: "term",
        operator: { type: "is", value: "reply" },
        negated: false,
      });
    });

    it("parses is:sensitive", () => {
      expect.assertions(1);
      const result = parseSearchQuery("is:sensitive");
      expect(result).toEqual({
        type: "term",
        operator: { type: "is", value: "sensitive" },
        negated: false,
      });
    });

    it("treats invalid is: value as plain text", () => {
      expect.assertions(1);
      const result = parseSearchQuery("is:invalid");
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: "is:invalid" },
        negated: false,
      });
    });
  });

  describe("language: operator", () => {
    it("parses language:en", () => {
      expect.assertions(1);
      const result = parseSearchQuery("language:en");
      expect(result).toEqual({
        type: "term",
        operator: { type: "language", value: "en" },
        negated: false,
      });
    });

    it("parses language:ko", () => {
      expect.assertions(1);
      const result = parseSearchQuery("language:ko");
      expect(result).toEqual({
        type: "term",
        operator: { type: "language", value: "ko" },
        negated: false,
      });
    });

    it("parses language codes case-insensitively", () => {
      expect.assertions(1);
      const result = parseSearchQuery("language:EN");
      expect(result).toEqual({
        type: "term",
        operator: { type: "language", value: "en" },
        negated: false,
      });
    });
  });

  describe("from: operator", () => {
    it("parses from:username", () => {
      expect.assertions(1);
      const result = parseSearchQuery("from:alice");
      expect(result).toEqual({
        type: "term",
        operator: { type: "from", value: "alice" },
        negated: false,
      });
    });

    it("parses from:@username (strips leading @)", () => {
      expect.assertions(1);
      const result = parseSearchQuery("from:@alice");
      expect(result).toEqual({
        type: "term",
        operator: { type: "from", value: "alice" },
        negated: false,
      });
    });

    it("parses from:username@domain", () => {
      expect.assertions(1);
      const result = parseSearchQuery("from:alice@example.com");
      expect(result).toEqual({
        type: "term",
        operator: { type: "from", value: "alice@example.com" },
        negated: false,
      });
    });

    it("parses from:@username@domain (strips leading @)", () => {
      expect.assertions(1);
      const result = parseSearchQuery("from:@alice@example.com");
      expect(result).toEqual({
        type: "term",
        operator: { type: "from", value: "alice@example.com" },
        negated: false,
      });
    });
  });

  describe("mentions: operator", () => {
    it("parses mentions:username", () => {
      expect.assertions(1);
      const result = parseSearchQuery("mentions:bob");
      expect(result).toEqual({
        type: "term",
        operator: { type: "mentions", value: "bob" },
        negated: false,
      });
    });

    it("parses mentions:@username (strips leading @)", () => {
      expect.assertions(1);
      const result = parseSearchQuery("mentions:@bob");
      expect(result).toEqual({
        type: "term",
        operator: { type: "mentions", value: "bob" },
        negated: false,
      });
    });

    it("parses mentions:username@domain", () => {
      expect.assertions(1);
      const result = parseSearchQuery("mentions:bob@example.com");
      expect(result).toEqual({
        type: "term",
        operator: { type: "mentions", value: "bob@example.com" },
        negated: false,
      });
    });
  });

  describe("date operators", () => {
    it("parses before:YYYY-MM-DD", () => {
      expect.assertions(1);
      const result = parseSearchQuery("before:2024-01-15");
      expect(result).toEqual({
        type: "term",
        operator: { type: "before", value: "2024-01-15" },
        negated: false,
      });
    });

    it("parses after:YYYY-MM-DD", () => {
      expect.assertions(1);
      const result = parseSearchQuery("after:2024-01-15");
      expect(result).toEqual({
        type: "term",
        operator: { type: "after", value: "2024-01-15" },
        negated: false,
      });
    });

    it("treats invalid date format as plain text", () => {
      expect.assertions(1);
      const result = parseSearchQuery("before:invalid");
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: "before:invalid" },
        negated: false,
      });
    });

    it("treats invalid date (month 13) as plain text", () => {
      expect.assertions(1);
      const result = parseSearchQuery("before:2024-13-01");
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: "before:2024-13-01" },
        negated: false,
      });
    });
  });

  describe("negation", () => {
    it("parses -has:media", () => {
      expect.assertions(1);
      const result = parseSearchQuery("-has:media");
      expect(result).toEqual({
        type: "term",
        operator: { type: "has", value: "media" },
        negated: true,
      });
    });

    it("parses -is:reply", () => {
      expect.assertions(1);
      const result = parseSearchQuery("-is:reply");
      expect(result).toEqual({
        type: "term",
        operator: { type: "is", value: "reply" },
        negated: true,
      });
    });

    it("parses -from:alice", () => {
      expect.assertions(1);
      const result = parseSearchQuery("-from:alice");
      expect(result).toEqual({
        type: "term",
        operator: { type: "from", value: "alice" },
        negated: true,
      });
    });

    it("parses negated plain text", () => {
      expect.assertions(1);
      const result = parseSearchQuery("-spam");
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: "spam" },
        negated: true,
      });
    });

    it('parses negated quoted string with -"..."', () => {
      expect.assertions(1);
      const result = parseSearchQuery('-"hello world"');
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: "hello world" },
        negated: true,
      });
    });
  });

  describe("OR operator", () => {
    it("parses a OR b", () => {
      expect.assertions(1);
      const result = parseSearchQuery("a OR b");
      expect(result).toEqual({
        type: "or",
        children: [
          {
            type: "term",
            operator: { type: "text", value: "a" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "text", value: "b" },
            negated: false,
          },
        ],
      });
    });

    it("parses multiple OR: a OR b OR c", () => {
      expect.assertions(1);
      const result = parseSearchQuery("a OR b OR c");
      expect(result).toEqual({
        type: "or",
        children: [
          {
            type: "term",
            operator: { type: "text", value: "a" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "text", value: "b" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "text", value: "c" },
            negated: false,
          },
        ],
      });
    });

    it("parses OR with operators: has:media OR has:poll", () => {
      expect.assertions(1);
      const result = parseSearchQuery("has:media OR has:poll");
      expect(result).toEqual({
        type: "or",
        children: [
          {
            type: "term",
            operator: { type: "has", value: "media" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "has", value: "poll" },
            negated: false,
          },
        ],
      });
    });

    it("treats lowercase 'or' as plain text", () => {
      expect.assertions(1);
      const result = parseSearchQuery("a or b");
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "term",
            operator: { type: "text", value: "a" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "text", value: "or" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "text", value: "b" },
            negated: false,
          },
        ],
      });
    });
  });

  describe("implicit AND", () => {
    it("parses multiple terms as AND", () => {
      expect.assertions(1);
      const result = parseSearchQuery("hello world");
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "term",
            operator: { type: "text", value: "hello" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "text", value: "world" },
            negated: false,
          },
        ],
      });
    });

    it("parses operators with text as AND", () => {
      expect.assertions(1);
      const result = parseSearchQuery("from:alice hello");
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "term",
            operator: { type: "from", value: "alice" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "text", value: "hello" },
            negated: false,
          },
        ],
      });
    });

    it("parses complex AND: from:alice has:media -is:sensitive", () => {
      expect.assertions(1);
      const result = parseSearchQuery("from:alice has:media -is:sensitive");
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "term",
            operator: { type: "from", value: "alice" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "has", value: "media" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "is", value: "sensitive" },
            negated: true,
          },
        ],
      });
    });
  });

  describe("precedence: AND binds tighter than OR", () => {
    it("parses 'a b OR c' as '(a AND b) OR c'", () => {
      expect.assertions(1);
      const result = parseSearchQuery("a b OR c");
      expect(result).toEqual({
        type: "or",
        children: [
          {
            type: "and",
            children: [
              {
                type: "term",
                operator: { type: "text", value: "a" },
                negated: false,
              },
              {
                type: "term",
                operator: { type: "text", value: "b" },
                negated: false,
              },
            ],
          },
          {
            type: "term",
            operator: { type: "text", value: "c" },
            negated: false,
          },
        ],
      });
    });

    it("parses 'a OR b c' as 'a OR (b AND c)'", () => {
      expect.assertions(1);
      const result = parseSearchQuery("a OR b c");
      expect(result).toEqual({
        type: "or",
        children: [
          {
            type: "term",
            operator: { type: "text", value: "a" },
            negated: false,
          },
          {
            type: "and",
            children: [
              {
                type: "term",
                operator: { type: "text", value: "b" },
                negated: false,
              },
              {
                type: "term",
                operator: { type: "text", value: "c" },
                negated: false,
              },
            ],
          },
        ],
      });
    });
  });

  describe("parentheses", () => {
    it("parses (a OR b)", () => {
      expect.assertions(1);
      const result = parseSearchQuery("(a OR b)");
      expect(result).toEqual({
        type: "or",
        children: [
          {
            type: "term",
            operator: { type: "text", value: "a" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "text", value: "b" },
            negated: false,
          },
        ],
      });
    });

    it("parses (a OR b) c as AND", () => {
      expect.assertions(1);
      const result = parseSearchQuery("(a OR b) c");
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "or",
            children: [
              {
                type: "term",
                operator: { type: "text", value: "a" },
                negated: false,
              },
              {
                type: "term",
                operator: { type: "text", value: "b" },
                negated: false,
              },
            ],
          },
          {
            type: "term",
            operator: { type: "text", value: "c" },
            negated: false,
          },
        ],
      });
    });

    it("parses a (b OR c)", () => {
      expect.assertions(1);
      const result = parseSearchQuery("a (b OR c)");
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "term",
            operator: { type: "text", value: "a" },
            negated: false,
          },
          {
            type: "or",
            children: [
              {
                type: "term",
                operator: { type: "text", value: "b" },
                negated: false,
              },
              {
                type: "term",
                operator: { type: "text", value: "c" },
                negated: false,
              },
            ],
          },
        ],
      });
    });

    it("parses nested parentheses: ((a OR b) c) OR d", () => {
      expect.assertions(1);
      const result = parseSearchQuery("((a OR b) c) OR d");
      expect(result).toEqual({
        type: "or",
        children: [
          {
            type: "and",
            children: [
              {
                type: "or",
                children: [
                  {
                    type: "term",
                    operator: { type: "text", value: "a" },
                    negated: false,
                  },
                  {
                    type: "term",
                    operator: { type: "text", value: "b" },
                    negated: false,
                  },
                ],
              },
              {
                type: "term",
                operator: { type: "text", value: "c" },
                negated: false,
              },
            ],
          },
          {
            type: "term",
            operator: { type: "text", value: "d" },
            negated: false,
          },
        ],
      });
    });

    it("parses negated parentheses: -(a OR b)", () => {
      expect.assertions(1);
      const result = parseSearchQuery("-(a OR b)");
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "term",
            operator: { type: "text", value: "a" },
            negated: true,
          },
          {
            type: "term",
            operator: { type: "text", value: "b" },
            negated: true,
          },
        ],
      });
    });

    it("parses complex: (from:alice OR from:bob) has:poll", () => {
      expect.assertions(1);
      const result = parseSearchQuery("(from:alice OR from:bob) has:poll");
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "or",
            children: [
              {
                type: "term",
                operator: { type: "from", value: "alice" },
                negated: false,
              },
              {
                type: "term",
                operator: { type: "from", value: "bob" },
                negated: false,
              },
            ],
          },
          {
            type: "term",
            operator: { type: "has", value: "poll" },
            negated: false,
          },
        ],
      });
    });
  });

  describe("edge cases", () => {
    it("returns null for empty query", () => {
      expect.assertions(1);
      const result = parseSearchQuery("");
      expect(result).toBeNull();
    });

    it("returns null for whitespace-only query", () => {
      expect.assertions(1);
      const result = parseSearchQuery("   ");
      expect(result).toBeNull();
    });

    it("handles extra whitespace between terms", () => {
      expect.assertions(1);
      const result = parseSearchQuery("hello    world");
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "term",
            operator: { type: "text", value: "hello" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "text", value: "world" },
            negated: false,
          },
        ],
      });
    });

    it("handles leading and trailing whitespace", () => {
      expect.assertions(1);
      const result = parseSearchQuery("  hello world  ");
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "term",
            operator: { type: "text", value: "hello" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "text", value: "world" },
            negated: false,
          },
        ],
      });
    });

    it("treats unclosed quote as text including the quote", () => {
      expect.assertions(1);
      const result = parseSearchQuery('"unclosed');
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: '"unclosed' },
        negated: false,
      });
    });

    it("treats unclosed parenthesis gracefully", () => {
      expect.assertions(1);
      const result = parseSearchQuery("(a b");
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "term",
            operator: { type: "text", value: "a" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "text", value: "b" },
            negated: false,
          },
        ],
      });
    });

    it("treats standalone OR as text", () => {
      expect.assertions(1);
      const result = parseSearchQuery("OR");
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: "OR" },
        negated: false,
      });
    });

    it("handles empty parentheses by ignoring them", () => {
      expect.assertions(1);
      const result = parseSearchQuery("() hello");
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: "hello" },
        negated: false,
      });
    });

    it("handles multiple empty parentheses", () => {
      expect.assertions(1);
      const result = parseSearchQuery("() () ()");
      expect(result).toBeNull();
    });

    it("simplifies single-child AND/OR nodes", () => {
      expect.assertions(1);
      const result = parseSearchQuery("(hello)");
      expect(result).toEqual({
        type: "term",
        operator: { type: "text", value: "hello" },
        negated: false,
      });
    });
  });

  describe("real-world examples", () => {
    it("parses 'from:alice has:media -is:sensitive language:en'", () => {
      expect.assertions(1);
      const result = parseSearchQuery(
        "from:alice has:media -is:sensitive language:en",
      );
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "term",
            operator: { type: "from", value: "alice" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "has", value: "media" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "is", value: "sensitive" },
            negated: true,
          },
          {
            type: "term",
            operator: { type: "language", value: "en" },
            negated: false,
          },
        ],
      });
    });

    it("parses '(has:media OR has:poll) after:2024-01-01 before:2024-12-31'", () => {
      expect.assertions(1);
      const result = parseSearchQuery(
        "(has:media OR has:poll) after:2024-01-01 before:2024-12-31",
      );
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "or",
            children: [
              {
                type: "term",
                operator: { type: "has", value: "media" },
                negated: false,
              },
              {
                type: "term",
                operator: { type: "has", value: "poll" },
                negated: false,
              },
            ],
          },
          {
            type: "term",
            operator: { type: "after", value: "2024-01-01" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "before", value: "2024-12-31" },
            negated: false,
          },
        ],
      });
    });

    it("parses 'hello world from:alice OR from:bob'", () => {
      expect.assertions(1);
      const result = parseSearchQuery("hello world from:alice OR from:bob");
      // This should be: (hello AND world AND from:alice) OR from:bob
      expect(result).toEqual({
        type: "or",
        children: [
          {
            type: "and",
            children: [
              {
                type: "term",
                operator: { type: "text", value: "hello" },
                negated: false,
              },
              {
                type: "term",
                operator: { type: "text", value: "world" },
                negated: false,
              },
              {
                type: "term",
                operator: { type: "from", value: "alice" },
                negated: false,
              },
            ],
          },
          {
            type: "term",
            operator: { type: "from", value: "bob" },
            negated: false,
          },
        ],
      });
    });

    it("parses '\"exact phrase\" from:alice'", () => {
      expect.assertions(1);
      const result = parseSearchQuery('"exact phrase" from:alice');
      expect(result).toEqual({
        type: "and",
        children: [
          {
            type: "term",
            operator: { type: "text", value: "exact phrase" },
            negated: false,
          },
          {
            type: "term",
            operator: { type: "from", value: "alice" },
            negated: false,
          },
        ],
      });
    });
  });
});
