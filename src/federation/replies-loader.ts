import {
  type DocumentLoader,
  Object as APObject,
  type RemoteDocument,
} from "@fedify/vocab";
import { preloadedContexts } from "@fedify/vocab-runtime";
import { eq, sql } from "drizzle-orm";

import db from "../db";
import {
  type RemoteReplyScrapeJob,
  remoteReplyScrapeOrigins as origins,
} from "../schema";
import { isHttpIri, laterBySeconds } from "./replies";
import { LostScrapeAttempt } from "./replies-state";

export class ScrapeRequestLimit extends Error {}
export class ScrapeDeferred extends Error {
  constructor(
    readonly retryAt: Date,
    readonly host: string,
    readonly cause?: unknown,
  ) {
    super(`Requests to ${host} deferred until ${retryAt.toISOString()}`);
  }
}

export function getErrorStatus(error: unknown): number | null {
  return error != null &&
    typeof error === "object" &&
    "response" in error &&
    error.response instanceof Response
    ? error.response.status
    : null;
}

export function retryAfterSeconds(
  error: unknown,
  now = new Date(),
): number | null {
  if (
    error == null ||
    typeof error !== "object" ||
    !("response" in error) ||
    !(error.response instanceof Response)
  )
    return null;
  const value = error.response.headers.get("Retry-After")?.trim();
  if (value == null) return null;
  if (/^-?\d+$/.test(value)) {
    const seconds = Number.parseInt(value, 10);
    return seconds >= 0 ? seconds : null;
  }
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? null
    : Math.max(0, Math.ceil((date - now.getTime()) / 1000));
}

/** One invocation budget and cache shared by traversal and persistence. */
export function createScrapeLoader({
  getJob,
  documentLoader,
  contextLoader,
  maxRequests,
  intervalSeconds,
  backoffSeconds,
  clock,
  checkpoint,
  sleep,
  signal: shutdown,
}: {
  getJob: () => RemoteReplyScrapeJob;
  documentLoader: DocumentLoader;
  contextLoader: DocumentLoader;
  maxRequests: number;
  intervalSeconds: number;
  backoffSeconds: number;
  clock: () => Date;
  checkpoint: () => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}) {
  const controller = new AbortController();
  const signal =
    shutdown == null
      ? controller.signal
      : AbortSignal.any([shutdown, controller.signal]);
  const documents = new Map<string, Promise<RemoteDocument>>();
  const objects = new Map<string, Promise<APObject | null>>();
  const failures = new Map<string, unknown>();
  const blockedHosts = new Map<string, Date>();
  let requests = 0;
  let partial = false;
  const check = () => signal.throwIfAborted();
  const stop = (error: unknown): never => {
    controller.abort(error);
    throw error;
  };
  const record = (url: string, error: unknown) => {
    failures.set(url, error);
    partial = true;
  };

  async function wait(milliseconds: number) {
    let remaining = milliseconds;
    while (remaining > 0) {
      check();
      await checkpoint();
      const chunk = Math.min(remaining, 1000);
      await sleep(chunk);
      remaining -= chunk;
    }
    check();
  }

  async function reserve(host: string) {
    const now = clock();
    // Normal configured pacing must make progress across an attempt.
    // Only waits beyond one configured interval (or 60s) need deferral.
    const deadline = laterBySeconds(Math.max(60, intervalSeconds), now);
    const [slot] = await db
      .insert(origins)
      .values({
        originHost: host,
        nextRequestAt: laterBySeconds(intervalSeconds, now),
        updated: now,
      })
      .onConflictDoUpdate({
        target: origins.originHost,
        set: {
          nextRequestAt: sql`greatest(${origins.nextRequestAt}, ${origins.cooldownUntil}, ${now.toISOString()}::timestamptz) + ${intervalSeconds} * interval '1 second'`,
          updated: sql`greatest(${origins.updated}, ${now.toISOString()}::timestamptz)`,
        },
        setWhere: sql`greatest(${origins.nextRequestAt}, ${origins.cooldownUntil}, ${now.toISOString()}::timestamptz) <= ${deadline.toISOString()}::timestamptz`,
      })
      .returning({ next: origins.nextRequestAt });
    if (slot == null) {
      const origin = await db.query.remoteReplyScrapeOrigins.findFirst({
        where: { originHost: { eq: host } },
      });
      const retryAt =
        origin == null
          ? deadline
          : new Date(Math.max(+origin.nextRequestAt, +origin.cooldownUntil));
      const error = new ScrapeDeferred(retryAt, host);
      if (host === getJob().originHost) stop(error);
      blockedHosts.set(host, retryAt);
      throw error;
    }
    const slotTime = +slot.next - intervalSeconds * 1000;
    await wait(Math.max(0, slotTime - +now));
    await checkpoint();
    check();
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst({
      where: { originHost: { eq: host } },
    });
    // Later slot reservations are not cooldowns. An intervening 429 is.
    if (
      origin != null &&
      +origin.cooldownUntil > Math.max(slotTime, +clock())
    ) {
      const error = new ScrapeDeferred(origin.cooldownUntil, host);
      if (host === getJob().originHost) stop(error);
      blockedHosts.set(host, origin.cooldownUntil);
      throw error;
    }
  }

  const rawLoader: DocumentLoader = (url, options) => {
    check();
    const cached = documents.get(url);
    if (cached != null) return cached;
    const promise = (async () => {
      const iri = new URL(url);
      if (!isHttpIri(iri)) throw new Error(`Unsupported document IRI: ${url}`);
      const cooldown = blockedHosts.get(iri.host);
      if (cooldown != null) throw new ScrapeDeferred(cooldown, iri.host);
      if (requests >= maxRequests)
        stop(new ScrapeRequestLimit("Scrape document request limit reached"));
      await reserve(iri.host);
      check();
      if (requests >= maxRequests)
        stop(new ScrapeRequestLimit("Scrape document request limit reached"));
      requests++;
      try {
        return await documentLoader(url, { ...options, signal });
      } catch (error) {
        if (getErrorStatus(error) === 429) {
          const now = clock();
          const retryAt = laterBySeconds(
            retryAfterSeconds(error, now) ?? backoffSeconds,
            now,
          );
          blockedHosts.set(iri.host, retryAt);
          await db
            .update(origins)
            .set({
              cooldownUntil: sql`greatest(${origins.cooldownUntil}, ${retryAt.toISOString()}::timestamptz)`,
              nextRequestAt: sql`greatest(${origins.nextRequestAt}, ${retryAt.toISOString()}::timestamptz)`,
              updated: sql`greatest(${origins.updated}, ${now.toISOString()}::timestamptz)`,
            })
            .where(eq(origins.originHost, iri.host));
          if (iri.host === getJob().originHost)
            stop(new ScrapeDeferred(retryAt, iri.host, error));
        }
        throw error;
      } finally {
        const now = clock();
        await db
          .update(origins)
          .set({
            lastRequestAt: now,
            updated: sql`greatest(${origins.updated}, ${now.toISOString()}::timestamptz)`,
          })
          .where(eq(origins.originHost, iri.host));
      }
    })().catch((error: unknown) => {
      record(url, error);
      if (error instanceof LostScrapeAttempt) stop(error);
      throw error;
    });
    documents.set(url, promise);
    return promise;
  };

  const boundedContextLoader: DocumentLoader = (url, options) => {
    check();
    if (Object.hasOwn(preloadedContexts, url))
      return contextLoader(url, options);
    return rawLoader(url, options);
  };

  const loadObject = (iri: URL): Promise<APObject | null> => {
    check();
    const cached = objects.get(iri.href);
    if (cached != null) return cached;
    const promise = (async () => {
      const document = await rawLoader(iri.href);
      check();
      const object = await APObject.fromJsonLd(document.document, {
        documentLoader: rawLoader,
        contextLoader: boundedContextLoader,
        baseUrl: new URL(document.documentUrl),
      });
      check();
      if (
        object.id != null &&
        object.id.origin !== new URL(document.documentUrl).origin
      )
        throw new Error(`Document claims a foreign-origin ID: ${iri.href}`);
      return object;
    })().catch((error: unknown) => {
      record(iri.href, error);
      throw error;
    });
    objects.set(iri.href, promise);
    return promise;
  };
  const lookup = async (iri: URL) => {
    try {
      return await loadObject(iri);
    } catch {
      check();
      return null;
    }
  };
  return {
    signal,
    check,
    loadObject,
    lookup,
    documentLoader: rawLoader,
    contextLoader: boundedContextLoader,
    get requestCount() {
      return requests;
    },
    get skippedItems() {
      return failures.size;
    },
    get partial() {
      return partial;
    },
    get errorMessage() {
      if (failures.size === 0) return null;
      return [...failures]
        .slice(0, 10)
        .map(([iri, error]) => {
          const cause =
            error instanceof ScrapeDeferred ? (error.cause ?? error) : error;
          const retryAfter =
            cause != null &&
            typeof cause === "object" &&
            "response" in cause &&
            cause.response instanceof Response
              ? cause.response.headers.get("Retry-After")
              : null;
          return `${iri}: ${cause instanceof Error ? cause.message : String(cause)} (HTTP ${getErrorStatus(cause) ?? "unknown"}${retryAfter == null ? "" : `, Retry-After: ${retryAfter}`})`;
        })
        .join("; ");
    },
    async documentUrl(iri: URL) {
      return new URL((await rawLoader(iri.href)).documentUrl);
    },
    cacheObject(object: APObject, iris: URL[]) {
      for (const iri of iris) objects.set(iri.href, Promise.resolve(object));
    },
  };
}

export type ScrapeLoader = ReturnType<typeof createScrapeLoader>;
