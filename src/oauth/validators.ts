import { z } from "zod";

import { type Scope, scopeEnum } from "../schema";

export const scopesSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const scopes: Scope[] = [];
    for (const scope of v.split(/\s+/g)) {
      if (!scopeEnum.enumValues.includes(scope as Scope)) {
        ctx.addIssue({
          code: "invalid_value",
          values: scopeEnum.enumValues,
          received: scope,
        });
        return z.NEVER;
      }
      scopes.push(scope as Scope);
    }
    // RFC 6749 treats `scope` as a set, so repeating a scope means nothing.
    // Deduplicating keeps a request like `scope=read read read ...` from
    // storing an arbitrarily long array in `access_tokens.scopes`, which the
    // admin dashboard would then have to read back and render.
    return [...new Set(scopes)];
  });
