import { getLogger } from "@logtape/logtape";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { Context, Env, HonoRequest } from "hono";

import db, { type Transaction } from "../db";
import { base64Url, randomBytes } from "../helpers";
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

export function generatePKCECodeVerifier() {
  return randomBytes(32);
}

const textEncoder = new TextEncoder();

export async function calculatePKCECodeChallenge(codeVerifier: string) {
  return base64Url(
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
      // Deduplicated defensively: `scopesSchema` collapses repeats now, but a
      // grant created before it did could still carry them.
      scopes: [...new Set(accessGrant.scopes)],
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
      scopes: [...new Set(scopes ?? application.scopes)],
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

/**
 * Revokes an access token by its bearer code, scoped to the application it was
 * issued to.  Revocation is a hard delete: `authenticateToken()` treats a row's
 * existence as the entire validity test, so the token stops working instantly.
 * @param code The bearer token to revoke.
 * @param applicationId The application the token must belong to.  A token
 *                      issued to any other application is left untouched.
 * @returns The number of tokens revoked, which is either 0 or 1.
 */
export async function revokeAccessTokenByCode(
  code: string,
  applicationId: Uuid,
): Promise<number> {
  // No RETURNING: the driver reports the affected row count, so nothing is
  // materialized in this process just to be counted.
  const revoked = await db
    .delete(schema.accessTokens)
    .where(
      and(
        eq(schema.accessTokens.code, code),
        eq(schema.accessTokens.applicationId, applicationId),
      ),
    );
  return revoked.count;
}

/**
 * Revokes a single access token by its surrogate id.  The admin dashboard uses
 * this instead of {@link revokeAccessTokenByCode} because it must never handle,
 * or render, the bearer code itself.
 * @param id The access token's surrogate id.
 * @returns The number of tokens revoked, which is either 0 or 1.
 */
export async function revokeAccessToken(id: Uuid): Promise<number> {
  const revoked = await db
    .delete(schema.accessTokens)
    .where(eq(schema.accessTokens.id, id));
  return revoked.count;
}

/**
 * Revokes every access token issued to an application, and marks the
 * application's still-pending access grants as revoked.  Without the latter, an
 * application holding an authorization code that has not been exchanged yet
 * could trade it for a fresh token moments after the operator revoked
 * everything.
 *
 * This clears what an application holds *now*; it does not ban the application.
 * A confidential application that still knows its client secret can call
 * `POST /oauth/token` with `grant_type=client_credentials` immediately
 * afterwards and receive a new app-only token carrying its registered scopes.
 * That is deliberate rather than an oversight: `POST /api/v1/apps` needs no
 * authentication and hardcodes `confidential: true`, so anyone at all can
 * register an application and mint such a token at will.  Re-issuance
 * therefore hands an application nothing that a stranger does not already
 * have, and `withAccountOwner` keeps app-only tokens (whose `accountOwnerId`
 * is null) away from account-scoped endpoints.
 *
 * Banning an application durably would need persistent state on `applications`
 * plus enforcement in `clientAuthentication()`, and it would have to cover the
 * endpoints that use `tokenRequired` without `withAccountOwner` (for example
 * `PUT /api/v1/media/:id`), which app-only tokens can still reach today.  The
 * `/auth` UI is worded to promise only what this function actually delivers.
 * @param applicationId The application whose current access is being cleared.
 * @returns The number of access tokens revoked.
 */
export async function revokeApplicationAccess(
  applicationId: Uuid,
): Promise<number> {
  return await db.transaction(async (tx) => {
    // Revoke the pending grants *before* deleting the tokens.  A concurrent
    // `POST /oauth/token` exchange takes `SELECT ... FOR UPDATE` on the grant
    // row, so with this ordering it either blocks until the grant is already
    // revoked and then fails, or it commits first and the delete below sweeps
    // up the token it just issued.  Deleting first would leave a window where
    // an exchange slips a fresh token in behind the delete and then marks the
    // grant revoked itself, hiding it from the update.
    await tx
      .update(schema.accessGrants)
      .set({ revoked: new Date() })
      .where(
        and(
          eq(schema.accessGrants.applicationId, applicationId),
          isNull(schema.accessGrants.revoked),
        ),
      );
    // No RETURNING here in particular: an application that has been flooded
    // with tokens is exactly the case this page exists to clean up, and
    // returning one row object per deleted token would make the recovery path
    // fail on memory just when it is needed.  The driver's affected row count
    // costs nothing.
    const revoked = await tx
      .delete(schema.accessTokens)
      .where(eq(schema.accessTokens.applicationId, applicationId));
    return revoked.count;
  });
}

/**
 * Retrieves an access token from the request's `Authorization` header.
 * @param c The Hono request context or request object containing
 *          the `Authorization` header.
 * @returns The access token if found, or `undefined` if the header is missing
 *          or malformed, or `null` if the token does not exist in the database.
 */
export async function getAccessToken<T extends Env>(
  c: Context<T> | HonoRequest,
): Promise<
  | (schema.AccessToken & {
      application: schema.Application;
      accountOwner:
        | (schema.AccountOwner & {
            account: schema.Account & { successor: schema.Account | null };
          })
        | null;
    })
  | undefined
  | null
> {
  const req = "req" in c ? c.req : c;
  const authorization = req.header("Authorization");
  if (authorization == null) return undefined;
  const match = /^(?:bearer)\s+(.+)$/i.exec(authorization);
  if (match == null) return undefined;
  const token = match[1];
  const accessToken = await db.query.accessTokens.findFirst({
    where: { code: { eq: token } },
    with: {
      accountOwner: { with: { account: { with: { successor: true } } } },
      application: true,
    },
  });
  if (accessToken == null) return null;
  return accessToken;
}
