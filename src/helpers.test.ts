import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  base64Url,
  randomBytes,
  requestBody,
  URL_SAFE_REGEXP,
} from "./helpers";

describe("Helpers", () => {
  describe("requestBody", () => {
    const schema = z.object({
      client_id: z.string(),
      client_secret: z.string(),
      grant_type: z.string().optional(),
    });

    it("parses application/json content type", async () => {
      expect.assertions(1);

      const app = new Hono();
      app.post("/test", async (c) => {
        const result = await requestBody(c.req, schema);
        return c.json(result);
      });

      const response = await app.request("/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "test-id",
          client_secret: "test-secret",
        }),
      });

      const result = await response.json();
      expect(result).toEqual({
        success: true,
        data: { client_id: "test-id", client_secret: "test-secret" },
      });
    });

    it("parses application/x-www-form-urlencoded content type", async () => {
      expect.assertions(1);

      const app = new Hono();
      app.post("/test", async (c) => {
        const result = await requestBody(c.req, schema);
        return c.json(result);
      });

      const body = new URLSearchParams();
      body.set("client_id", "test-id");
      body.set("client_secret", "test-secret");

      const response = await app.request("/test", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      const result = await response.json();
      expect(result).toEqual({
        success: true,
        data: { client_id: "test-id", client_secret: "test-secret" },
      });
    });

    it("parses form data without Content-Type header", async () => {
      expect.assertions(1);

      const app = new Hono();
      app.post("/test", async (c) => {
        const result = await requestBody(c.req, schema);
        return c.json(result);
      });

      // Create a request without Content-Type header
      // (simulating clients like Lobsters' Sponge)
      const body =
        "client_id=test-id&client_secret=test-secret&grant_type=authorization_code";
      const request = new Request("http://localhost/test", {
        method: "POST",
        body,
      });
      // Remove the default Content-Type that might be set
      request.headers.delete("Content-Type");

      const response = await app.fetch(request);
      const result = await response.json();

      expect(result).toEqual({
        success: true,
        data: {
          client_id: "test-id",
          client_secret: "test-secret",
          grant_type: "authorization_code",
        },
      });
    });

    it("parses form data with text/plain Content-Type", async () => {
      expect.assertions(1);

      const app = new Hono();
      app.post("/test", async (c) => {
        const result = await requestBody(c.req, schema);
        return c.json(result);
      });

      const body = "client_id=test-id&client_secret=test-secret";
      const response = await app.request("/test", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      });

      const result = await response.json();
      expect(result).toEqual({
        success: true,
        data: { client_id: "test-id", client_secret: "test-secret" },
      });
    });

    it("parses form data with text/plain;charset=UTF-8 Content-Type", async () => {
      expect.assertions(1);

      const app = new Hono();
      app.post("/test", async (c) => {
        const result = await requestBody(c.req, schema);
        return c.json(result);
      });

      const body = "client_id=test-id&client_secret=test-secret";
      const response = await app.request("/test", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body,
      });

      const result = await response.json();
      expect(result).toEqual({
        success: true,
        data: { client_id: "test-id", client_secret: "test-secret" },
      });
    });

    it("handles URL-encoded special characters correctly", async () => {
      expect.assertions(1);

      const app = new Hono();
      app.post("/test", async (c) => {
        const result = await requestBody(c.req, schema);
        return c.json(result);
      });

      // Test with URL-encoded values
      const body = "client_id=test%2Bid&client_secret=secret%26value";
      const response = await app.request("/test", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      });

      const result = await response.json();
      expect(result).toEqual({
        success: true,
        data: { client_id: "test+id", client_secret: "secret&value" },
      });
    });

    it("returns validation error for invalid data", async () => {
      expect.assertions(2);

      const app = new Hono();
      app.post("/test", async (c) => {
        const result = await requestBody(c.req, schema);
        return c.json(result);
      });

      const body = "invalid_field=value";
      const response = await app.request("/test", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      });

      const result = await response.json();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("handles empty body gracefully", async () => {
      expect.assertions(2);

      const app = new Hono();
      app.post("/test", async (c) => {
        const result = await requestBody(c.req, schema);
        return c.json(result);
      });

      const response = await app.request("/test", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "",
      });

      const result = await response.json();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

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
