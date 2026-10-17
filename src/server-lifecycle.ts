type Stop = () => void | Promise<void>;
type Start = (registerStop: (stop: Stop) => void) => Promise<void>;

/** Coordinate startup and shutdown of the HTTP server and background workers. */
export function createServerLifecycle(starters: Start[]) {
  const stops: Stop[] = [];
  let stopping = false;
  let startup: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;

  return {
    get stopping() {
      return stopping;
    },
    start(): Promise<void> {
      return (startup ??= (async () => {
        for (const start of starters) {
          if (stopping) break;
          await start((stop) => stops.push(stop));
        }
      })());
    },
    stop(): Promise<void> {
      stopping = true;
      return (shutdown ??= (async () => {
        // A stop during an import/listen must also release resources acquired
        // by that pending startup. The caller reports any startup failure.
        await startup?.catch(() => {});
        const results = await Promise.allSettled(
          stops.map((stop) => Promise.resolve().then(stop)),
        );
        const failures = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length > 0) {
          throw new AggregateError(failures, "Error stopping server");
        }
      })());
    },
  };
}
