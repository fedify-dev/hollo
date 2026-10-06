import type {
  MessageQueue,
  MessageQueueEnqueueOptions,
  MessageQueueListenOptions,
} from "@fedify/fedify";
import {
  PostgresMessageQueue,
  type PostgresMessageQueueOptions,
} from "@fedify/postgres";
import { getLogger } from "@logtape/logtape";
import type { Sql } from "postgres";

const logger = getLogger(["hollo", "poll-notifications", "queue"]);
const TASK_NAME = "hollo.poll-notification.v1";
export const POLL_QUEUE_LIMIT = 100;
// Separate from the two-int keyspace used by Fedify's ordering locks and
// from Hollo's passkey lock (7626128400).
export const POLL_ADMISSION_LOCK = 7626128653;

/**
 * Bounds poll messages in Fedify's PostgreSQL task table, including retries.
 * Queue rows are the reservation: consumption and rollback cannot leave a
 * detached marker suppressing a needed wakeup. Other workloads pass through.
 */
export class PollMessageQueue implements MessageQueue {
  readonly queue: PostgresMessageQueue;
  readonly tableName: string;
  readonly channelName: string;
  private readonly warnings = new Map<string, number>();

  constructor(
    private readonly sql: Sql,
    options: PostgresMessageQueueOptions = {},
  ) {
    this.tableName = options.tableName ?? "hollo_task_message_v1";
    this.channelName = options.channelName ?? "hollo_task_channel_v1";
    this.queue = new PostgresMessageQueue(sql, {
      ...options,
      tableName: this.tableName,
      channelName: this.channelName,
    });
  }

  getDepth() {
    return this.queue.getDepth();
  }

  async getPollDepth(): Promise<number> {
    await this.queue.initialize();
    const [row] = await this.sql`
      SELECT count(*) AS count FROM ${this.sql(this.tableName)}
      WHERE message->>'type' = 'task' AND message->>'taskName' = ${TASK_NAME}
    `;
    return Number(row.count);
  }

  listen(
    handler: (message: unknown) => void | Promise<void>,
    options?: MessageQueueListenOptions,
  ) {
    return this.queue.listen(handler, options);
  }

  private warn(reason: string) {
    const now = Date.now();
    if (now - (this.warnings.get(reason) ?? -Infinity) < 60_000) return;
    this.warnings.set(reason, now);
    logger.warning(
      "Poll queue admission {reason}; displaced or deferred polls remain " +
        "recoverable after expiry (stored limit {limit}).",
      { reason, limit: POLL_QUEUE_LIMIT },
    );
  }

  async enqueue(message: unknown, options?: MessageQueueEnqueueOptions) {
    if (
      message == null ||
      typeof message !== "object" ||
      !("type" in message) ||
      message.type !== "task" ||
      !("taskName" in message) ||
      message.taskName !== TASK_NAME
    ) {
      await this.queue.enqueue(message, options);
      return;
    }
    await this.queue.initialize();
    const key =
      "orderingKey" in message && typeof message.orderingKey === "string"
        ? message.orderingKey
        : undefined;
    const seconds = Math.max(0, options?.delay?.total("seconds") ?? 0);
    try {
      const reason = await this.sql.begin(
        "isolation level read committed",
        async (tx) => {
          await tx`SET LOCAL lock_timeout = '1s'`;
          // Take the lock in its own statement: subsequent statements must
          // see producers that committed while we waited for it.
          await tx`SELECT pg_advisory_xact_lock(${POLL_ADMISSION_LOCK}::bigint)`;
          const [clock] = await tx`
            WITH clock AS (SELECT clock_timestamp() AS now)
            SELECT now::text AS now,
              (now + make_interval(secs => ${seconds}::double precision))::text AS due
            FROM clock
          `;
          if (key != null) {
            const [existing] = await tx`
              SELECT id,
                created + delay > ${clock.due}::text::timestamptz AS later,
                created + delay > ${clock.now}::text::timestamptz AS delayed
              FROM ${tx(this.tableName)}
              WHERE message->>'type' = 'task' AND message->>'taskName' = ${TASK_NAME}
                AND message->>'orderingKey' = ${key}
              LIMIT 1 FOR UPDATE
            `;
            if (existing) {
              if (existing.later) {
                await tx`
                  UPDATE ${tx(this.tableName)}
                  SET delay = make_interval(secs => extract(epoch FROM
                    (${clock.due}::text::timestamptz - created))::double precision)
                  WHERE id = ${existing.id}
                `;
                if (existing.delayed && seconds === 0)
                  await tx`SELECT pg_notify(${this.channelName}, 'PT0S')`;
              }
              return;
            }
          }
          const [depth] = await tx`
            SELECT count(*) AS count FROM ${tx(this.tableName)}
            WHERE message->>'type' = 'task' AND message->>'taskName' = ${TASK_NAME}
          `;
          const full = Number(depth.count) >= POLL_QUEUE_LIMIT;
          if (full) {
            const removed = await tx`
              WITH latest AS (
                SELECT id FROM ${tx(this.tableName)}
                WHERE message->>'type' = 'task' AND message->>'taskName' = ${TASK_NAME}
                  AND created + delay > ${clock.due}::text::timestamptz
                ORDER BY created + delay DESC LIMIT 1 FOR UPDATE
              )
              DELETE FROM ${tx(this.tableName)}
              WHERE id IN (SELECT id FROM latest) RETURNING id
            `;
            if (removed.length === 0) return "deferred-capacity";
          }
          // Explicit text casts bypass postgres.js's JSON/date parameter
          // serializers. Elapsed seconds avoid calendar-day/DST arithmetic.
          // Keep the ordering column null to preserve the backend's FIFO
          // priority; the envelope key is only a coalescing identity.
          await tx`
            INSERT INTO ${tx(this.tableName)} (message, created, delay, ordering_key)
            VALUES (${JSON.stringify(message)}::text::jsonb,
              ${clock.now}::text::timestamptz,
              make_interval(secs => ${seconds}::double precision), NULL)
          `;
          // Delayed NOTIFYs allocate a timer in every worker. Polling discovers
          // future rows within the backend's five-second interval instead.
          if (seconds === 0)
            await tx`SELECT pg_notify(${this.channelName}, 'PT0S')`;
          return full ? "evicted-later-wakeup" : undefined;
        },
      );
      if (reason) this.warn(reason);
    } catch (error) {
      if (
        error != null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "55P03"
      ) {
        this.warn("lock-timeout");
        return;
      }
      throw error;
    }
  }
}
