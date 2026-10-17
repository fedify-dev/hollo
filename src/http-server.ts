import { FastResponse, type Server, type ServerRequest } from "srvx";
import { serve } from "srvx/node";

/** Install before loading the web application, after configuring Sentry. */
export function enableFastResponse(): void {
  globalThis.Response = class Response extends FastResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      // Hono passes a Response as its initializer when merging headers. srvx
      // 1.0.6 later spreads that initializer, losing inherited status getters.
      super(
        body,
        init instanceof FastResponse
          ? {
              status: init.status,
              statusText: init.statusText,
              headers: init.headers,
            }
          : init,
      );
    }
  };
}

// Match srvx's authority validation so a rejected forwarded host cannot be
// restored into the header used by HTTP signature verification.
// https://github.com/h3js/srvx/blob/v1.0.6/src/_trust-proxy.ts
const forwardedHostPattern =
  /^(\[(?:[A-Fa-f0-9:.]+)\]|(?:[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+|(?:\d{1,3}\.){3}\d{1,3})(:\d{1,5})?$/;

/** Run a Fetch application without buffering or replacing incoming requests. */
export function createHttpServer(
  fetch: (request: Request) => Response | Promise<Response>,
  {
    port,
    hostname,
    behindProxy,
  }: { port: number; hostname?: string; behindProxy: boolean },
): Server {
  const server = serve({
    port,
    hostname,
    // Override srvx's HOST fallback even when BIND is undefined.
    node: { host: hostname },
    trustProxy: behindProxy,
    gracefulShutdown: false,
    silent: true,
    error(error) {
      console.error("Error handling HTTP request:", error);
      return new Response("Internal Server Error", { status: 500 });
    },
    fetch(request: ServerRequest) {
      const node = request.runtime?.node;
      if (node?.res) {
        // An early response must not retain a slow, incomplete upload socket.
        // Wait until the response has been sent before closing the connection.
        node.res.once("finish", () => {
          if (!node.req.complete) node.req.destroy();
          // close() only closes connections that were idle at its call time.
          // Also close those becoming idle as in-flight responses finish.
          const http = server.node?.server;
          if (http && !http.listening && "closeIdleConnections" in http) {
            http.closeIdleConnections();
          }
        });
      }
      if (behindProxy) {
        // srvx caches its URL lazily. Resolve it before removing the headers
        // used for its public origin, without materializing the request body.
        void request.url;
        const host = request.headers
          .get("X-Forwarded-Host")
          ?.split(",")
          .map((value) => value.trim())
          .find((value) => value !== "");
        if (host && forwardedHostPattern.test(host)) {
          // Keep case and explicit default ports: URL.host normalizes them,
          // but the Host header can be part of an HTTP signature.
          request.headers.set("Host", host);
        }
        request.headers.delete("X-Forwarded-Host");
        request.headers.delete("X-Forwarded-Proto");
      }
      return fetch(request);
    },
  });
  return server;
}
