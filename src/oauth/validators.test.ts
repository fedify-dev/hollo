import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { scopesSchema } from "./validators";

describe("OAuth / Validators", () => {
  it("can parse a single scope", { plan: 4 }, async (t: TestContext) => {
    const result = await scopesSchema.safeParseAsync("read");

    t.assert.equal(result.success, true);
    t.assert.equal(result.error, null);
    t.assert.ok(Array.isArray(result.data));
    t.assert.deepStrictEqual(result.data, ["read"]);
  });

  it("can parse multiple scopes", { plan: 4 }, async (t: TestContext) => {
    const result = await scopesSchema.safeParseAsync("read write");

    t.assert.equal(result.success, true);
    t.assert.equal(result.error, null);
    t.assert.ok(Array.isArray(result.data));
    t.assert.deepStrictEqual(result.data, ["read", "write"]);
  });

  it(
    "returns an error if the scope is invalid",
    { plan: 4 },
    async (t: TestContext) => {
      const result = await scopesSchema.safeParseAsync("invalid");

      t.assert.equal(result.success, false);
      t.assert.notEqual(result.error, null);
      t.assert.equal(result.error?.errors[0].code, "invalid_enum_value");
      t.assert.ok(!Array.isArray(result.data));
    },
  );

  it(
    "returns an error if one of the scopes is invalid",
    { plan: 4 },
    async (t: TestContext) => {
      const result = await scopesSchema.safeParseAsync("read invalid write");

      t.assert.equal(result.success, false);
      t.assert.notEqual(result.error, null);
      t.assert.equal(result.error?.errors[0].code, "invalid_enum_value");
      t.assert.ok(!Array.isArray(result.data));
    },
  );
});
