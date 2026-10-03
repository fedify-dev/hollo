import { createFederationDebugger } from "@fedify/debugger";
import {
  createFederation,
  type Federation,
  ParallelMessageQueue,
} from "@fedify/fedify";
import { FedifySpanExporter } from "@fedify/fedify/otel";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import type { Sink } from "@logtape/logtape";
import { context, propagation, type TracerProvider } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import metadata from "../../package.json" with { type: "json" };
import { registerBackgroundJobs } from "../background/jobs";
import { TaskMessageQueue } from "../background/queue";
import { postgres } from "../db";
import { FEDIFY_ORIGIN } from "../env";

// oxlint-disable-next-line typescript/dot-notation
const fedifyDebug = process.env["FEDIFY_DEBUG"] === "true";

const kv = new PostgresKvStore(postgres);

let exporter: FedifySpanExporter | undefined;
let tracerProvider: TracerProvider | undefined;
if (fedifyDebug) {
  // Register context manager and propagator (required for trace
  // propagation across async boundaries and message queues):
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  exporter = new FedifySpanExporter(kv);
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
}

const activityQueue = new ParallelMessageQueue(
  new PostgresMessageQueue(postgres),
  10,
);
export const taskQueue = new TaskMessageQueue(
  new PostgresMessageQueue(postgres, {
    tableName: "hollo_task_message_v1",
    channelName: "hollo_task_channel_v1",
    handlerTimeout: { seconds: 0 },
  }),
);

let federation: Federation<void> & { sink?: Sink } = createFederation<void>({
  kv,
  queue: {
    inbox: activityQueue,
    outbox: activityQueue,
    fanout: activityQueue,
    task: taskQueue,
  },
  taskQueueResolution: "strict",
  // Server startup owns the AbortSignal in every consuming mode.
  manuallyStartQueue: true,
  // TODO: Revert to Fedify's default RFC 9421-first behavior once
  // https://github.com/bonfire-networks/activity_pub/issues/8 is fixed and
  // released.
  firstKnock: "draft-cavage-http-signatures-12",
  userAgent: {
    software: `Hollo/${metadata.version}`,
  },
  // oxlint-disable-next-line typescript/dot-notation
  allowPrivateAddress: process.env["ALLOW_PRIVATE_ADDRESS"] === "true",
  tracerProvider,
  origin: FEDIFY_ORIGIN,
});

export const backgroundJobs = registerBackgroundJobs(
  federation,
  async () => (await taskQueue.getDepth()).queued,
);

if (fedifyDebug && exporter != null) {
  federation = createFederationDebugger(federation, { exporter, kv });
}

export { federation };
export default federation;
