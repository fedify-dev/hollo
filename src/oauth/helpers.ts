import { base64 } from "@hexagon/base64";
import { getLogger } from "@logtape/logtape";

import { lt } from "drizzle-orm";
import db, { type Transaction } from "../db";
import * as schema from "../schema";
import type { Uuid } from "../uuid";
import {
  ACCESS_GRANT_DELETE_AFTER,
  ACCESS_GRANT_EXPIRES_IN,
  ACCESS_GRANT_SIZE,
  ACCESS_TOKEN_SIZE,
} from "./constants";

const logger = getLogger(["hollo", "oauth"]);

export type AccessGrant = {
  code: string;
  expiry: Date;
};

export function randomBytes(length: number): string {
  return base64.fromArrayBuffer(
    crypto.getRandomValues(new Uint8Array(length)).buffer as ArrayBuffer,
    true,
  );
}

export function generatePKCECodeVerifier() {
  return randomBytes(32);
}

const textEncoder = new TextEncoder();

export async function calculatePKCECodeChallenge(codeVerifier: string) {
  return base64.fromArrayBuffer(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(codeVerifier)),
  );
}

export async function createAccessGrant(
  application_id: Uuid,
  account_id: Uuid,
  scopes: schema.Scope[],
  redirect_uri: string,
  code_challenge?: string,
  code_challenge_method?: string,
): Promise<AccessGrant> {
  const code = randomBytes(ACCESS_GRANT_SIZE);

  /* v8 ignore start */
  try {
    await db
      .delete(schema.accessGrants)
      .where(
        lt(
          schema.accessGrants.revoked,
          new Date(Date.now() - ACCESS_GRANT_DELETE_AFTER),
        ),
      );
  } catch (err) {
    logger.warn("Failed to clean up expired access grants", { err });
  }
  /* v8 ignore stop */

  const accessGrant = await db
    .insert(schema.accessGrants)
    .values({
      id: crypto.randomUUID(),
      code,
      applicationId: application_id,
      resourceOwnerId: account_id,
      scopes: scopes,
      redirectUri: redirect_uri,
      expiresIn: ACCESS_GRANT_EXPIRES_IN,
      codeChallenge: code_challenge ?? null,
      codeChallengeMethod: code_challenge_method ?? null,
    } satisfies schema.NewAccessGrant)
    .returning({
      code: schema.accessGrants.code,
      created: schema.accessGrants.created,
      expiresIn: schema.accessGrants.expiresIn,
    });

  /* v8 ignore start */
  if (accessGrant.length !== 1) {
    throw new Error("Error creating access grant");
  }
  /* v8 ignore stop */

  return {
    code: accessGrant[0].code,
    expiry: new Date(
      accessGrant[0].created.valueOf() + accessGrant[0].expiresIn,
    ),
  };
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
  const code = randomBytes(ACCESS_TOKEN_SIZE);

  const result = await tx
    .insert(schema.accessTokens)
    .values({
      code,
      applicationId: accessGrant.applicationId,
      accountOwnerId: accessGrant.resourceOwnerId,
      scopes: accessGrant.scopes,
      grant_type: "authorization_code",
    })
    .returning();

  /* v8 ignore start */
  // This case is only possible if there's some sort of database error, which
  // can't really be tested, unless we mock drizzle somehow?
  if (result.length !== 1) {
    logger.info(
      "Could not create access token, grant: {grant}, code: {token}",
      {
        grant: accessGrant.code,
        token: code,
      },
    );

    return undefined;
  }
  /* v8 ignore end */

  return {
    token: result[0].code,
    type: "Bearer",
    scope: result[0].scopes.join(" "),
    created: result[0].created.valueOf(),
  };
}

export async function createClientCredential(
  application: schema.Application,
  scopes?: schema.Scope[],
): Promise<AccessToken> {
  const code = randomBytes(ACCESS_TOKEN_SIZE);

  const result = await db
    .insert(schema.accessTokens)
    .values({
      code,
      applicationId: application.id,
      scopes: scopes ?? application.scopes,
      grant_type: "client_credentials",
    })
    .returning();

  /* v8 ignore start */
  // This case is only possible if there's some sort of database error, which
  // can't really be tested, unless we mock drizzle somehow?
  //
  // This would only happen if by some amazing luck we managed to generate two
  // of the exact same `code` values:
  if (result.length !== 1) {
    throw new Error(
      "We were unable to create a client credential access token at this time.",
    );
  }
  /* v8 ignore end */

  return {
    token: result[0].code,
    type: "Bearer",
    scope: result[0].scopes.join(" "),
    created: (+result[0].created / 1000) | 0,
  };
}
