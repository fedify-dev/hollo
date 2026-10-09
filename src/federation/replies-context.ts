import { and, eq, inArray } from "drizzle-orm";

import db from "../db";
import {
  type RemoteReplyScrapeJob,
  remoteContextScrapeAliases as aliases,
  remoteReplyScrapeJobs as jobs,
  remoteReplyScrapeOrigins as origins,
} from "../schema";
import {
  isActiveOrCoolingDown,
  laterBySeconds,
  lockContextScrapeIdentity,
  REMOTE_REPLIES_SCRAPE_COOLDOWN_SECONDS,
  settleContextReplies,
} from "./replies";
import { lockScrapeAttempt } from "./replies-state";

/** Coalesce root identities without discarding any seed's gated replies. */
export async function canonicalizeContextJob(
  job: RemoteReplyScrapeJob,
  canonical: URL,
  finalUrl: URL,
  now: Date,
): Promise<RemoteReplyScrapeJob | null> {
  return await db.transaction(async (tx) => {
    await lockContextScrapeIdentity(tx);
    const alias = await tx.query.remoteContextScrapeAliases.findFirst({
      where: { iri: { eq: canonical.href } },
    });
    const [candidate] = await tx
      .select()
      .from(jobs)
      .where(
        alias == null
          ? and(eq(jobs.kind, "context"), eq(jobs.repliesIri, canonical.href))
          : eq(jobs.id, alias.jobId),
      );
    // Context blockers always precede replies gates. Deterministic ordering
    // between context rows avoids two simultaneous alias merges deadlocking.
    const ids = [
      ...new Set([job.id, ...(candidate == null ? [] : [candidate.id])]),
    ].sort();
    const locked = await tx
      .select()
      .from(jobs)
      .where(inArray(jobs.id, ids))
      .orderBy(jobs.id)
      .for("update");
    await lockScrapeAttempt(tx, job);
    let winner = locked.find((row) => row.id !== job.id);
    if (
      winner != null &&
      !isActiveOrCoolingDown(
        winner,
        laterBySeconds(-REMOTE_REPLIES_SCRAPE_COOLDOWN_SECONDS, now),
      )
    ) {
      await tx
        .update(aliases)
        .set({ jobId: job.id })
        .where(eq(aliases.jobId, winner.id));
      await tx
        .update(jobs)
        .set({ blockedByJobId: job.id })
        .where(
          and(eq(jobs.status, "waiting"), eq(jobs.blockedByJobId, winner.id)),
        );
      await tx.delete(jobs).where(eq(jobs.id, winner.id));
      winner = undefined;
    }
    if (winner != null) {
      await tx
        .update(aliases)
        .set({ jobId: winner.id })
        .where(eq(aliases.jobId, job.id));
      await tx
        .update(jobs)
        .set({ blockedByJobId: winner.id })
        .where(
          and(eq(jobs.status, "waiting"), eq(jobs.blockedByJobId, job.id)),
        );
      await settleContextReplies(tx, winner, now);
      for (const iri of new Set([
        job.repliesIri,
        finalUrl.href,
        canonical.href,
      ])) {
        await tx
          .insert(aliases)
          .values({ iri, jobId: winner.id })
          .onConflictDoUpdate({
            target: aliases.iri,
            set: { jobId: winner.id },
          });
      }
      await tx
        .update(origins)
        .set({ processingJobId: null, processingStartedAt: null })
        .where(
          and(
            eq(origins.originHost, job.originHost),
            eq(origins.processingJobId, job.id),
          ),
        );
      await tx.delete(jobs).where(eq(jobs.id, job.id));
      return null;
    }
    const hostChanged = canonical.host !== job.originHost;
    if (hostChanged && job.hostRequeues >= 1)
      throw new Error(
        "Context collection repeatedly changes its canonical host",
      );
    await tx
      .insert(origins)
      .values({ originHost: canonical.host })
      .onConflictDoNothing();
    const [promoted] = await tx
      .update(jobs)
      .set({
        repliesIri: canonical.href,
        ...(hostChanged
          ? {
              originHost: canonical.host,
              hostRequeues: job.hostRequeues + 1,
              status: "pending" as const,
              startedAt: null,
              nextAttemptAt: now,
              nextDispatchAt: now,
            }
          : {}),
        updated: now,
      })
      .where(eq(jobs.id, job.id))
      .returning();
    for (const iri of new Set([
      job.repliesIri,
      finalUrl.href,
      canonical.href,
    ])) {
      await tx
        .insert(aliases)
        .values({ iri, jobId: job.id })
        .onConflictDoUpdate({ target: aliases.iri, set: { jobId: job.id } });
    }
    if (hostChanged) {
      await tx
        .update(origins)
        .set({ processingJobId: null, processingStartedAt: null })
        .where(
          and(
            eq(origins.originHost, job.originHost),
            eq(origins.processingJobId, job.id),
          ),
        );
      return null;
    }
    return promoted;
  });
}
