import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db } from "../../db";
import { serializeAccount } from "../../entities/account";
import { serializeList } from "../../entities/list";
import {
  scopeRequired,
  tokenRequired,
  withAccountOwner,
  type AccountOwnerVariables,
} from "../../oauth/middleware";
import { listMembers, lists } from "../../schema";
import { isUuid, uuid, uuidv7, type Uuid } from "../../uuid";

const app = new Hono<{ Variables: AccountOwnerVariables }>();

app.get(
  "/",
  tokenRequired,
  scopeRequired(["read:lists"]),
  withAccountOwner,
  async (c) => {
    const owner = c.get("accountOwner");
    const listList = await db.query.lists.findMany({
      where: { accountOwnerId: { eq: owner.id } },
      orderBy: (lists) => [lists.id],
    });
    return c.json(listList.map(serializeList));
  },
);

const listSchema = z.object({
  title: z.string().trim().min(1),
  replies_policy: z.enum(["followed", "list", "none"]).default("list"),
  exclusive: z.boolean().default(false),
});

app.post(
  "/",
  tokenRequired,
  scopeRequired(["write:lists"]),
  withAccountOwner,
  zValidator("json", listSchema),
  async (c) => {
    const owner = c.get("accountOwner");
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

app.get(
  "/:id",
  tokenRequired,
  scopeRequired(["read:lists"]),
  withAccountOwner,
  async (c) => {
    const listId = c.req.param("id");
    if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("accountOwner");
    const list = await db.query.lists.findFirst({
      where: {
        RAW: (lists, { and, eq }) =>
          and(eq(lists.accountOwnerId, owner.id), eq(lists.id, listId))!,
      },
    });
    if (list == null) return c.json({ error: "Record not found" }, 404);
    return c.json(serializeList(list));
  },
);

app.put(
  "/:id",
  tokenRequired,
  scopeRequired(["write:lists"]),
  withAccountOwner,
  zValidator("json", listSchema),
  async (c) => {
    const listId = c.req.param("id");
    if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("accountOwner");
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

app.delete(
  "/:id",
  tokenRequired,
  scopeRequired(["write:lists"]),
  withAccountOwner,
  async (c) => {
    const listId = c.req.param("id");
    if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("accountOwner");
    const result = await db
      .delete(lists)
      .where(and(eq(lists.accountOwnerId, owner.id), eq(lists.id, listId)))
      .returning();
    if (result.length < 1) return c.json({ error: "Record not found" }, 404);
    return c.json({});
  },
);

app.get(
  "/:id/accounts",
  tokenRequired,
  scopeRequired(["read:lists"]),
  withAccountOwner,
  async (c) => {
    const listId = c.req.param("id");
    if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("accountOwner");
    const list = await db.query.lists.findFirst({
      where: {
        RAW: (lists, { and, eq }) =>
          and(eq(lists.accountOwnerId, owner.id), eq(lists.id, listId))!,
      },
    });
    if (list == null) return c.json({ error: "Record not found" }, 404);
    // TODO: pagination
    const members = await db.query.listMembers.findMany({
      with: { account: { with: { successor: true } } },
      where: { listId: { eq: list.id } },
      orderBy: (listMembers) => [listMembers.accountId],
    });
    return c.json(members.map((m) => serializeAccount(m.account, c.req.url)));
  },
);

const accountIdsSchema = z.array(uuid).min(1);

async function getAccountIds(
  c: Context<{ Variables: AccountOwnerVariables }>,
): Promise<
  { success: true; accountIds: Uuid[] } | { success: false; response: Response }
> {
  let accountIds: unknown =
    c.req.queries("account_ids[]") ?? c.req.queries("account_ids");
  if (accountIds == null) {
    const contentType = c.req
      .header("Content-Type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (
      contentType === "application/json" ||
      contentType?.endsWith("+json") === true
    ) {
      try {
        const body: unknown = await c.req.json();
        accountIds =
          typeof body === "object" && body != null && "account_ids" in body
            ? body.account_ids
            : undefined;
      } catch {
        return {
          success: false,
          response: c.json({ error: "Malformed JSON in request body" }, 400),
        };
      }
    } else {
      const body = await c.req.parseBody({ all: true });
      accountIds = body["account_ids[]"] ?? body.account_ids;
      if (accountIds != null && !Array.isArray(accountIds)) {
        accountIds = [accountIds];
      }
    }
  }
  const result = accountIdsSchema.safeParse(accountIds);
  if (!result.success) {
    return {
      success: false,
      response: c.json(result, 400),
    };
  }
  return { success: true, accountIds: result.data };
}

app.post(
  "/:id/accounts",
  tokenRequired,
  scopeRequired(["write:lists"]),
  withAccountOwner,
  async (c) => {
    const result = await getAccountIds(c);
    if (!result.success) return result.response;
    const listId = c.req.param("id");
    if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("accountOwner");
    const list = await db.query.lists.findFirst({
      where: {
        RAW: (lists, { and, eq }) =>
          and(eq(lists.accountOwnerId, owner.id), eq(lists.id, listId))!,
      },
    });
    if (list == null) return c.json({ error: "Record not found" }, 404);
    await db
      .insert(listMembers)
      .values(
        result.accountIds.map((id) => ({ listId: list.id, accountId: id })),
      )
      .onConflictDoNothing();
    return c.json({});
  },
);

app.delete(
  "/:id/accounts",
  tokenRequired,
  scopeRequired(["write:lists"]),
  withAccountOwner,
  async (c) => {
    const result = await getAccountIds(c);
    if (!result.success) return result.response;
    const listId = c.req.param("id");
    if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("accountOwner");
    const list = await db.query.lists.findFirst({
      where: {
        RAW: (lists, { and, eq }) =>
          and(eq(lists.accountOwnerId, owner.id), eq(lists.id, listId))!,
      },
    });
    if (list == null) return c.json({ error: "Record not found" }, 404);
    await db
      .delete(listMembers)
      .where(
        and(
          eq(listMembers.listId, list.id),
          inArray(listMembers.accountId, result.accountIds),
        ),
      );
    return c.json({});
  },
);

export default app;
