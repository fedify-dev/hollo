import type { LookupAddress } from "node:dns";
import dns from "node:dns/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

import * as publicFetch from "@fedify/vocab-runtime/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchPreviewCard } from "./previewcard";

vi.mock("@fedify/vocab-runtime/internal", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@fedify/vocab-runtime/internal")>();
  return { ...actual, openPublicFetch: vi.fn(actual.openPublicFetch) };
});

const actual = await vi.importActual<
  typeof import("@fedify/vocab-runtime/internal")
>("@fedify/vocab-runtime/internal");
const LIMIT = 1024 * 1024;
const URL = "https://preview.test/article";
const HTML = '<meta property="og:title" content="Preview">';
const sessions: publicFetch.PublicFetchSession[] = [];
const fetchMock = vi.fn<typeof fetch>();

function lookupMock() {
  return vi.mocked(
    dns.lookup as (
      hostname: string,
      options: { all: true },
    ) => Promise<LookupAddress[]>,
  );
}

function htmlResponse(
  body: string | Uint8Array = HTML,
  headers: Record<string, string> = { "Content-Type": "text/html" },
) {
  return new Response(
    new Uint8Array(typeof body === "string" ? Buffer.from(body) : body),
    { headers },
  );
}

function streamedResponse(chunks: Uint8Array[], headers = {}) {
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController) => {
    const chunk = chunks.shift();
    if (chunk == null) controller.close();
    else controller.enqueue(chunk);
  });
  const response = new Response(
    new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
    { headers },
  );
  return { response, cancel, pull };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  sessions.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(dns, "lookup");
  lookupMock().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  vi.mocked(publicFetch.openPublicFetch).mockImplementation(async (...args) => {
    const session = await actual.openPublicFetch(...args);
    vi.spyOn(session, "close");
    sessions.push(session);
    return session;
  });
  fetchMock.mockReset().mockImplementation(async () => htmlResponse());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("preview destination validation", () => {
  it.each([
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://198.18.0.1/",
    "http://224.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[2002:7f00:1::]/",
    "http://[2001::1]/",
    "http://localhost/",
    "https://user:password@preview.test/",
    "file:///etc/passwd",
    "ftp://preview.test/",
    "not a URL",
  ])("rejects %s without fetching", async (url) => {
    vi.stubEnv("ALLOW_PRIVATE_ADDRESS", "true");
    expect(await fetchPreviewCard(url)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ address: "127.0.0.1", family: 4 }],
    [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
    [{ address: "::1", family: 6 }],
    [],
  ])("rejects non-public DNS results: %j", async (...addresses) => {
    lookupMock().mockResolvedValue(addresses);
    expect(await fetchPreviewCard(URL)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null for failed DNS", async () => {
    lookupMock().mockRejectedValue(new Error("DNS unavailable"));
    expect(await fetchPreviewCard(URL)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins connections to checked answers without resolving again", async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      // Inspect the actual pinned Undici dispatcher rather than replacing
      // Fedify's security boundary.  Its options symbol is version-specific,
      // intentionally covered by the exact vocab-runtime dependency pin.
      const dispatcher = (
        init as RequestInit & { dispatcher: Record<symbol, unknown> }
      ).dispatcher;
      const key = Object.getOwnPropertySymbols(dispatcher).find(
        (symbol) => symbol.description === "options",
      )!;
      const options = dispatcher[key] as {
        connect: {
          lookup: (
            hostname: string,
            options: { all: boolean },
            callback: (error: Error | null, addresses: unknown) => void,
          ) => void;
        };
      };
      // An unchecked second lookup would now return a private address.
      lookupMock().mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const callback = vi.fn();
      options.connect.lookup("preview.test", { all: true }, callback);
      expect(callback).toHaveBeenCalledWith(null, [
        { address: "8.8.8.8", family: 4 },
      ]);
      return htmlResponse();
    });
    expect((await fetchPreviewCard(URL))?.title).toBe("Preview");
    expect(dns.lookup).toHaveBeenCalledTimes(1);
  });

  it("does not contact an actual loopback server", async () => {
    const hit = vi.fn();
    const server = createServer((_req, res) => {
      hit();
      res.end(HTML);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address == null || typeof address === "string") {
        throw new Error("Missing test server address");
      }
      expect(
        await fetchPreviewCard(`http://127.0.0.1:${address.port}/`),
      ).toBeNull();
      expect(hit).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("preview redirects", () => {
  it.each([
    "http://127.0.0.1/",
    "http://169.254.169.254/",
    "https://user:password@preview.test/",
    "file:///etc/passwd",
    "http://private.test/",
  ])("rejects a redirect to %s before fetching it", async (location) => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: location } }),
    );
    lookupMock()
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    expect(await fetchPreviewCard(URL)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessions[0].close).toHaveBeenCalled();
  });

  it.each([301, 302, 303, 307, 308])(
    "follows a public relative %i redirect after closing the old session",
    async (status) => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(null, { status, headers: { Location: "/final" } }),
        )
        .mockImplementationOnce(async (input) => {
          expect(sessions[0].close).toHaveBeenCalled();
          expect((input as Request).url).toBe("https://preview.test/final");
          return htmlResponse();
        });
      expect((await fetchPreviewCard(URL))?.url).toBe(URL);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sessions[1].close).toHaveBeenCalled();
    },
  );

  it("validates every hop of a cross-origin chain", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: "https://other.test/final" },
        }),
      )
      .mockResolvedValueOnce(htmlResponse());
    expect((await fetchPreviewCard(URL))?.title).toBe("Preview");
    expect(dns.lookup).toHaveBeenCalledWith("other.test", { all: true });
    expect(sessions).toHaveLength(2);
  });

  it("permits exactly five redirects", async () => {
    let requests = 0;
    fetchMock.mockImplementation(async () =>
      requests++ < 5
        ? new Response(null, {
            status: 302,
            headers: { Location: `/hop-${requests}` },
          })
        : htmlResponse(),
    );
    expect((await fetchPreviewCard(URL))?.title).toBe("Preview");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("rejects a sixth redirect", async () => {
    let requests = 0;
    fetchMock.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: `/hop-${++requests}` },
        }),
    );
    expect(await fetchPreviewCard(URL)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(
      sessions.every((session) => vi.mocked(session.close).mock.calls.length),
    ).toBe(true);
  });

  it("rejects cycles without exhausting the hop budget", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: URL } }),
    );
    expect(await fetchPreviewCard(URL)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects without a Location", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302 }));
    expect(await fetchPreviewCard(URL)).toBeNull();
    expect(sessions[0].close).toHaveBeenCalled();
  });
});

describe("preview response limits and cleanup", () => {
  it.each([
    { "Content-Type": "application/octet-stream" },
    { "Content-Type": "application/json" },
    { "Content-Type": "text/html", "Content-Length": String(LIMIT + 1) },
  ])("rejects headers before consuming the body: %j", async (headers) => {
    const { response, cancel, pull } = streamedResponse(
      [Buffer.from(HTML)],
      headers,
    );
    fetchMock.mockResolvedValue(response);
    expect(await fetchPreviewCard(URL)).toBeNull();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(sessions[0].close).toHaveBeenCalled();
  });

  it.each([400, 404, 500])("rejects HTTP %i before reading", async (status) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status });
    fetchMock.mockResolvedValue(response);
    expect(await fetchPreviewCard(URL)).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it.each([{}, { "Content-Length": "1" }])(
    "bounds chunked bodies regardless of Content-Length: %j",
    async (headers) => {
      const { response, cancel } = streamedResponse(
        [Buffer.alloc(LIMIT, " "), Buffer.from("x")],
        headers,
      );
      fetchMock.mockResolvedValue(response);
      expect(await fetchPreviewCard(URL)).toBeNull();
      expect(cancel).toHaveBeenCalled();
      expect(response.body?.locked).toBe(false);
      expect(sessions[0].close).toHaveBeenCalled();
    },
  );

  it("accepts exactly the byte limit", async () => {
    const body = Buffer.alloc(LIMIT, " ");
    body.write(HTML);
    fetchMock.mockResolvedValue(htmlResponse(body));
    expect((await fetchPreviewCard(URL))?.title).toBe("Preview");
  });

  it("counts decompressed rather than compressed bytes", async () => {
    const encoded = gzipSync(Buffer.alloc(LIMIT + 1, " "));
    // Fetch exposes a decoded stream while retaining encoded response headers.
    const decoded = new Blob([new Uint8Array(encoded)])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    const response = new Response(decoded, {
      headers: {
        "Content-Type": "text/html",
        "Content-Encoding": "gzip",
        "Content-Length": String(encoded.length),
      },
    });
    fetchMock.mockResolvedValue(response);
    expect(encoded.length).toBeLessThan(LIMIT);
    expect(await fetchPreviewCard(URL)).toBeNull();
    expect(response.body?.locked).toBe(false);
  });

  it("returns null and closes the session for a broken stream", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("broken response"));
          },
        }),
      ),
    );
    expect(await fetchPreviewCard(URL)).toBeNull();
    expect(sessions[0].close).toHaveBeenCalled();
  });

  it("does not wait for cancellation to settle", async () => {
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(Buffer.alloc(LIMIT + 1));
        },
        cancel: () => new Promise(() => {}),
      }),
    );
    fetchMock.mockResolvedValue(response);
    expect(await fetchPreviewCard(URL)).toBeNull();
    expect(response.body?.locked).toBe(false);
    expect(sessions[0].close).toHaveBeenCalled();
  });

  it("times out stalled DNS and never fetches a late result", async () => {
    vi.useFakeTimers();
    let resolveLookup!: (
      addresses: { address: string; family: number }[],
    ) => void;
    const started = Promise.withResolvers<void>();
    lookupMock().mockImplementation(() => {
      started.resolve();
      return new Promise((resolve) => (resolveLookup = resolve));
    });
    const pending = fetchPreviewCard(URL);
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeNull();
    resolveLookup([{ address: "8.8.8.8", family: 4 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes a session that opens after the deadline", async () => {
    vi.useFakeTimers();
    let resolveSession!: (session: publicFetch.PublicFetchSession) => void;
    const started = Promise.withResolvers<void>();
    vi.mocked(publicFetch.openPublicFetch).mockImplementation(() => {
      started.resolve();
      return new Promise((resolve) => (resolveSession = resolve));
    });
    const session = {
      url: new globalThis.URL(URL),
      fetch: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const pending = fetchPreviewCard(URL);
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeNull();
    resolveSession(session);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.close).toHaveBeenCalled();
    expect(session.fetch).not.toHaveBeenCalled();
  });

  it("uses one deadline across redirects and a stalled body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let bodySignal: AbortSignal;
    const started = Promise.withResolvers<void>();
    fetchMock
      .mockImplementationOnce(() => {
        started.resolve();
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(null, {
                  status: 302,
                  headers: { Location: "/final" },
                }),
              ),
            6000,
          ),
        );
      })
      .mockImplementationOnce(async (_input, init) => {
        bodySignal = init!.signal!;
        return new Response(
          new ReadableStream({
            start(controller) {
              bodySignal.addEventListener("abort", () =>
                controller.error(bodySignal.reason),
              );
            },
            cancel,
          }),
        );
      });
    const pending = fetchPreviewCard(URL);
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeNull();
    expect(bodySignal!.aborted).toBe(true);
    expect(sessions).toHaveLength(2);
    expect(sessions[1].close).toHaveBeenCalled();
  });
});

describe("preview metadata compatibility", () => {
  it("preserves metadata, image fields and explicit og:url", async () => {
    fetchMock.mockResolvedValue(
      htmlResponse(
        '<meta property="og:title" content="Title">' +
          '<meta property="og:description" content="Description">' +
          '<meta property="og:url" content="https://canonical.test/">' +
          '<meta property="og:image" content="https://image.test/image.jpg">' +
          '<meta property="og:image:type" content="image/jpeg">' +
          '<meta property="og:image:width" content="640">' +
          '<meta property="og:image:height" content="480">',
      ),
    );
    expect(await fetchPreviewCard(URL)).toEqual({
      url: "https://canonical.test/",
      title: "Title",
      description: "Description",
      image: {
        url: "https://image.test/image.jpg",
        type: "image/jpeg",
        width: 640,
        height: 480,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps title fallbacks and the input URL", async () => {
    fetchMock.mockResolvedValue(htmlResponse("<title>Fallback title</title>"));
    expect(await fetchPreviewCard(new globalThis.URL(URL))).toEqual({
      url: URL,
      title: "Fallback title",
      description: "",
      image: null,
    });
  });

  it("preserves relative card and image URLs", async () => {
    fetchMock.mockResolvedValue(
      htmlResponse(
        HTML +
          '<meta property="og:url" content="/canonical">' +
          '<meta property="og:image" content="/image.jpg">',
      ),
    );
    const card = await fetchPreviewCard(URL);
    expect(card?.url).toBe("/canonical");
    expect(card?.image?.url).toBe("/image.jpg");
  });

  it.each([
    ["missing MIME", undefined],
    ["XHTML", "application/xhtml+xml"],
    ["case-insensitive HTML", "Text/HTML; charset=UTF-8"],
  ])("accepts %s", async (_name, type) => {
    fetchMock.mockResolvedValue(
      htmlResponse(HTML, type == null ? {} : { "Content-Type": type }),
    );
    expect((await fetchPreviewCard(URL))?.title).toBe("Preview");
  });

  it("defaults to UTF-8 for non-ASCII text", async () => {
    fetchMock.mockResolvedValue(
      htmlResponse('<meta property="og:title" content="안녕하세요 日本語">'),
    );
    expect((await fetchPreviewCard(URL))?.title).toBe("안녕하세요 日本語");
  });

  it.each(["header", "meta", "BOM"])(
    "decodes an explicit %s encoding",
    async (source) => {
      const text = '<meta property="og:title" content="Café">';
      const body =
        source === "BOM"
          ? Buffer.concat([
              Buffer.from([0xff, 0xfe]),
              Buffer.from(text, "utf16le"),
            ])
          : Buffer.from(
              (source === "meta" ? '<meta charset="windows-1252">' : "") + text,
              "latin1",
            );
      fetchMock.mockResolvedValue(
        htmlResponse(body, {
          "Content-Type":
            source === "header"
              ? "text/html; charset=windows-1252"
              : "text/html",
        }),
      );
      expect((await fetchPreviewCard(URL))?.title).toBe("Café");
    },
  );

  it.each(["", "<html><body>No title</body></html>"])(
    "returns null without an empty-html OGS network fallback",
    async (body) => {
      fetchMock.mockResolvedValue(htmlResponse(body));
      expect(await fetchPreviewCard(URL)).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("returns null for transport errors", async () => {
    fetchMock.mockRejectedValue(new Error("Connection failed"));
    expect(await fetchPreviewCard(URL)).toBeNull();
    expect(sessions[0].close).toHaveBeenCalled();
  });
});
