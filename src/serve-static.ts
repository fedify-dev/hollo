import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { MiddlewareHandler } from "hono";
import { getMimeType } from "hono/utils/mime";
import { staticMiddleware } from "srvx/static";

/** Mount srvx's asynchronous file server in Hono. */
export function serveStatic({
  root,
  prefix,
}: {
  root: string;
  prefix: string;
}): MiddlewareHandler {
  const serve = staticMiddleware({
    dir: root,
    compress: false,
    encodings: false,
    dotfiles: false,
  });
  let realRoot: string | undefined;
  return async (c, next) => {
    if (c.finalized) return next();
    const path = c.req.path;
    // Preserve the previous helper's rejection of encoded/ambiguous paths.
    if (
      (path !== prefix && !path.startsWith(`${prefix}/`)) ||
      path.includes("%") ||
      /(?:^|[/\\])\.{1,2}(?:$|[/\\])|[/\\]{2,}|\\/.test(path)
    ) {
      return next();
    }
    const url = new URL(c.req.url);
    let filename = path.slice(prefix.length) || "/";
    // Preserve exact-file and directory-index lookup. srvx also tries .html
    // aliases, which can select a different resource for extensionless paths.
    const info = await stat(join(root, filename)).catch(() => undefined);
    if (!info) return next();
    if (info.isDirectory()) {
      filename = `${filename.replace(/\/+$/, "")}/index.html`;
    } else if (!info.isFile()) {
      return next();
    }
    // Reject an unservable exact path before srvx can try an adjacent .html
    // alias. srvx still validates the opened file against its root and inode.
    realRoot ??= await realpath(root).catch(() => undefined);
    if (!realRoot) return next();
    const realFile = await realpath(join(root, filename)).catch(
      () => undefined,
    );
    if (!realFile) return next();
    const relativeFile = relative(realRoot, realFile);
    if (
      !relativeFile ||
      isAbsolute(relativeFile) ||
      relativeFile.split(sep).some((part) => part.startsWith("."))
    ) {
      return next();
    }
    if (
      !(await access(realFile, constants.R_OK).then(
        () => true,
        () => false,
      ))
    ) {
      return next();
    }
    url.pathname = filename;
    // The previous helper served files for all methods, with an empty body
    // for HEAD and OPTIONS. Never clone or consume an incoming upload body.
    const request = new Request(url, {
      method:
        c.req.method === "HEAD" || c.req.method === "OPTIONS" ? "HEAD" : "GET",
      headers: c.req.raw.headers,
      signal: c.req.raw.signal,
    });
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      // Conditional retrieval applies to GET/HEAD, not legacy file POSTs or OPTIONS.
      request.headers.delete("If-None-Match");
      request.headers.delete("If-Modified-Since");
      request.headers.delete("If-Range");
    }
    let found = true;
    const response = await serve(request, async () => {
      found = false;
      await next();
      return c.res;
    });
    if (found && response.headers.has("Content-Type")) {
      // srvx has a small MIME table. Retain Hono's full media/font mappings.
      const type = getMimeType(filename);
      if (type) response.headers.set("Content-Type", type);
    }
    if (found && c.req.method === "OPTIONS" && response.status === 200) {
      // OPTIONS has an empty response body, rather than HEAD's representation length.
      response.headers.set("Content-Length", "0");
    }
    return response;
  };
}
