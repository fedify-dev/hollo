import { MIMEType } from "node:util";

const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_PREVIEW_REDIRECTS = 5;
const PREVIEW_TIMEOUT_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchPreviewHtml(url: string): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Preview request timed out");
      controller.abort(error);
      reject(error);
    }, PREVIEW_TIMEOUT_MS);
  });
  try {
    // Racing the entire operation also bounds DNS lookups, which cannot
    // themselves be interrupted.  The worker closes any late-opened session.
    return await Promise.race([
      fetchPreviewHtmlWithSignal(url, controller.signal),
      timeout,
    ]);
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}

async function fetchPreviewHtmlWithSignal(
  input: string,
  signal: AbortSignal,
): Promise<string> {
  // This typed internal API is deliberately pinned to an exact version.
  // Recheck its pinning/cleanup contract when upgrading vocab-runtime.
  const { openPublicFetch } = await import("@fedify/vocab-runtime/internal");
  let url = new URL(input);
  const visited = new Set<string>();
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    if (visited.has(url.href)) throw new Error("Preview redirect loop");
    visited.add(url.href);
    // A URL preflight alone is not enough: the session pins the actual
    // connection to validated DNS answers, and never follows redirects.
    const session = await openPublicFetch(url, { signal });
    try {
      signal.throwIfAborted();
      const response = await session.fetch(url, {
        signal,
        headers: { Accept: "text/html, application/xhtml+xml" },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("Location");
        if (location == null || redirects >= MAX_PREVIEW_REDIRECTS) {
          throw new Error("Invalid preview redirect");
        }
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error("Preview request failed");
      const contentType = response.headers.get("Content-Type");
      const mime = contentType == null ? null : new MIMEType(contentType);
      if (
        mime != null &&
        mime.essence !== "text/html" &&
        mime.essence !== "application/xhtml+xml"
      ) {
        throw new Error("Preview response is not HTML");
      }
      if (
        Number(response.headers.get("Content-Length")) > MAX_PREVIEW_BYTES ||
        response.body == null
      ) {
        throw new Error("Invalid preview response size");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_PREVIEW_BYTES) {
            throw new Error("Preview response is too large");
          }
          chunks.push(value);
        }
      } finally {
        // Cancellation of a tee may never settle, so do not await it.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (size === 0) throw new Error("Empty preview response");
      signal.throwIfAborted();
      const { loadBuffer } = await import("cheerio");
      return loadBuffer(Buffer.concat(chunks, size), {
        encoding: {
          defaultEncoding: "utf8",
          transportLayerEncodingLabel: mime?.params.get("charset") ?? undefined,
        },
      }).html();
    } finally {
      // Includes rejected headers, redirects, aborts, and late DNS results.
      await session.close();
    }
  }
}

export interface PreviewCard {
  url: string;
  title: string;
  description: string | null;
  image: {
    url: string;
    type: string | null;
    width: number | null;
    height: number | null;
  } | null;
}

export async function fetchPreviewCard(
  url: string | URL,
): Promise<PreviewCard | null> {
  try {
    const html = await fetchPreviewHtml(url.toString());
    const { default: ogs } = await import("open-graph-scraper");
    // Never give OGS a URL: its own transport buffers unbounded responses.
    const { error, result } = await ogs({ html });
    if (error || !result.success || result.ogTitle == null) return null;
    return {
      url: result.ogUrl ?? url.toString(),
      title: result.ogTitle,
      description: result.ogDescription ?? "",
      image:
        result.ogImage == null || result.ogImage.length < 1
          ? null
          : {
              url: result.ogImage[0].url,
              type: result.ogImage[0].type ?? null,
              width:
                result.ogImage[0].width == null
                  ? null
                  : Number.parseInt(
                      result.ogImage[0].width as unknown as string,
                      10,
                    ),
              height:
                result.ogImage[0].height == null
                  ? null
                  : Number.parseInt(
                      result.ogImage[0].height as unknown as string,
                      10,
                    ),
            },
    };
  } catch {
    return null;
  }
}
