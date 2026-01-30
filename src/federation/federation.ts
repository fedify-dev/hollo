import { createFederation, ParallelMessageQueue } from "@fedify/fedify";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import metadata from "../../package.json" with { type: "json" };
import { postgres } from "../db";

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const nodeType = process.env["NODE_TYPE"] ?? "all";

export const federation = createFederation<void>({
  kv: new PostgresKvStore(postgres),
  queue: new ParallelMessageQueue(new PostgresMessageQueue(postgres), 10),
  // Only start the queue automatically if not running as a web-only node
  manuallyStartQueue: nodeType === "web",
  userAgent: {
    software: `Hollo/${metadata.version}`,
  },
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  allowPrivateAddress: process.env["ALLOW_PRIVATE_ADDRESS"] === "true",
});

export default federation;
