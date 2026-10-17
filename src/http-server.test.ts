import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Agent } from "node:http";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import {
  generateCryptoKeyPair,
  signRequest,
  verifyRequest,
} from "@fedify/fedify/sig";
import { CryptographicKey } from "@fedify/vocab";
import { Hono } from "hono";
import type { Server } from "srvx";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpServer } from "./http-server";
import { serveStatic } from "./serve-static";

const servers: Server[] = [];

async function start(
  handler: (request: Request) => Response | Promise<Response>,
  behindProxy = false,
  hostname: string | null = "127.0.0.1",
) {
  const server = createHttpServer(handler, {
    port: 0,
    hostname: hostname ?? undefined,
    behindProxy,
  });
  servers.push(server);
  await server.ready();
  return server;
}

function send(
  server: Server,
  {
    method = "GET",
    headers = {},
    body,
    path = "/",
  }: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    path?: string;
  } = {},
): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      server.url!,
      { method, path, headers, agent: false },
      (response) => {
        text(response).then(
          (body) =>
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              body,
            }),
          reject,
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(true)));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("HTTP server proxy boundary", () => {
  it("ignores forwarded origins unless BEHIND_PROXY is enabled", async () => {
    const server = await start((request) =>
      Response.json({
        url: request.url,
        host: request.headers.get("Host"),
        forwarded: request.headers.get("X-Forwarded-Host"),
      }),
    );
    const response = await send(server, {
      headers: {
        Host: "internal.example:3000",
        "X-Forwarded-Host": "public.example",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(JSON.parse(response.body)).toEqual({
      url: "http://internal.example:3000/",
      host: "internal.example:3000",
      forwarded: "public.example",
    });
  });

  it.each([
    ["Public.Example:443", "Public.Example:443"],
    ["public.example:8443", "public.example:8443"],
    ["[2001:db8::1]:443", "[2001:db8::1]:443"],
    ["public.example, internal.example", "public.example"],
    [", public.example", "public.example"],
    [" , , public.example, ", "public.example"],
    ["public.example,", "public.example"],
    ["evil.example/path", "internal.example:3000"],
    ["user@evil.example", "internal.example:3000"],
    ["evil.example:999999", "internal.example:3000"],
    ["evil.example?x", "internal.example:3000"],
    ["evil.example#x", "internal.example:3000"],
  ])("keeps Host consistent with srvx for %s", async (forwarded, host) => {
    const server = await start(
      (request) =>
        Response.json({
          url: request.url,
          host: request.headers.get("Host"),
          proto: request.headers.get("X-Forwarded-Proto"),
          forwarded: request.headers.get("X-Forwarded-Host"),
          for: request.headers.get("X-Forwarded-For"),
        }),
      true,
    );
    // Dot segments force native URL normalization inside srvx's FastURL.
    const response = await send(server, {
      path: "/a/../inbox?x=1",
      headers: {
        Host: "internal.example:3000",
        "X-Forwarded-Host": forwarded,
        "X-Forwarded-Proto": ", https, http",
        "X-Forwarded-For": "192.0.2.1",
      },
    });
    const result = JSON.parse(response.body);
    expect(result.host).toBe(host);
    expect(new URL(result.url).href).toBe(
      new URL(`https://${host}/inbox?x=1`).href,
    );
    expect(result.proto).toBeNull();
    expect(result.forwarded).toBeNull();
    expect(result.for).toBe("192.0.2.1");
  });

  it("preserves Host when the proxy only supplies the public scheme", async () => {
    const server = await start(
      (request) =>
        Response.json({ url: request.url, host: request.headers.get("Host") }),
      true,
    );
    const response = await send(server, {
      headers: { Host: "Public.Example:443", "X-Forwarded-Proto": "https" },
    });
    expect(JSON.parse(response.body)).toEqual({
      url: "https://Public.Example:443/",
      host: "Public.Example:443",
    });
  });

  it.each(["draft-cavage-http-signatures-12", "rfc9421"] as const)(
    "verifies %s signed bodies through a trusted proxy",
    async (spec) => {
      const pair = await generateCryptoKeyPair();
      const keyId = new URL("https://remote.example/actor#key");
      const key = new CryptographicKey({
        id: keyId,
        owner: new URL("https://remote.example/actor"),
        publicKey: pair.publicKey,
      });
      const body = '{"content":"한글 🐻","type":"Create"}';
      const signed = await signRequest(
        new Request("https://public.example/inbox", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/activity+json",
            Host: "Public.Example:443",
          },
        }),
        pair.privateKey,
        keyId,
        { spec },
      );
      const server = await start(async (request) => {
        const verified = await verifyRequest(request, {
          keyCache: { get: async () => key, set: async () => {} },
          documentLoader: async () => {
            throw new Error("Signature test must not use the network");
          },
        });
        return Response.json({
          verified: verified != null,
          clone: await request.clone().text(),
          body: await request.text(),
        });
      }, true);
      const response = await send(server, {
        path: "/inbox",
        method: "POST",
        body: await signed.text(),
        headers: {
          ...Object.fromEntries(signed.headers),
          host: "internal.example:3000",
          "x-forwarded-host": "Public.Example:443",
          "x-forwarded-proto": "https",
        },
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        verified: true,
        clone: body,
        body,
      });
    },
  );
});

describe("HTTP transport", () => {
  it("passes a chunk to the application before the upload completes", async () => {
    const received = Promise.withResolvers<string>();
    const server = await start(async (request) => {
      const reader = request.body!.getReader();
      const first = await reader.read();
      received.resolve(new TextDecoder().decode(first.value));
      let rest = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += new TextDecoder().decode(value);
      }
      return new Response(rest);
    }, true);
    const request = httpRequest(server.url!, {
      method: "POST",
      headers: { "X-Forwarded-Proto": "https" },
      agent: false,
    });
    const response = new Promise<string>((resolve, reject) => {
      request.on("error", reject);
      request.on("response", (response) =>
        text(response).then(resolve, reject),
      );
    });
    try {
      request.flushHeaders();
      request.write("first");
      expect(await received.promise).toBe("first");
      request.end("last");
      expect(await response).toBe("last");
    } finally {
      request.destroy();
    }
  });

  it("parses multipart uploads through the Hono application", async () => {
    const app = new Hono();
    app.post("/", async (c) => {
      const data = await c.req.formData();
      const file = data.get("file") as File;
      return c.json({ title: data.get("title"), file: await file.text() });
    });
    const server = await start(app.fetch, true);
    const data = new FormData();
    data.set("title", "hello");
    data.set("file", new File(["한글"], "file.txt", { type: "text/plain" }));
    const response = await fetch(server.url!, {
      method: "POST",
      body: data,
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(await response.json()).toEqual({ title: "hello", file: "한글" });
  });

  it("aborts the application signal when an incomplete client disconnects", async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<boolean>();
    const server = await start(async (request) => {
      const signal = request.signal;
      signal.addEventListener("abort", () => aborted.resolve(signal.aborted));
      entered.resolve();
      await aborted.promise;
      return new Response(null, { status: 499 });
    }, true);
    const request = httpRequest(server.url!, {
      method: "POST",
      headers: { "Content-Length": "1000000", "X-Forwarded-Proto": "https" },
    });
    request.on("error", () => {});
    try {
      request.flushHeaders();
      request.write("partial");
      await entered.promise;
      request.destroy();
      expect(await aborted.promise).toBe(true);
    } finally {
      request.destroy();
    }
  });

  it("responds to an unread incomplete body without waiting for its end", async () => {
    const server = await start(
      () => new Response("rejected", { status: 403 }),
      true,
    );
    const agent = new Agent({ keepAlive: true });
    const request = httpRequest(server.url!, {
      method: "POST",
      headers: { "Content-Length": "1000000" },
      agent,
    });
    const closed = new Promise<void>((resolve) => {
      request.on("socket", (socket) => socket.once("close", resolve));
    });
    const response = new Promise<number | undefined>((resolve, reject) => {
      request.on("error", reject);
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
    });
    try {
      request.flushHeaders();
      request.write("partial");
      expect(await response).toBe(403);
      await closed;
      expect(request.socket?.destroyed).toBe(true);
    } finally {
      request.destroy();
      agent.destroy();
    }
    expect((await send(server)).status).toBe(403);
  });

  it("preserves native constructors, cookies, redirects and response streams", async () => {
    const NativeRequest = globalThis.Request;
    const NativeResponse = globalThis.Response;
    const app = new Hono();
    app.get("/cookies", (c) => {
      c.header("Set-Cookie", "a=1", { append: true });
      c.header("Set-Cookie", "b=2", { append: true });
      return c.redirect("/stream");
    });
    app.get(
      "/stream",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("한글"));
              controller.close();
            },
          }),
        ),
    );
    const server = await start(app.fetch);
    const response = await send(server, { path: "/cookies" });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/stream");
    expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect((await send(server, { path: "/stream" })).body).toBe("한글");
    expect(globalThis.Request).toBe(NativeRequest);
    expect(globalThis.Response).toBe(NativeResponse);
  });

  it("retains the existing static file helper's HEAD and range behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hollo-http-static-"));
    try {
      await writeFile(join(dir, "hello.txt"), "hello world");
      const app = new Hono();
      app.use("/*", serveStatic({ root: dir, prefix: "" }));
      const server = await start(app.fetch);
      const get = await send(server, { path: "/hello.txt" });
      expect(get.body).toBe("hello world");
      const head = await send(server, { path: "/hello.txt", method: "HEAD" });
      expect(head.body).toBe("");
      expect(head.headers["content-length"]).toBe("11");
      const range = await send(server, {
        path: "/hello.txt",
        headers: { Range: "bytes=1-3" },
      });
      expect(range.status).toBe(206);
      expect(range.body).toBe("ell");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not expose thrown errors to HTTP clients", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await start(() => {
      throw new Error("private credentials");
    });
    const response = await send(server);
    expect(response.status).toBe(500);
    expect(response.body).toBe("Internal Server Error");
  });

  it.each([undefined, "127.0.0.2"])(
    "ignores HOST=%s when BIND is unset",
    async (host) => {
      vi.stubEnv("HOST", host);
      const server = await start(() => new Response("ok"), false, null);
      const address = server.node!.server!.address();
      expect(address && typeof address !== "string" && address.address).toMatch(
        /^(::|0\.0\.0\.0)$/,
      );
    },
  );

  it("rejects readiness on a port conflict", async () => {
    const listening = await start(() => new Response("ok"));
    const server = createHttpServer(() => new Response("unreachable"), {
      hostname: "127.0.0.1",
      port: Number(new URL(listening.url!).port),
      behindProxy: false,
    });
    await expect(server.ready()).rejects.toHaveProperty("code", "EADDRINUSE");
  });

  it("waits for an active response before close completes", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = await start(async () => {
      entered.resolve();
      await release.promise;
      return new Response("finished");
    });
    const response = send(server);
    await entered.promise;
    let closed = false;
    const close = server.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    release.resolve();
    expect((await response).body).toBe("finished");
    await close;
    expect(closed).toBe(true);
  });

  it("finishes shutdown while a proxy tries to reuse a keep-alive connection", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let handled = 0;
    const server = await start(async () => {
      handled++;
      entered.resolve();
      await release.promise;
      return new Response("finished");
    });
    const url = server.url!;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const get = () =>
      new Promise<string>((resolve, reject) => {
        const request = httpRequest(url, { agent }, (response) => {
          text(response).then(resolve, reject);
        });
        request.on("error", reject);
        request.end();
      });
    const response = get();
    await entered.promise;
    const close = server.close();
    // A busy proxy must not keep this connection alive until the 30s deadline.
    const reuse = setInterval(() => {
      void get().catch(() => {});
    }, 100);
    try {
      release.resolve();
      expect(await response).toBe("finished");
      await close;
      expect(handled).toBe(1);
    } finally {
      clearInterval(reuse);
      agent.destroy();
    }
  });
});
