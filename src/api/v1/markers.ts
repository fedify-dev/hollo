import { zValidator } from "@hono/zod-validator";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../../db";
import { serializeMarkers } from "../../entities/marker";
import {
  scopeRequired,
  tokenRequired,
  withAccountOwner,
  type AccountOwnerVariables,
} from "../../oauth/middleware";
import { type MarkerType, markers, type NewMarker } from "../../schema";

const app = new Hono<{ Variables: AccountOwnerVariables }>();

app.get(
  "/",
  tokenRequired,
  scopeRequired(["read:statuses"]),
  withAccountOwner,
  async (c) => {
    const owner = c.get("accountOwner");
    const markerList = await db.query.markers.findMany({
      where: eq(markers.accountOwnerId, owner.id),
    });
    return c.json(serializeMarkers(markerList));
  },
);

app.post(
  "/",
  tokenRequired,
  scopeRequired(["write:statuses"]),
  withAccountOwner,
  zValidator(
    "json",
    z.partialRecord(
      z.enum(["notifications", "home"]),
      z.object({
        last_read_id: z.string(),
      }),
    ),
  ),
  async (c) => {
    const owner = c.get("accountOwner");
    const payload = c.req.valid("json");
    await db.transaction(async (tx) => {
      for (const key in payload) {
        const markerType = key as MarkerType;
        const lastReadId = payload[markerType]?.last_read_id;
        if (lastReadId == null) continue;
        await tx
          .insert(markers)
          .values({
            type: markerType,
            accountOwnerId: owner.id,
            lastReadId,
          } satisfies NewMarker)
          .onConflictDoUpdate({
            set: {
              lastReadId,
              version: sql`${markers.version} + 1`,
              updated: sql`now()`,
            },
            target: [markers.accountOwnerId, markers.type],
          });
      }
    });
    const markerList = await db.query.markers.findMany({
      where: eq(markers.accountOwnerId, owner.id),
    });
    return c.json(serializeMarkers(markerList));
  },
);

export default app;
