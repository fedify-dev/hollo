import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
} from "../../../tests/helpers/oauth";
import db from "../../db";
import app from "../../index";
import { listMembers, lists } from "../../schema";
import { uuidv7 } from "../../uuid";

describe.sequential("/api/v1/lists/:id/accounts", () => {
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;
  let listId: ReturnType<typeof uuidv7>;
  let member: Awaited<ReturnType<typeof createAccount>>;

  beforeEach(async () => {
    await cleanDatabase();

    const owner = await createAccount({ username: "owner" });
    member = await createAccount({ username: "member" });
    const client = await createOAuthApplication({ scopes: ["write:lists"] });
    accessToken = await getAccessToken(client, owner, ["write:lists"]);
    listId = uuidv7();
    await db.insert(lists).values({
      id: listId,
      accountOwnerId: owner.id,
      title: "Friends",
    });
  });

  it("adds accounts from Mastodon-style form data", async () => {
    expect.assertions(2);

    const body = new URLSearchParams();
    body.append("account_ids[]", member.id);
    const response = await app.request(`/api/v1/lists/${listId}/accounts`, {
      method: "POST",
      headers: { authorization: bearerAuthorization(accessToken) },
      body,
    });

    expect(response.status).toBe(200);
    await expect(
      db.query.listMembers.findMany({ where: { listId: { eq: listId } } }),
    ).resolves.toMatchObject([{ accountId: member.id }]);
  });

  it("adds accounts from a JSON request", async () => {
    expect.assertions(2);

    const response = await app.request(`/api/v1/lists/${listId}/accounts`, {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ account_ids: [member.id] }),
    });

    expect(response.status).toBe(200);
    await expect(
      db.query.listMembers.findMany({ where: { listId: { eq: listId } } }),
    ).resolves.toMatchObject([{ accountId: member.id }]);
  });

  it("allows adding an existing list member again", async () => {
    expect.assertions(2);

    await db.insert(listMembers).values({ listId, accountId: member.id });
    const body = new URLSearchParams();
    body.append("account_ids[]", member.id);
    const response = await app.request(`/api/v1/lists/${listId}/accounts`, {
      method: "POST",
      headers: { authorization: bearerAuthorization(accessToken) },
      body,
    });

    expect(response.status).toBe(200);
    await expect(
      db.query.listMembers.findMany({ where: { listId: { eq: listId } } }),
    ).resolves.toHaveLength(1);
  });

  it("returns a JSON error for malformed JSON", async () => {
    expect.assertions(2);

    const response = await app.request(`/api/v1/lists/${listId}/accounts`, {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "content-type": "application/json",
      },
      body: '{"account_ids":',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Malformed JSON in request body",
    });
  });

  it("removes accounts from Mastodon-style query parameters", async () => {
    expect.assertions(2);

    await db.insert(listMembers).values({ listId, accountId: member.id });
    const url = new URL(
      `/api/v1/lists/${listId}/accounts`,
      "https://hollo.test",
    );
    url.searchParams.append("account_ids[]", member.id);
    const response = await app.request(url, {
      method: "DELETE",
      headers: { authorization: bearerAuthorization(accessToken) },
    });

    expect(response.status).toBe(200);
    await expect(
      db.select().from(listMembers).where(eq(listMembers.listId, listId)),
    ).resolves.toEqual([]);
  });
});
