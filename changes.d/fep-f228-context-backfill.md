---
priority: -70
links:
  '#661': https://github.com/fedify-dev/hollo/issues/661
  '#664': https://github.com/fedify-dev/hollo/pull/664
---
 -  Remote conversation backfill now reads [FEP-f228] `context` collections
    through *@fedify/backfill* before falling back to `replies`.  Collection
    aliases share durable jobs, and each seed's replies wait for the context
    result.  Backfill preserves existing posts, restores available parent
    links, and shares a per-attempt document-loader budget across traversal
    and persistence.  Set `REMOTE_REPLIES_SCRAPE_MAX_REQUESTS` to tune that
    budget (default: `200`).  [[#661], [#664]]

[FEP-f228]: https://w3id.org/fep/f228
