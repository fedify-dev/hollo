type CountEntry =
  | { started: number; pending: Promise<number> }
  | { started: number; value: number };

/** Process-local sharing for replies queries, never for authorization results. */
export function createRepliesQueryCache<Root>({
  capacity = 1024,
  ttl = 5000,
  now = () => performance.now(),
}: {
  capacity?: number;
  ttl?: number;
  now?: () => number;
} = {}) {
  const roots = new Map<string, Promise<Root>>();
  const counts = new Map<string, CountEntry>();

  return {
    loadRoot(key: string, load: () => Promise<Root>): Promise<Root> {
      const existing = roots.get(key);
      if (existing != null) return existing;
      const pending = Promise.resolve().then(load);
      if (roots.size >= capacity) return pending;
      roots.set(key, pending);
      const remove = () => {
        if (roots.get(key) === pending) roots.delete(key);
      };
      // Observe both outcomes without creating an unhandled rejecting finally.
      void pending.then(remove, remove);
      return pending;
    },

    loadCount(key: string, load: () => Promise<number>): Promise<number> {
      const existing = counts.get(key);
      if (existing != null) {
        if ("pending" in existing) return existing.pending;
        if (now() < existing.started + ttl) {
          return Promise.resolve(existing.value);
        }
        counts.delete(key);
      }
      if (counts.size >= capacity) {
        let oldest: string | undefined;
        let started = Infinity;
        for (const [candidate, entry] of counts) {
          if ("value" in entry && entry.started < started) {
            oldest = candidate;
            started = entry.started;
          }
        }
        if (oldest == null) return Promise.resolve().then(load);
        counts.delete(oldest);
      }
      const entry: CountEntry = {
        started: now(),
        pending: Promise.resolve().then(load),
      };
      counts.set(key, entry);
      void entry.pending.then(
        (value) => {
          if (counts.get(key) !== entry) return;
          // Slow queries may satisfy their waiters but must not gain a new TTL.
          if (now() < entry.started + ttl) {
            counts.set(key, { started: entry.started, value });
          } else {
            counts.delete(key);
          }
        },
        () => {
          if (counts.get(key) === entry) counts.delete(key);
        },
      );
      return entry.pending;
    },

    clear() {
      roots.clear();
      counts.clear();
    },
  };
}
