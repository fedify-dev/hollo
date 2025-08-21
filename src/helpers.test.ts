import { describe, expect, it } from "vitest";
import { base64Url, randomBytes, URL_SAFE_REGEXP } from "./helpers";

describe("Helpers", () => {
  describe("base64Url", () => {
    it("returns a URL safe string", () => {
      expect.assertions(2);

      const encoder = new TextEncoder();
      const value = encoder.encode("test").buffer as ArrayBuffer;
      const result = base64Url(value);

      expect(result).to.match(URL_SAFE_REGEXP);
      expect(result).toBe("dGVzdA");
    });
  });
  describe("randomBytes", () => {
    it("returns a URL safe string", () => {
      expect.assertions(1);

      expect(randomBytes(32)).to.match(URL_SAFE_REGEXP);
    });
  });
});
