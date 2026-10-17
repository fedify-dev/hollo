---
links:
  '#672': https://github.com/fedify-dev/hollo/issues/672
  '#673': https://github.com/fedify-dev/hollo/pull/673
---
 -  Changed the HTTP server to avoid buffering entire uploads and incoming
    activities before handling them behind a reverse proxy.  Shutdown now waits
    for active HTTP requests alongside background workers within the existing
    30-second deadline.

    Responses now avoid creating a web stream for strings and byte buffers
    until one is needed.

    Proxy mode now uses the first nonempty forwarded host and protocol in a
    comma-separated list, and ignores invalid forwarded hosts in favor of the
    original `Host` header.  Trusted proxies must overwrite client-supplied
    forwarded headers.  [[#672], [#673]]
