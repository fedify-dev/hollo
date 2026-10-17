import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import { Hono } from "hono";
import type { Server } from "srvx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHttpServer, enableFastResponse } from "./http-server";
import { serveStatic } from "./serve-static";

let fixture: string;
let server: Server;
let exactFileReadable: boolean;
const nativeResponse = globalThis.Response;

function send(
  path: string,
  {
    method = "GET",
    headers = {},
  }: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      server.url!,
      { path, method, headers, agent: false },
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
    request.end();
  });
}

beforeAll(async () => {
  enableFastResponse();
  fixture = await mkdtemp(join(tmpdir(), "hollo-static-"));
  const root = join(fixture, "root");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "hello.txt"), "0123456789");
  await writeFile(join(root, "index.html"), "<p>root</p>");
  await writeFile(join(root, "nested", "index.html"), "<p>nested</p>");
  await writeFile(join(root, ".secret"), "hidden");
  await writeFile(join(fixture, "outside.txt"), "outside secret");
  await symlink(join(fixture, "outside.txt"), join(root, "escape.txt"));
  await symlink(join(root, "hello.txt"), join(root, "alias.txt"));
  for (const name of [
    "movie.ogv",
    "sound.oga",
    "song.aac",
    "font.ttf",
    "style.css",
  ]) {
    await writeFile(join(root, name), "fixture");
  }
  await mkdir(join(root, "collision"));
  await writeFile(join(root, "collision.html"), "wrong alias");
  await writeFile(join(root, "collision", "index.html"), "directory index");
  await writeFile(join(root, "alias-only.html"), "unrequested alias");
  await mkdir(join(root, "v1.2.3"));
  await writeFile(join(root, "v1.2.3", "index.html"), "dotted directory");
  await mkdir(join(root, "theme.css"));
  await writeFile(join(root, "theme.css", "index.html"), "HTML index");
  await symlink(join(fixture, "outside.txt"), join(root, "escape"));
  await writeFile(join(root, "escape.html"), "unwanted outside-link fallback");
  await symlink(join(root, ".secret"), join(root, "hidden-alias"));
  await writeFile(
    join(root, "hidden-alias.html"),
    "unwanted hidden-link fallback",
  );
  await writeFile(join(root, "large.txt"), "x".repeat(2048));
  await writeFile(join(root, "unreadable"), "exact file");
  await chmod(join(root, "unreadable"), 0);
  exactFileReadable = await readFile(join(root, "unreadable")).then(
    () => true,
    () => false,
  );
  await writeFile(join(root, "unreadable.html"), "wrong permission fallback");
  const app = new Hono();
  app.use("*", serveStatic({ root, prefix: "/files" }));
  app.all("*", (c) => c.text("fallback", 404));
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
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe("static files", () => {
  it("prefers a directory index over an adjacent HTML file", async () => {
    const response = await send("/files/collision");
    expect(response.status).toBe(200);
    expect(response.body).toBe("directory index");
  });

  it("does not add an HTML extension to a missing path", async () => {
    const response = await send("/files/alias-only");
    expect(response.status).toBe(404);
    expect(response.body).toBe("fallback");
  });

  it("serves an index for dotted directory names without a trailing slash", async () => {
    const response = await send("/files/v1.2.3");
    expect(response.status).toBe(200);
    expect(response.body).toBe("dotted directory");
  });

  it("uses the index file MIME type for directories named like files", async () => {
    const response = await send("/files/theme.css");
    expect(response.status).toBe(200);
    expect(response.body).toBe("HTML index");
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it.each(["escape", "hidden-alias"])(
    "does not serve an HTML alias after rejecting %s",
    async (name) => {
      const response = await send(`/files/${name}`);
      expect(response.status).toBe(404);
      expect(response.body).toBe("fallback");
    },
  );

  it("does not serve an HTML alias when the exact file cannot be read", async () => {
    const response = await send("/files/unreadable");
    // Root and some platforms can read a mode-000 file; neither may select its alias.
    expect(response.status).toBe(exactFileReadable ? 200 : 404);
    expect(response.body).toBe(exactFileReadable ? "exact file" : "fallback");
  });

  it("serves files without enabling compression or a cache lifetime", async () => {
    const response = await send("/files/large.txt?download=true", {
      headers: { "Accept-Encoding": "gzip, br" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe("x".repeat(2048));
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.headers["content-length"]).toBe("2048");
    expect(response.headers["cache-control"]).toBeUndefined();
    expect(response.headers["content-encoding"]).toBeUndefined();
  });

  it.each(["HEAD", "OPTIONS"])(
    "preserves empty %s responses",
    async (method) => {
      const response = await send("/files/hello.txt", { method });
      expect(response.status).toBe(200);
      expect(response.body).toBe("");
      expect(response.headers["content-length"]).toBe(
        method === "HEAD" ? "10" : "0",
      );
    },
  );

  it("keeps serving files for POST as the previous helper did", async () => {
    const response = await send("/files/hello.txt", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.body).toBe("0123456789");
  });

  it.each([
    ["bytes=2-4", "234", "bytes 2-4/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=8-", "89", "bytes 8-9/10"],
  ])("serves %s", async (range, body, contentRange) => {
    const response = await send("/files/hello.txt", {
      headers: { Range: range },
    });
    expect(response.status).toBe(206);
    expect(response.body).toBe(body);
    expect(response.headers["content-range"]).toBe(contentRange);
    expect(response.headers["content-length"]).toBe(String(body.length));
  });

  it("does not apply GET revalidation to legacy POST or OPTIONS", async () => {
    const initial = await send("/files/hello.txt");
    for (const method of ["POST", "OPTIONS"]) {
      const response = await send("/files/hello.txt", {
        method,
        headers: { "If-None-Match": initial.headers.etag! },
      });
      expect(response.status).toBe(200);
      expect(response.body).toBe(method === "POST" ? "0123456789" : "");
    }
  });

  it("rejects an unsatisfiable range", async () => {
    const response = await send("/files/hello.txt", {
      headers: { Range: "bytes=20-" },
    });
    expect(response.status).toBe(416);
    expect(response.headers["content-range"]).toBe("bytes */10");
    expect(response.body).toBe("");
  });

  it("revalidates with ETag and Last-Modified", async () => {
    const initial = await send("/files/hello.txt");
    expect(initial.headers.etag).toBeTypeOf("string");
    expect(initial.headers["last-modified"]).toBeTypeOf("string");
    const validators: Record<string, string>[] = [
      { "If-None-Match": initial.headers.etag! },
      { "If-Modified-Since": initial.headers["last-modified"]! },
    ];
    for (const headers of validators) {
      const cached = await send("/files/hello.txt", { headers });
      expect(cached.status).toBe(304);
      expect(cached.body).toBe("");
    }
    const stale = await send("/files/hello.txt", {
      headers: {
        Range: "bytes=2-4",
        "If-Range": "Thu, 01 Jan 1970 00:00:00 GMT",
      },
    });
    expect(stale.status).toBe(200);
    expect(stale.body).toBe("0123456789");
  });

  it.each([
    ["movie.ogv", "video/ogg"],
    ["sound.oga", "audio/ogg"],
    ["song.aac", "audio/aac"],
    ["font.ttf", "font/ttf"],
    ["style.css", "text/css; charset=utf-8"],
  ])("preserves the MIME type of %s", async (name, type) => {
    const response = await send(`/files/${name}`);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(type);
    expect(response.body).toBe("fixture");
  });

  it.each(["/files", "/files/", "/files/nested/"])(
    "serves an index at %s",
    async (path) => {
      const response = await send(path);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.body).toContain(
        path.includes("nested") ? "nested" : "root",
      );
    },
  );

  it.each([
    "/files/missing.txt",
    "/files/missing.oga",
    "/files-other/hello.txt",
    "/hello.txt",
    "/files/../outside.txt",
    "/files/%2e%2e/outside.txt",
    "/files/%2F..%2Foutside.txt",
    "/files/%",
    "/files//hello.txt",
    "/files/.secret",
    "/files/escape.txt",
  ])("falls through without exposing %s", async (path) => {
    const response = await send(path);
    expect(response.status).toBe(404);
    expect(response.body).toBe("fallback");
  });

  it("allows symlinks whose targets remain inside the root", async () => {
    const response = await send("/files/alias.txt");
    expect(response.status).toBe(200);
    expect(response.body).toBe("0123456789");
  });
});
