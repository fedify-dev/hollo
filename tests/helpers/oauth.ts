import { exportJwk, generateCryptoKeyPair } from "@fedify/fedify";
import { base64 } from "@hexagon/base64";
import { desc, eq } from "drizzle-orm";

import db from "../../src/db";
import * as Schema from "../../src/schema";

import { OOB_REDIRECT_URI } from "../../src/oauth/constants";
import { createAccessGrant, createAccessToken } from "../../src/oauth/helpers";

export async function createAccount(
  options = { generateKeyPair: false },
): Promise<Pick<Schema.Account, "id">> {
  const account = await db.transaction(async (tx) => {
    await tx
      .insert(Schema.instances)
      .values({
        host: "http://hollo.test",
        software: "hollo",
        softwareVersion: null,
      })
      .onConflictDoNothing();

    const account = await tx
      .insert(Schema.accounts)
      .values({
        id: crypto.randomUUID(),
        iri: "http://hollo.test/@hollo",
        instanceHost: "http://hollo.test",
        type: "Person",
        name: "Hollo Test",
        emojis: {},
        handle: "@hollo@hollo.test",
        bioHtml: "",
        url: "https://hollo.test/@hollo",
        protected: false,
        inboxUrl: "https://hollo.test/@hollo/inbox",
        followersUrl: "https://hollo.test/@hollo/followers",
        sharedInboxUrl: "https://hollo.test/inbox",
        featuredUrl: "https://hollo.test/@hollo/pinned",
        published: new Date(),
      })
      .returning({ id: Schema.accounts.id });

    const keyPairs: {
      rsaPrivateKeyJwk: object;
      rsaPublicKeyJwk: object;
      ed25519PrivateKeyJwk: object;
      ed25519PublicKeyJwk: object;
    } = {
      rsaPrivateKeyJwk: {},
      rsaPublicKeyJwk: {},
      ed25519PrivateKeyJwk: {},
      ed25519PublicKeyJwk: {},
    };

    if (options.generateKeyPair) {
      const rsaKeyPair = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
      const ed25519KeyPair = await generateCryptoKeyPair("Ed25519");

      keyPairs.rsaPrivateKeyJwk = await exportJwk(rsaKeyPair.privateKey);
      keyPairs.rsaPublicKeyJwk = await exportJwk(rsaKeyPair.publicKey);
      keyPairs.ed25519PrivateKeyJwk = await exportJwk(
        ed25519KeyPair.privateKey,
      );
      keyPairs.ed25519PublicKeyJwk = await exportJwk(ed25519KeyPair.publicKey);
    }

    await tx
      .insert(Schema.accountOwners)
      .values({
        id: account[0].id,
        handle: "hollo",
        ...keyPairs,
        bio: "",
        language: "en",
        visibility: "public",
        themeColor: "amber",
        discoverable: false,
      })
      .returning({ id: Schema.accountOwners.id });

    return account;
  });

  return account[0];
}

export type OAuthApplicationOptions = {
  scopes?: Schema.Scope[];
  redirectUris?: string[];
};

export async function createOAuthApplication(
  options: OAuthApplicationOptions = { redirectUris: [OOB_REDIRECT_URI] },
): Promise<Pick<Schema.Application, "id">> {
  const clientId = base64.fromArrayBuffer(
    crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer,
    true,
  );
  const clientSecret = base64.fromArrayBuffer(
    crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer,
    true,
  );

  const app = await db
    .insert(Schema.applications)
    .values({
      id: crypto.randomUUID(),
      name: "Test Application",
      redirectUris: options.redirectUris ?? [],
      scopes: options.scopes ?? [],
      website: "",
      clientId,
      clientSecret,
    } satisfies Schema.NewApplication)
    .returning({
      id: Schema.applications.id,
    });

  return app[0];
}

export async function getApplication(
  client: Pick<Schema.Application, "id">,
): Promise<Schema.Application> {
  const application = await db.query.applications.findFirst({
    where: eq(Schema.applications.id, client.id),
  });

  // This should never happen, but can if the application lookup is wrong:
  if (application == null) {
    throw new Error(`Error fetching OAuth Application ${client.id}`);
  }

  return application;
}

export async function getAccessToken(
  client: Pick<Schema.Application, "id">,
  account: Pick<Schema.Account, "id">,
  scopes: Schema.Scope[] = [],
  redirect_uri: string = OOB_REDIRECT_URI,
) {
  const application = await getApplication(client);
  const { token } = await createAccessGrant(
    application.id,
    account.id,
    scopes,
    redirect_uri,
  );

  const accessToken = await db.transaction(async (tx) => {
    const accessGrant = await tx.query.accessGrants.findFirst({
      where: eq(Schema.accessGrants.token, token),
    });

    const accessToken = await createAccessToken(accessGrant!, tx);

    return accessToken;
  });

  if (!accessToken) {
    throw new Error("Failed to issue access token for test");
  }

  return {
    authorizationHeader: `${accessToken.type} ${accessToken.token}`,
    scopes: accessToken.scope.split(" "),
  };
}

export async function getLastAccessToken(): Promise<Schema.AccessToken> {
  const result = await db
    .select()
    .from(Schema.accessTokens)
    .orderBy(desc(Schema.accessTokens.created))
    .limit(1);

  if (result.length !== 1) {
    throw new Error("Could not retrieve last created access token");
  }

  return result[0];
}

export async function getLastAccessGrant(): Promise<Schema.AccessGrant> {
  const result = await db
    .select()
    .from(Schema.accessGrants)
    .orderBy(desc(Schema.accessGrants.createdAt))
    .limit(1);

  if (result.length !== 1) {
    throw new Error("Could not retrieve last created access grant");
  }

  return result[0];
}

export async function getAccessGrant(
  token: string,
): Promise<Schema.AccessGrant> {
  const accessGrant = await db.query.accessGrants.findFirst({
    where: eq(Schema.accessGrants.token, token),
  });

  // This should never happen, but can if the application lookup is wrong:
  if (accessGrant == null) {
    throw new Error(`Error fetching OAuth Access Grant: ${token}`);
  }

  return accessGrant;
}
