---
priority: -80
links:
  '#653': https://github.com/fedify-dev/hollo/issues/653
  '#663': https://github.com/fedify-dev/hollo/pull/663
---
 -  Limited pending poll notification messages to 100 across the shared task
    queue, including delayed wakeups and retries. Repeated schedules coalesce,
    earlier wakeups take priority at the limit, and deferred work is recovered
    after expiry. Delayed poll schedules no longer allocate worker timers.
    [[#653], [#663]]
