import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import type { Server } from "srvx";
import { FastResponse } from "srvx/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHttpServer, enableFastResponse } from "./http-server";

const nativeRequest = globalThis.Request;
const nativeResponse = globalThis.Response;
let server: Server;

beforeAll(async () => {
  enableFastResponse();
  const app = new Hono();
  app.use("/status/*", compress());
  app.use("/status/*", cors());
  for (const code of [201, 401, 403, 404] as const) {
    app.get(`/status/${code}`, (c) => c.json({ code }, code));
  }
  app.get("/json", (c) => c.json({ message: "안녕하세요" }));
  app.get("/cookies", (c) => {
    c.header("Set-Cookie", "a=1", { append: true });
    c.header("Set-Cookie", "b=2", { append: true });
    return c.text("cookies");
  });
  app.get("/redirect", (c) => c.redirect("/json", 302));
  app.get("/native", () => new nativeResponse("native"));
  app.get(
    "/stream",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("second"));
              controller.close();
            }, 25);
          },
        }),
      ),
  );
  app.get("/headers", async (c) => {
    c.res = c.text("body");
    c.header("Cache-Control", "private, no-store");
    return c.res;
  });
  server = createHttpServer(app.fetch.bind(app), {
    port: 0,
    hostname: "127.0.0.1",
    behindProxy: false,
  });
  await server.ready();
});

afterAll(async () => {
  await server?.close(true);
  globalThis.Response = nativeResponse;
});

describe("FastResponse", () => {
  it.each([201, 401, 403, 404])(
    "preserves status %i through API middleware",
    async (code) => {
      const response = await fetch(new URL(`/status/${code}`, server.url));
      expect(response.status).toBe(code);
      expect(await response.json()).toEqual({ code });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    },
  );

  it("preserves response-valued initializers when materializing the body", async () => {
    const original = new nativeResponse("denied", {
      status: 401,
      statusText: "Denied",
    });
    const copy = new Response(original.body, original);
    copy.headers.set("X-Test", "yes");
    expect(await copy.text()).toBe("denied");
    expect(copy.status).toBe(401);
    expect(copy.statusText).toBe("Denied");
    expect(copy.headers.get("X-Test")).toBe("yes");
  });

  it("replaces only Response and preserves native response interoperability", async () => {
    expect(Object.getPrototypeOf(globalThis.Response)).toBe(FastResponse);
    expect(globalThis.Request).toBe(nativeRequest);
    expect(Response.error().type).toBe("error");
    expect(
      Response.redirect("https://example.com/").headers.get("Location"),
    ).toBe("https://example.com/");
    const response = new Response("hello");
    expect(response).toBeInstanceOf(nativeResponse);
    expect(await response.clone().text()).toBe("hello");
    expect(await response.text()).toBe("hello");
    expect(await (await fetch(new URL("/native", server.url))).text()).toBe(
      "native",
    );
  });

  it("sends Hono JSON with the UTF-8 byte length and supports HEAD", async () => {
    const response = await fetch(new URL("/json", server.url));
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ message: "안녕하세요" });
    expect(response.headers.get("Content-Length")).toBe(
      String(Buffer.byteLength(body)),
    );
    const head = await fetch(new URL("/json", server.url), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("keeps multiple cookies and redirects", async () => {
    const cookies = await fetch(new URL("/cookies", server.url));
    expect(cookies.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    const redirect = await fetch(new URL("/redirect", server.url), {
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("Location")).toBe("/json");
  });

  it("streams responses and preserves Hono header changes", async () => {
    const response = await fetch(new URL("/stream", server.url));
    expect(await response.text()).toBe("firstsecond");
    const headers = await fetch(new URL("/headers", server.url));
    expect(headers.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await headers.text()).toBe("body");
  });
});
