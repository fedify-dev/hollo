import { zValidator } from "@hono/zod-validator";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { serializeMarkers } from "../../entities/marker";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import { type MarkerType, markers, type NewMarker } from "../../schema";

const app = new Hono<{ Variables: Variables }>();

app.get("/", tokenRequired, scopeRequired(["read:statuses"]), async (c) => {
  const owner = c.get("token").accountOwner;
  if (owner == null) {
    return c.json({ error: "This method requires an authenticated user" }, 422);
  }
  const markerList = await db.query.markers.findMany({
    where: eq(markers.accountOwnerId, owner.id),
  });
  return c.json(serializeMarkers(markerList));
});

app.post(
  "/",
  tokenRequired,
  scopeRequired(["write:statuses"]),
  zValidator(
    "json",
    z.record(
      z.enum(["notifications", "home"]),
      z.object({
        last_read_id: z.string(),
      }),
    ),
  ),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
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
