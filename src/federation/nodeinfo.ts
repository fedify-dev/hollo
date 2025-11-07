import {
  count,
  countDistinct,
  eq,
  gt,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { parse } from "semver";
import metadata from "../../package.json" with { type: "json" };
import { db } from "../db";
import { accountOwners, posts } from "../schema";
import { federation } from "./federation";

federation.setNodeInfoDispatcher("/nodeinfo/2.1", async (_ctx) => {
  const version = parse(metadata.version)!;
  const [{ total }] = await db.select({ total: count() }).from(accountOwners);
  const [{ activeMonth }] = await db
    .select({ activeMonth: countDistinct(accountOwners.id) })
    .from(accountOwners)
    .rightJoin(posts, eq(accountOwners.id, posts.accountId))
    .where(gt(posts.updated, sql`CURRENT_TIMESTAMP - INTERVAL '1 month'`));
  const [{ activeHalfyear }] = await db
    .select({ activeHalfyear: countDistinct(accountOwners.id) })
    .from(accountOwners)
    .rightJoin(posts, eq(accountOwners.id, posts.accountId))
    .where(gt(posts.updated, sql`CURRENT_TIMESTAMP - INTERVAL '6 months'`));
  const [{ localPosts }] = await db
    .select({ localPosts: count(posts.id) })
    .from(posts)
    .innerJoin(accountOwners, eq(posts.accountId, accountOwners.id))
    .where(isNull(posts.replyTargetId));
  const [{ localComments }] = await db
    .select({ localComments: count(posts.id) })
    .from(posts)
    .innerJoin(accountOwners, eq(posts.accountId, accountOwners.id))
    .where(isNotNull(posts.replyTargetId));
  return {
    software: {
      name: "hollo",
      version: {
        major: version.major,
        minor: version.minor,
        patch: version.patch,
        build: version.build == null ? undefined : [...version.build],
        prerelease:
          version.prerelease == null ? undefined : [...version.prerelease],
      },
      homepage: new URL("https://docs.hollo.social/"),
      repository: new URL("https://github.com/fedify-dev/hollo"),
    },
    protocols: ["activitypub"],
    services: {
      outbound: ["atom1.0"],
    },
    usage: {
      users: {
        total,
        activeMonth,
        activeHalfyear,
      },
      localComments,
      localPosts,
    },
  };
});

// cSpell: ignore halfyear
