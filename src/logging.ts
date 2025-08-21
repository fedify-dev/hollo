import { AsyncLocalStorage } from "node:async_hooks";
import { Writable } from "node:stream";
import { getFileSink } from "@logtape/file";
import {
  configure,
  getAnsiColorFormatter,
  getStreamSink,
  jsonLinesFormatter,
  type LogLevel,
  parseLogLevel,
} from "@logtape/logtape";

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const LOG_LEVEL: LogLevel = parseLogLevel(process.env["LOG_LEVEL"] ?? "info");
// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const LOG_QUERY: boolean = process.env["LOG_QUERY"] === "true";
// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const LOG_FILE: string | undefined = process.env["LOG_FILE"];

await configure({
  contextLocalStorage: new AsyncLocalStorage(),
  sinks: {
    console: getStreamSink(Writable.toWeb(process.stderr) as WritableStream, {
      formatter: getAnsiColorFormatter({
        timestamp: "time",
      }),
    }),
    file:
      LOG_FILE == null
        ? () => undefined
        : getFileSink(LOG_FILE, {
            formatter: jsonLinesFormatter,
          }),
  },
  filters: {},
  loggers: [
    {
      category: "fedify",
      lowestLevel: LOG_LEVEL,
      sinks: ["console", "file"],
    },
    {
      category: "hollo",
      lowestLevel: LOG_LEVEL,
      sinks: ["console", "file"],
    },
    {
      category: "drizzle-orm",
      lowestLevel: LOG_QUERY ? "debug" : "fatal",
      sinks: ["console", "file"],
    },
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console", "file"],
    },
  ],
});
