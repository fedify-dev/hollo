import { base64 } from "@hexagon/base64";
import { getLogger } from "@logtape/logtape";

import db, { type Transaction } from "../db";
import * as schema from "../schema";
import type { Uuid } from "../uuid";

const logger = getLogger(["hollo", "oauth"]);

const ACCESS_GRANT_SIZE = 64;
const ACCESS_TOKEN_SIZE = 64;
const TEN_MINUTES = 10 * 60 * 1000;

export type AccessGrant = {
  token: string;
};

export async function createAccessGrant(
  application_id: Uuid,
  account_id: Uuid,
  scopes: schema.Scope[],
  redirect_uri: string,
): Promise<AccessGrant> {
  const token = base64.fromArrayBuffer(
    crypto.getRandomValues(new Uint8Array(ACCESS_GRANT_SIZE))
      .buffer as ArrayBuffer,
    true,
  );

  await db.insert(schema.accessGrants).values({
    id: crypto.randomUUID(),
    token,
    applicationId: application_id,
    resourceOwnerId: account_id,
    scopes: scopes,
    redirectUri: redirect_uri,
    expiresIn: TEN_MINUTES,
  } satisfies schema.NewAccessGrant);

  return { token };
}

export type AccessToken = {
  token: string;
  type: "Bearer";
  scope: string;
  created: number;
};

export async function createAccessToken(
  accessGrant: schema.AccessGrant,
  tx: Transaction,
): Promise<AccessToken | undefined> {
  const token = base64.fromArrayBuffer(
    crypto.getRandomValues(new Uint8Array(ACCESS_TOKEN_SIZE))
      .buffer as ArrayBuffer,
    true,
  );

  const result = await tx
    .insert(schema.accessTokens)
    .values({
      code: token,
      applicationId: accessGrant.applicationId,
      accountOwnerId: accessGrant.resourceOwnerId,
      scopes: accessGrant.scopes,
      grant_type: "authorization_code",
    })
    .returning();

  if (result.length !== 1) {
    logger.info("Could not create access token, grant: {code}, code: {token}", {
      code: accessGrant.token,
      token,
    });

    return undefined;
  }

  return {
    token,
    type: "Bearer",
    scope: result[0].scopes.join(" "),
    created: result[0].created.valueOf(),
  };
}

export async function createClientCredential(
  application: schema.Application,
  scopes?: schema.Scope[],
): Promise<AccessToken> {
  const code = base64.fromArrayBuffer(
    crypto.getRandomValues(new Uint8Array(ACCESS_TOKEN_SIZE))
      .buffer as ArrayBuffer,
    true,
  );

  const result = await db
    .insert(schema.accessTokens)
    .values({
      code,
      applicationId: application.id,
      scopes: scopes ?? application.scopes,
      grant_type: "client_credentials",
    })
    .returning();

  // This would only happen if by some amazing luck we managed to generate two
  // of the exact same `code` values:
  if (result.length !== 1) {
    throw new Error(
      "We were unable to create a client credential access token at this time.",
    );
  }

  return {
    token: result[0].code,
    type: "Bearer",
    scope: result[0].scopes.join(" "),
    created: (+result[0].created / 1000) | 0,
  };
}
