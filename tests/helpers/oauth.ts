import { exportJwk, generateCryptoKeyPair } from "@fedify/fedify";
import { base64 } from "@hexagon/base64";
import { eq } from "drizzle-orm";

import db from "../../src/db";
import * as Schema from "../../src/schema";

import {
  createAccessToken,
  createAuthorizationCode,
} from "../../src/oauth/helpers";

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
  options: OAuthApplicationOptions = {},
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
) {
  const code = await createAuthorizationCode(client.id, account.id, scopes);

  const authorizationGrant = await db.query.accessTokens.findFirst({
    where: eq(Schema.accessTokens.code, code),
  });

  const accessToken = await createAccessToken(authorizationGrant!);

  return {
    authorizationHeader: `${accessToken.type} ${accessToken.token}`,
    scopes: accessToken.scope.split(" "),
  };
}
