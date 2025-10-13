import { describe, expect, it } from "vitest";

import { scopesSchema } from "./validators";

describe("OAuth / Validators", () => {
  it("can parse a single scope", async () => {
    expect.assertions(4);

    const result = await scopesSchema.safeParseAsync("read");

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.data)).toBeTruthy();
    expect(result.data).toEqual(["read"]);
  });

  it("can parse multiple scopes", async () => {
    expect.assertions(4);

    const result = await scopesSchema.safeParseAsync("read write");

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.data)).toBeTruthy();
    expect(result.data).toEqual(["read", "write"]);
  });

  it("returns an error if the scope is invalid", async () => {
    expect.assertions(4);

    const result = await scopesSchema.safeParseAsync("invalid");

    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error?.issues[0].code).toBe("invalid_value");
    expect(Array.isArray(result.data)).toBeFalsy();
  });

  it("returns an error if one of the scopes is invalid", async () => {
    expect.assertions(4);

    const result = await scopesSchema.safeParseAsync("read invalid write");

    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error?.issues[0].code).toBe("invalid_value");
    expect(Array.isArray(result.data)).toBeFalsy();
  });
});
