import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { serializeAccount } from "../../entities/account";
import { serializeList } from "../../entities/list";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import { listMembers, lists } from "../../schema";
import { isUuid, uuid, uuidv7 } from "../../uuid";

const app = new Hono<{ Variables: Variables }>();

app.get("/", tokenRequired, scopeRequired(["read:lists"]), async (c) => {
  const owner = c.get("token").accountOwner;
  if (owner == null) {
    return c.json({ error: "The access token is invalid" }, 401);
  }
  const listList = await db.query.lists.findMany({
    where: eq(lists.accountOwnerId, owner.id),
    orderBy: lists.id,
  });
  return c.json(listList.map(serializeList));
});

const listSchema = z.object({
  title: z.string().trim().min(1),
  replies_policy: z.enum(["followed", "list", "none"]).default("list"),
  exclusive: z.boolean().default(false),
});

app.post(
  "/",
  tokenRequired,
  scopeRequired(["write:lists"]),
  zValidator("json", listSchema),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json({ error: "The access token is invalid" }, 401);
    }
    const input = c.req.valid("json");
    const result = await db
      .insert(lists)
      .values({
        id: uuidv7(),
        accountOwnerId: owner.id,
        title: input.title,
        repliesPolicy: input.replies_policy,
        exclusive: input.exclusive,
      })
      .returning();
    return c.json(serializeList(result[0]));
  },
);

app.get("/:id", tokenRequired, scopeRequired(["read:lists"]), async (c) => {
  const listId = c.req.param("id");
  if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
  const owner = c.get("token").accountOwner;
  if (owner == null) {
    return c.json({ error: "The access token is invalid" }, 401);
  }
  const list = await db.query.lists.findFirst({
    where: and(eq(lists.accountOwnerId, owner.id), eq(lists.id, listId)),
  });
  if (list == null) return c.json({ error: "Record not found" }, 404);
  return c.json(serializeList(list));
});

app.put(
  "/:id",
  tokenRequired,
  scopeRequired(["write:lists"]),
  zValidator("json", listSchema),
  async (c) => {
    const listId = c.req.param("id");
    if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json({ error: "The access token is invalid" }, 401);
    }
    const input = c.req.valid("json");
    const result = await db
      .update(lists)
      .set({
        title: input.title,
        repliesPolicy: input.replies_policy,
        exclusive: input.exclusive,
      })
      .where(and(eq(lists.accountOwnerId, owner.id), eq(lists.id, listId)))
      .returning();
    if (result.length < 1) return c.json({ error: "Record not found" }, 404);
    return c.json(serializeList(result[0]));
  },
);

app.delete("/:id", tokenRequired, scopeRequired(["write:lists"]), async (c) => {
  const listId = c.req.param("id");
  if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
  const owner = c.get("token").accountOwner;
  if (owner == null) {
    return c.json({ error: "The access token is invalid" }, 401);
  }
  const result = await db
    .delete(lists)
    .where(and(eq(lists.accountOwnerId, owner.id), eq(lists.id, listId)))
    .returning();
  if (result.length < 1) return c.json({ error: "Record not found" }, 404);
  return c.json({});
});

app.get(
  "/:id/accounts",
  tokenRequired,
  scopeRequired(["read:lists"]),
  async (c) => {
    const listId = c.req.param("id");
    if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json({ error: "The access token is invalid" }, 401);
    }
    const list = await db.query.lists.findFirst({
      where: and(eq(lists.accountOwnerId, owner.id), eq(lists.id, listId)),
    });
    if (list == null) return c.json({ error: "Record not found" }, 404);
    // TODO: pagination
    const members = await db.query.listMembers.findMany({
      with: { account: { with: { successor: true } } },
      where: eq(listMembers.listId, list.id),
      orderBy: listMembers.accountId,
    });
    return c.json(members.map((m) => serializeAccount(m.account, c.req.url)));
  },
);

const membersSchema = z.object({
  account_ids: z.array(uuid).min(1),
});

app.post(
  "/:id/accounts",
  tokenRequired,
  scopeRequired(["write:lists"]),
  zValidator("json", membersSchema),
  async (c) => {
    const listId = c.req.param("id");
    if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json({ error: "The access token is invalid" }, 401);
    }
    const list = await db.query.lists.findFirst({
      where: and(eq(lists.accountOwnerId, owner.id), eq(lists.id, listId)),
    });
    if (list == null) return c.json({ error: "Record not found" }, 404);
    const accountIds = c.req.valid("json").account_ids;
    await db
      .insert(listMembers)
      .values(accountIds.map((id) => ({ listId: list.id, accountId: id })));
    return c.json({});
  },
);

app.delete(
  "/:id/accounts",
  tokenRequired,
  scopeRequired(["write:lists"]),
  zValidator("json", membersSchema),
  async (c) => {
    const listId = c.req.param("id");
    if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json({ error: "The access token is invalid" }, 401);
    }
    const list = await db.query.lists.findFirst({
      where: and(eq(lists.accountOwnerId, owner.id), eq(lists.id, listId)),
    });
    if (list == null) return c.json({ error: "Record not found" }, 404);
    const accountIds = c.req.valid("json").account_ids;
    await db
      .delete(listMembers)
      .where(
        and(
          eq(listMembers.listId, list.id),
          inArray(listMembers.accountId, accountIds),
        ),
      );
    return c.json({});
  },
);

export default app;
