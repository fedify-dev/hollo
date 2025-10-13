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
          code: z.ZodIssueCode.invalid_value,
          values: scopeEnum.enumValues,
          received: scope,
        });
        return z.NEVER;
      }
      scopes.push(scope as Scope);
    }
    return scopes;
  });
