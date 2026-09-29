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
import {
  hasProxyCacheEntry,
  prefetchProxyCacheForMode,
  PROXY_CACHE_PREFETCH_CONCURRENCY,
  proxyCacheKeyForUrl,
  readProxyCacheEntry,
  scheduleProxyCachePrefetchForMode,
} from "./proxy-cache";
import { drive } from "./storage";

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

describe("proxy cache prefetch", { concurrent: false }, () => {
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

  it("prefetches into the same cache entry served by the proxy route", async () => {
    expect.assertions(6);

    const avatar = new Uint8Array([1, 3, 5, 7]);
    fetchMock.mockResolvedValue(
      buildResponse(avatar, { contentType: "image/webp" }),
    );

    const url = "https://remote.example/avatar.webp";
    const prefetched = await prefetchProxyCacheForMode("cache", url);
    const disk = drive.use();
    const key = proxyCacheKeyForUrl(url);

    expect(prefetched).toBe(true);
    expect(await disk.exists(`${key}.bin`)).toBe(true);
    expect(await disk.exists(`${key}.json`)).toBe(true);

    const app = createProxyApp("cache");
    const { sig, b64url } = signProxyUrl(url);
    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(avatar);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when the cache entry already exists", async () => {
    expect.assertions(4);

    const avatar = new Uint8Array([2, 4, 6, 8]);
    fetchMock.mockResolvedValueOnce(
      buildResponse(avatar, { contentType: "image/png" }),
    );

    const url = "https://remote.example/already.png";
    const disk = drive.use();
    await expect(prefetchProxyCacheForMode("cache", url)).resolves.toBe(true);
    const getBytesMock = vi.spyOn(disk, "getBytes");
    await expect(prefetchProxyCacheForMode("cache", url)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getBytesMock).not.toHaveBeenCalled();
  });

  it("treats missing, null, or malformed cache metadata as a cache miss", async () => {
    expect.assertions(6);

    const disk = drive.use();
    const missingMetaKey = proxyCacheKeyForUrl(
      "https://remote.example/missing-meta.png",
    );
    await disk.put(`${missingMetaKey}.bin`, new Uint8Array([1, 2, 3]), {
      contentType: "image/png",
      visibility: "public",
    });

    await expect(readProxyCacheEntry(missingMetaKey)).resolves.toBeNull();
    await expect(hasProxyCacheEntry(missingMetaKey)).resolves.toBe(false);

    const nullMetaKey = proxyCacheKeyForUrl(
      "https://remote.example/null-meta.png",
    );
    await disk.put(`${nullMetaKey}.bin`, new Uint8Array([4, 5, 6]), {
      contentType: "image/png",
      visibility: "public",
    });
    await disk.put(`${nullMetaKey}.json`, "null", {
      contentType: "application/json",
      visibility: "public",
    });

    await expect(readProxyCacheEntry(nullMetaKey)).resolves.toBeNull();
    await expect(hasProxyCacheEntry(nullMetaKey)).resolves.toBe(false);

    const malformedMetaKey = proxyCacheKeyForUrl(
      "https://remote.example/malformed-meta.png",
    );
    await disk.put(`${malformedMetaKey}.bin`, new Uint8Array([7, 8, 9]), {
      contentType: "image/png",
      visibility: "public",
    });
    await disk.put(`${malformedMetaKey}.json`, "{", {
      contentType: "application/json",
      visibility: "public",
    });

    await expect(readProxyCacheEntry(malformedMetaKey)).resolves.toBeNull();
    await expect(hasProxyCacheEntry(malformedMetaKey)).resolves.toBe(false);
  });

  it("is a no-op outside cache mode", async () => {
    expect.assertions(3);

    const url = "https://remote.example/no-cache.png";

    await expect(prefetchProxyCacheForMode("off", url)).resolves.toBe(false);
    await expect(prefetchProxyCacheForMode("proxy", url)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not cache unsafe or unsupported responses", async () => {
    expect.assertions(4);

    await expect(
      prefetchProxyCacheForMode("cache", "http://127.0.0.1/avatar.png"),
    ).resolves.toBe(false);

    fetchMock.mockResolvedValue(
      buildResponse("<svg/>", { contentType: "image/svg+xml" }),
    );

    const svgUrl = "https://remote.example/avatar.svg";
    await expect(prefetchProxyCacheForMode("cache", svgUrl)).resolves.toBe(
      false,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await drive.use().exists(`${proxyCacheKeyForUrl(svgUrl)}.bin`)).toBe(
      false,
    );
  });

  it("deduplicates scheduled prefetches for the same cache key", async () => {
    expect.assertions(4);

    let resolveFetch: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const url = "https://remote.example/dedupe.png";
    const key = proxyCacheKeyForUrl(url);

    expect(scheduleProxyCachePrefetchForMode("cache", url)).toBe(true);
    expect(scheduleProxyCachePrefetchForMode("cache", url)).toBe(false);
    await waitFor(async () => fetchMock.mock.calls.length === 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch!(buildResponse(new Uint8Array([9, 9, 9])));
    await waitFor(async () => await drive.use().exists(`${key}.bin`));
    expect(await drive.use().exists(`${key}.bin`)).toBe(true);
  });

  it("bounds scheduled prefetch concurrency", async () => {
    expect.assertions(4);

    const resolveFetches: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveFetches.push(resolve);
        }),
    );

    const urls = Array.from(
      { length: PROXY_CACHE_PREFETCH_CONCURRENCY + 2 },
      (_, i) => `https://remote.example/concurrent-${i}.png`,
    );

    expect(
      urls.map((url) => scheduleProxyCachePrefetchForMode("cache", url)),
    ).toEqual(urls.map(() => true));
    await waitFor(
      async () =>
        fetchMock.mock.calls.length === PROXY_CACHE_PREFETCH_CONCURRENCY,
    );
    expect(fetchMock).toHaveBeenCalledTimes(PROXY_CACHE_PREFETCH_CONCURRENCY);

    resolveFetches[0]?.(buildResponse(new Uint8Array([1])));
    await waitFor(
      async () =>
        fetchMock.mock.calls.length === PROXY_CACHE_PREFETCH_CONCURRENCY + 1,
    );
    expect(fetchMock).toHaveBeenCalledTimes(
      PROXY_CACHE_PREFETCH_CONCURRENCY + 1,
    );

    for (let i = 1; i < urls.length; i++) {
      await waitFor(async () => resolveFetches.length > i);
      resolveFetches[i]?.(buildResponse(new Uint8Array([i + 1])));
    }
    const lastKey = proxyCacheKeyForUrl(urls[urls.length - 1]);
    await waitFor(async () => await drive.use().exists(`${lastKey}.bin`));
    expect(await drive.use().exists(`${lastKey}.bin`)).toBe(true);
  });
});
