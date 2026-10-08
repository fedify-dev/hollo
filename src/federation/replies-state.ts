import { and, eq, isNull } from "drizzle-orm";

import type { Transaction } from "../db";
import {
  type RemoteReplyScrapeJob,
  remoteReplyScrapeJobs,
  remoteReplyScrapeOrigins,
} from "../schema";

export class LostScrapeAttempt extends Error {}

export function processingJobAttemptCondition(job: RemoteReplyScrapeJob) {
  return and(
    eq(remoteReplyScrapeJobs.id, job.id),
    eq(remoteReplyScrapeJobs.status, "processing"),
    eq(remoteReplyScrapeJobs.attempts, job.attempts),
    job.startedAt == null
      ? isNull(remoteReplyScrapeJobs.startedAt)
      : eq(remoteReplyScrapeJobs.startedAt, job.startedAt),
  );
}

/** Take the commit fence after remote I/O, with no root-pool awaits afterward. */
export async function lockScrapeAttempt(
  tx: Transaction,
  job: RemoteReplyScrapeJob,
) {
  const [owned] = await tx
    .select({ id: remoteReplyScrapeJobs.id })
    .from(remoteReplyScrapeJobs)
    .where(processingJobAttemptCondition(job))
    .for("update");
  if (owned == null) throw new LostScrapeAttempt("Scrape attempt was replaced");
  const [origin] = await tx
    .select({ host: remoteReplyScrapeOrigins.originHost })
    .from(remoteReplyScrapeOrigins)
    .where(
      and(
        eq(remoteReplyScrapeOrigins.originHost, job.originHost),
        eq(remoteReplyScrapeOrigins.processingJobId, job.id),
      ),
    )
    .for("update");
  if (origin == null)
    throw new LostScrapeAttempt("Scrape origin lease was replaced");
}
