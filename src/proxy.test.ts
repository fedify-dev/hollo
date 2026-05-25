import { createHash } from "node:crypto";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { signProxyUrl } from "./media-proxy";
import { createProxyApp } from "./proxy";
import { drive } from "./storage";

function buildResponse(
  body: Uint8Array | string,
  options: { status?: number; contentType?: string } = {},
): Response {
  const status = options.status ?? 200;
  const contentType = options.contentType ?? "image/png";
  const init: BodyInit =
    typeof body === "string" ? body : (body.buffer as ArrayBuffer);
  return new Response(init, {
    status,
    headers: { "Content-Type": contentType },
  });
}

describe.sequential("proxy route", () => {
  let fetchMock: MockInstance<typeof fetch>;

  beforeEach(() => {
    drive.fake();
    fetchMock = vi.spyOn(globalThis, "fetch") as unknown as MockInstance<
      typeof fetch
    >;
    fetchMock.mockReset();
  });

  afterEach(() => {
    drive.restore();
    fetchMock.mockRestore();
  });

  it("returns 404 from an off-mode app", async () => {
    expect.assertions(2);

    const app = createProxyApp("off");
    const { sig, b64url } = signProxyUrl("https://example.com/a.png");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the signature is invalid", async () => {
    expect.assertions(2);

    const app = createProxyApp("proxy");
    const { b64url } = signProxyUrl("https://example.com/a.png");
    const tampered = "AAAAAAAAAAAAAAAAAAAAAA";

    const response = await app.request(`/${tampered}/${b64url}`);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the URL would fail SSRF protection", async () => {
    expect.assertions(2);

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("http://127.0.0.1:9999/secret");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams the upstream body and preserves Content-Type in proxy mode", async () => {
    expect.assertions(5);

    const png = new Uint8Array([1, 2, 3, 4]);
    fetchMock.mockResolvedValue(
      buildResponse(png, { contentType: "image/png" }),
    );

    const app = createProxyApp("proxy");
    const url = "https://remote.example/a.png";
    const { sig, b64url } = signProxyUrl(url);

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.any(Object));
  });

  it("refuses to proxy image/svg+xml to avoid same-origin XSS", async () => {
    expect.assertions(1);

    fetchMock.mockResolvedValue(
      buildResponse("<svg/>", { contentType: "image/svg+xml" }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://remote.example/x.svg");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
  });

  it("re-runs SSRF checks on redirect targets", async () => {
    expect.assertions(2);

    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1:9999/secret" },
      }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://public.example/img");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows safe redirects up to the configured limit", async () => {
    expect.assertions(3);

    const png = new Uint8Array([7, 7, 7]);
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: "https://hop2.example/img" },
        }),
      )
      .mockResolvedValueOnce(buildResponse(png, { contentType: "image/png" }));

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://hop1.example/img");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects responses whose Content-Type is not in the allowlist", async () => {
    expect.assertions(1);

    fetchMock.mockResolvedValue(
      buildResponse("nope", { contentType: "text/html" }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://remote.example/page.html");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
  });

  it("proxies octet-stream responses whose magic bytes identify them as an image", async () => {
    expect.assertions(3);

    // Minimal valid 1×1 PNG (67 bytes)
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    fetchMock.mockResolvedValue(
      buildResponse(png, { contentType: "application/octet-stream" }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://remote.example/avatar");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it("rejects octet-stream responses whose magic bytes are not a recognized media type", async () => {
    expect.assertions(1);

    fetchMock.mockResolvedValue(
      buildResponse("not image data at all", {
        contentType: "application/octet-stream",
      }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://remote.example/unknown");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
  });

  it("rejects binary/octet-stream responses whose magic bytes are not a recognized media type", async () => {
    expect.assertions(1);

    fetchMock.mockResolvedValue(
      buildResponse("not image data at all", {
        contentType: "binary/octet-stream",
      }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://remote.example/unknown");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
  });

  it("probes magic bytes via a head-range request for mid-range octet-stream 206 responses", async () => {
    expect.assertions(4);

    // Minimal 1×1 PNG — returned by the probe (bytes 0-66).
    const pngProbe = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    // The actual requested slice (bytes 5000-5999).
    const partialBody = new Uint8Array(1000).fill(42);

    fetchMock
      .mockResolvedValueOnce(
        new Response(partialBody.buffer as ArrayBuffer, {
          status: 206,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Range": "bytes 5000-5999/100000",
            "Accept-Ranges": "bytes",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(pngProbe.buffer as ArrayBuffer, {
          status: 206,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Range": "bytes 0-66/100000",
          },
        }),
      );

    const app = createProxyApp("proxy");
    const url = "https://remote.example/image";
    const { sig, b64url } = signProxyUrl(url);

    const response = await app.request(`/${sig}/${b64url}`, {
      headers: { Range: "bytes=5000-5999" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(partialBody);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates failed upstream status as 404", async () => {
    expect.assertions(1);

    fetchMock.mockResolvedValue(
      new Response("gone", {
        status: 410,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://remote.example/missing.png");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
  });

  it("rejects oversized bodies advertised via Content-Length up front", async () => {
    expect.assertions(1);

    // 64 MiB declared, which is well past the 32 MiB cap.  We never read
    // the body in this path, so the actual payload size doesn't matter
    // for the assertion.
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([0, 0, 0, 0]).buffer as ArrayBuffer, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(64 * 1024 * 1024),
        },
      }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://remote.example/huge.png");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
  });

  it("writes the cache on first hit and reuses it on the second in cache mode", async () => {
    expect.assertions(4);

    const png = new Uint8Array([9, 8, 7, 6, 5]);
    fetchMock.mockResolvedValue(
      buildResponse(png, { contentType: "image/png" }),
    );

    const app = createProxyApp("cache");
    const url = "https://remote.example/c.png";
    const { sig, b64url } = signProxyUrl(url);

    const first = await app.request(`/${sig}/${b64url}`);
    const second = await app.request(`/${sig}/${b64url}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(png);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards the Range header to upstream and passes 206 through", async () => {
    expect.assertions(5);

    const slice = new Uint8Array([3, 4, 5, 6]);
    fetchMock.mockResolvedValue(
      new Response(slice.buffer as ArrayBuffer, {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Range": "bytes 3-6/100",
          "Accept-Ranges": "bytes",
        },
      }),
    );

    const app = createProxyApp("proxy");
    const url = "https://remote.example/clip.mp4";
    const { sig, b64url } = signProxyUrl(url);

    const response = await app.request(`/${sig}/${b64url}`, {
      headers: { Range: "bytes=3-6" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 3-6/100");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(slice);
    const init = fetchMock.mock.calls[0][1] as RequestInit & {
      headers: Record<string, string>;
    };
    expect(init.headers.Range).toBe("bytes=3-6");
  });

  it("passes 416 Range Not Satisfiable through with Content-Range", async () => {
    expect.assertions(3);

    fetchMock.mockResolvedValue(
      new Response("range error", {
        status: 416,
        headers: {
          "Content-Type": "text/plain",
          "Content-Range": "bytes */100",
        },
      }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://remote.example/clip.mp4");

    const response = await app.request(`/${sig}/${b64url}`, {
      headers: { Range: "bytes=9999-" },
    });

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */100");
    // The upstream's text/plain body is dropped, not forwarded under our origin.
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("bypasses the disk cache for range requests in cache mode", async () => {
    expect.assertions(4);

    const slice = new Uint8Array([1, 2, 3]);
    // Each fetch needs its own Response; a single Response's body can only be
    // consumed once, so a shared mockResolvedValue would 404 on the second
    // hit even though we're explicitly testing two upstream fetches.
    fetchMock.mockImplementation(
      async () =>
        new Response(slice.buffer as ArrayBuffer, {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Range": "bytes 0-2/100",
          },
        }),
    );

    const app = createProxyApp("cache");
    const url = "https://remote.example/clip-range.mp4";
    const { sig, b64url } = signProxyUrl(url);

    const first = await app.request(`/${sig}/${b64url}`, {
      headers: { Range: "bytes=0-2" },
    });
    const second = await app.request(`/${sig}/${b64url}`, {
      headers: { Range: "bytes=0-2" },
    });

    expect(first.status).toBe(206);
    expect(second.status).toBe(206);
    // Both went upstream — no partial body got cached, no cache served.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // And there's no proxy/<sha256>.bin in storage either.
    const disk = drive.use();
    const cacheHash = createHash("sha256").update(url).digest("hex");
    expect(await disk.exists(`proxy/${cacheHash}.bin`)).toBe(false);
  });
});
