import { exportJwk, generateCryptoKeyPair } from "@fedify/fedify";
import { base64 } from "@hexagon/base64";
import { count, desc, eq } from "drizzle-orm";

import db from "../../src/db";
import * as Schema from "../../src/schema";

import { OOB_REDIRECT_URI } from "../../src/oauth/constants";
import {
  type AccessGrant,
  createAccessGrant,
  createAccessToken,
  createClientCredential,
} from "../../src/oauth/helpers";

export function basicAuthorization(
  application: Pick<Schema.Application, "clientId" | "clientSecret">,
) {
  const credential = Buffer.from(
    `${application.clientId}:${application.clientSecret}`,
  ).toString("base64");

  return `Basic ${credential}`;
}

export function bearerAuthorization(token: Token) {
  return `Bearer ${token.token}`;
}

type createAccountOptions = {
  generateKeyPair?: boolean;
  username?: string;
};

export async function createAccount(
  options: createAccountOptions = { generateKeyPair: false },
): Promise<Pick<Schema.Account, "id">> {
  const username = options.username ?? "hollo";

  const account = await db.transaction(
    async (tx) => {
      await tx
        .insert(Schema.instances)
        .values({
          host: "http://hollo.test",
          software: "hollo",
          softwareVersion: null,
        })
        .onConflictDoNothing();

      const accountId = crypto.randomUUID();
      const accountIri = `http://hollo.test/@${username}`;
      const accountUrl = `https://hollo.test/@${username}`;

      await tx.insert(Schema.accounts).values({
        id: accountId,
        iri: accountIri,
        instanceHost: "http://hollo.test",
        type: "Person",
        name: `Test: ${username}`,
        emojis: {},
        handle: `@${username}@hollo.test`,
        bioHtml: "",
        url: accountUrl,
        protected: false,
        inboxUrl: `${accountIri}/inbox`,
        followersUrl: `${accountIri}/followers`,
        sharedInboxUrl: "https://hollo.test/inbox",
        featuredUrl: `${accountIri}/pinned`,
        published: new Date(),
      });

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
        keyPairs.ed25519PublicKeyJwk = await exportJwk(
          ed25519KeyPair.publicKey,
        );
      }

      await tx.insert(Schema.accountOwners).values({
        id: accountId,
        handle: username,
        ...keyPairs,
        bio: "",
        language: "en",
        visibility: "public",
        themeColor: "amber",
        discoverable: false,
      });

      return { id: accountId };
    },
    {
      isolationLevel: "read committed",
      accessMode: "read write",
    },
  );

  return account;
}

export type OAuthApplicationOptions = {
  scopes?: Schema.Scope[];
  redirectUris?: string[];
  confidential?: boolean;
};

export async function createOAuthApplication(
  options: OAuthApplicationOptions = {
    redirectUris: [OOB_REDIRECT_URI],
  },
): Promise<Pick<Schema.Application, "id">> {
  const clientId = base64.fromArrayBuffer(
    crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer,
    true,
  );
  const clientSecret =
    options.confidential === true
      ? base64.fromArrayBuffer(
          crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer,
          true,
        )
      : "";

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
      confidential: !!options.confidential,
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

export async function getLastApplication(): Promise<Schema.Application> {
  const result = await db
    .select()
    .from(Schema.applications)
    .orderBy(desc(Schema.applications.created))
    .limit(1);

  if (result.length !== 1) {
    throw new Error("Could not retrieve last created application");
  }

  return result[0];
}

export async function countApplications(): Promise<number> {
  const result = await db.select({ count: count() }).from(Schema.applications);
  if (result.length !== 1) {
    throw new Error("Could not count applications");
  }

  return result[0].count;
}

export type Token = {
  token: string;
  scopes: string[];
};

export async function getAccessToken(
  client: Pick<Schema.Application, "id">,
  account: Pick<Schema.Account, "id">,
  scopes: Schema.Scope[] = [],
  redirect_uri: string = OOB_REDIRECT_URI,
): Promise<Token> {
  const application = await getApplication(client);
  const { code } = await createAccessGrant(
    application.id,
    account.id,
    scopes,
    redirect_uri,
  );

  const accessToken = await db.transaction(async (tx) => {
    const accessGrant = await tx.query.accessGrants.findFirst({
      where: eq(Schema.accessGrants.code, code),
    });

    const accessToken = await createAccessToken(accessGrant!, tx);

    return accessToken;
  });

  if (!accessToken) {
    throw new Error("Failed to issue access token for test");
  }

  return {
    token: accessToken.token,
    scopes: accessToken.scope.split(" "),
  };
}

export async function getClientCredentialToken(
  client: Pick<Schema.Application, "id">,
  scopes: Schema.Scope[] = [],
): Promise<Token> {
  const application = await getApplication(client);
  const clientCredential = await createClientCredential(application, scopes);

  if (!clientCredential) {
    throw new Error("Failed to issue client credential for test");
  }

  return {
    token: clientCredential.token,
    scopes: clientCredential.scope.split(" "),
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
    .orderBy(desc(Schema.accessGrants.created))
    .limit(1);

  if (result.length !== 1) {
    throw new Error("Could not retrieve last created access grant");
  }

  return result[0];
}

export async function revokeAccessGrant(
  accessGrant: AccessGrant,
): Promise<void> {
  const updated = await db
    .update(Schema.accessGrants)
    .set({
      revoked: new Date(),
    })
    .where(eq(Schema.accessGrants.code, accessGrant.code))
    .returning({ updated: Schema.accessGrants.code });

  if (updated.length !== 1) {
    throw new Error("Failed to revoke access grant");
  }
}

export async function findAccessGrant(
  code: string,
): Promise<Schema.AccessGrant> {
  const accessGrant = await db.query.accessGrants.findFirst({
    where: eq(Schema.accessGrants.code, code),
  });

  // This should never happen, but can if the application lookup is wrong:
  if (accessGrant == null) {
    throw new Error(`Error fetching OAuth Access Grant: ${code}`);
  }

  return accessGrant;
}

export async function findAccessToken(
  token: string,
): Promise<Schema.AccessToken | undefined> {
  const accessToken = await db.query.accessTokens.findFirst({
    where: eq(Schema.accessTokens.code, token),
  });

  return accessToken;
}
