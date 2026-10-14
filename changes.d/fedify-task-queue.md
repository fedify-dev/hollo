---
priority: -20
links:
  '#636': https://github.com/fedify-dev/hollo/issues/636
  '#637': https://github.com/fedify-dev/hollo/issues/637
  '#638': https://github.com/fedify-dev/hollo/issues/638
  '#639': https://github.com/fedify-dev/hollo/issues/639
  '#645': https://github.com/fedify-dev/hollo/pull/645
  '#648': https://github.com/fedify-dev/hollo/pull/648
  '#649': https://github.com/fedify-dev/hollo/pull/649
---
 -  Import and cleanup jobs now run through a dedicated Fedify task queue,
    with bounded concurrency, durable retries, cancellation, and recovery
    after interrupted processing or failed dispatch.  Proxy-cache enumeration
    saves bounded batches without duplicating deletion items on retry.
    Stop older nodes before migrating, then deploy matching web and worker
    versions.  [[#636], [#637], [#645]]

 -  Remote replies scraping now runs through the shared Fedify task queue,
    including delayed retry wakeups.  Durable job and host records retain
    cooldown, request spacing, HTTP 429 backoff, and stale-attempt protection.
    Bounded recovery repairs missed enqueues and interrupted jobs.  Stop older
    nodes before upgrading and deploy compatible task definitions on all nodes.
    [[#636], [#638], [#648]]

 -  Poll expiry notifications now run as delayed Fedify tasks on the shared
    task queue.  Handlers reload the current expiry and recipients, preserving
    owner/poll deduplication and notification group counts.  Bounded recovery
    repairs missed schedules and advances through backlogs after downtime.
    Stop older nodes before upgrading and deploy compatible task definitions
    on all nodes.  [[#636], [#639], [#649]]
