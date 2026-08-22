import { hash } from "argon2";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  findAccessGrant,
  findAccessToken,
  getAccessToken,
  getApplication,
  getClientCredentialToken,
} from "../../tests/helpers/oauth";
import { getLoginCookie } from "../../tests/helpers/web";
import db from "../db";
import rootApp from "../index";
import { createAccessGrant } from "../oauth/helpers";
import { accessTokens, applications, credentials, passkeys } from "../schema";
import type { Uuid } from "../uuid";
import app from "./index";

vi.mock("../passkey", async () => {
  const actual =
    await vi.importActual<typeof import("../passkey")>("../passkey");
  return {
    ...actual,
    verifyRegistration: vi.fn(),
  };
});

const { verifyRegistration: mockVerifyRegistration } =
  await import("../passkey");

const TEST_EMAIL = "owner@example.com";

async function seedCredential(): Promise<void> {
  await db.insert(credentials).values({
    email: TEST_EMAIL,
    passwordHash: await hash("hunter2hunter2"),
  });
}

describe("auth passkeys", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.mocked(mockVerifyRegistration).mockClear();
  });

  describe("POST /auth/passkeys/registration/begin", () => {
    it("redirects to /setup if no credential is configured", async () => {
      const cookie = await getLoginCookie();
      const response = await app.request("/auth/passkeys/registration/begin", {
        method: "POST",
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/setup");
    });

    it("returns options JSON and sets a challenge cookie", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();
      const response = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        {
          method: "POST",
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown> & {
        rp: { id: string; name: string };
        user: { name: string };
        challenge: string;
        authenticatorSelection?: {
          residentKey?: string;
          userVerification?: string;
        };
      };
      expect(body.rp.id).toBe("hollo.test");
      expect(body.rp.name).toBe("Hollo");
      expect(body.user.name).toBe(TEST_EMAIL);
      expect(typeof body.challenge).toBe("string");
      expect(body.authenticatorSelection?.residentKey).toBe("required");
      expect(body.authenticatorSelection?.userVerification).toBe("required");
      const setCookie = response.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toMatch(/passkey_reg=/);
      expect(setCookie).toMatch(/HttpOnly/);
    });

    it("requires a valid login cookie", async () => {
      await seedCredential();
      const response = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        {
          method: "POST",
          headers: { "Sec-Fetch-Site": "same-origin" },
        },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toMatch(/^\/login\?next=/);
    });
  });

  describe("POST /auth/passkeys/registration/finish", () => {
    it("rejects requests without a challenge cookie", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();
      const response = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "same-origin",
          },
          body: JSON.stringify({
            registrationResponse: {
              id: "fake",
              rawId: "fake",
              type: "public-key",
              clientExtensionResults: {},
              response: { clientDataJSON: "", attestationObject: "" },
            },
          }),
        },
      );
      expect(response.status).toBe(400);
      const rows = await db.query.passkeys.findMany();
      expect(rows).toEqual([]);
    });

    it("inserts a passkey when verification succeeds", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();

      // First: hit /begin to receive a challenge cookie.
      const beginResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        {
          method: "POST",
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        },
      );
      const challengeCookie = beginResponse.headers.get("Set-Cookie") ?? "";
      const passkeyRegCookie = challengeCookie.split(";")[0];

      // Pretend the browser produced a valid response.
      vi.mocked(mockVerifyRegistration).mockResolvedValueOnce({
        credentialId: "cred-id-abc",
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ["internal", "hybrid"],
        deviceType: "multiDevice",
        backedUp: true,
      });

      const finishResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: `${cookie}; ${passkeyRegCookie}`,
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "same-origin",
          },
          body: JSON.stringify({
            nickname: "My Yubikey",
            registrationResponse: {
              id: "cred-id-abc",
              rawId: "cred-id-abc",
              type: "public-key",
              clientExtensionResults: {},
              response: { clientDataJSON: "", attestationObject: "" },
            },
          }),
        },
      );
      expect(finishResponse.status).toBe(204);
      const setCookie = finishResponse.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toMatch(/passkey_reg=;/);

      const rows = await db.query.passkeys.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "cred-id-abc",
        credentialEmail: TEST_EMAIL,
        counter: 0,
        transports: ["internal", "hybrid"],
        deviceType: "multiDevice",
        backedUp: true,
        nickname: "My Yubikey",
      });
    });

    it("returns 409 when the same credential id is enrolled twice", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();
      const beginResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        {
          method: "POST",
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        },
      );
      const challengeCookie = beginResponse.headers.get("Set-Cookie") ?? "";
      const passkeyRegCookie = challengeCookie.split(";")[0];

      // Pre-seed the duplicate to simulate "this passkey is already on file."
      await db.insert(passkeys).values({
        id: "duplicate-cred-id",
        credentialEmail: TEST_EMAIL,
        publicKey: "preexisting-key",
        counter: 0,
        transports: ["internal"],
        deviceType: "multiDevice",
        backedUp: true,
        nickname: "Old entry",
      });

      vi.mocked(mockVerifyRegistration).mockResolvedValueOnce({
        credentialId: "duplicate-cred-id",
        publicKey: new Uint8Array([9, 9, 9]),
        counter: 0,
        transports: ["internal"],
        deviceType: "multiDevice",
        backedUp: true,
      });

      const finishResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: `${cookie}; ${passkeyRegCookie}`,
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "same-origin",
          },
          body: JSON.stringify({
            registrationResponse: {
              id: "duplicate-cred-id",
              rawId: "duplicate-cred-id",
              type: "public-key",
              clientExtensionResults: {},
              response: { clientDataJSON: "", attestationObject: "" },
            },
          }),
        },
      );
      expect(finishResponse.status).toBe(409);
      const rows = await db.query.passkeys.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.nickname).toBe("Old entry");
    });

    it("rejects challenge cookies bound to a different login session", async () => {
      await seedCredential();
      const beginCookie = await getLoginCookie();
      const beginResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        {
          method: "POST",
          headers: { Cookie: beginCookie, "Sec-Fetch-Site": "same-origin" },
        },
      );
      const challengeCookie = beginResponse.headers.get("Set-Cookie") ?? "";
      const passkeyRegCookie = challengeCookie.split(";")[0];

      // Different "login" timestamp -> different signed cookie value.
      await new Promise((r) => setTimeout(r, 5));
      const otherCookie = await getLoginCookie();

      const finishResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: `${otherCookie}; ${passkeyRegCookie}`,
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "same-origin",
          },
          body: JSON.stringify({
            registrationResponse: {
              id: "x",
              rawId: "x",
              type: "public-key",
              clientExtensionResults: {},
              response: { clientDataJSON: "", attestationObject: "" },
            },
          }),
        },
      );
      expect(finishResponse.status).toBe(400);
      expect(mockVerifyRegistration).not.toHaveBeenCalled();
    });

    it("returns 400 when verification fails", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();
      const beginResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        {
          method: "POST",
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        },
      );
      const challengeCookie = beginResponse.headers.get("Set-Cookie") ?? "";
      const passkeyRegCookie = challengeCookie.split(";")[0];

      vi.mocked(mockVerifyRegistration).mockResolvedValueOnce(null);

      const finishResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: `${cookie}; ${passkeyRegCookie}`,
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "same-origin",
          },
          body: JSON.stringify({
            registrationResponse: {
              id: "x",
              rawId: "x",
              type: "public-key",
              clientExtensionResults: {},
              response: { clientDataJSON: "", attestationObject: "" },
            },
          }),
        },
      );
      expect(finishResponse.status).toBe(400);
      const rows = await db.query.passkeys.findMany();
      expect(rows).toEqual([]);
    });

    it("derives a friendly default nickname from the User-Agent", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();
      const beginResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        {
          method: "POST",
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        },
      );
      const challengeCookie = beginResponse.headers.get("Set-Cookie") ?? "";
      const passkeyRegCookie = challengeCookie.split(";")[0];

      vi.mocked(mockVerifyRegistration).mockResolvedValueOnce({
        credentialId: "cred-id-def",
        publicKey: new Uint8Array([5, 6, 7, 8]),
        counter: 0,
        transports: [],
        deviceType: "singleDevice",
        backedUp: false,
      });

      const finishResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: `${cookie}; ${passkeyRegCookie}`,
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "same-origin",
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
          },
          body: JSON.stringify({
            registrationResponse: {
              id: "cred-id-def",
              rawId: "cred-id-def",
              type: "public-key",
              clientExtensionResults: {},
              response: { clientDataJSON: "", attestationObject: "" },
            },
          }),
        },
      );
      expect(finishResponse.status).toBe(204);
      const row = await db.query.passkeys.findFirst({
        where: { id: { eq: "cred-id-def" } },
      });
      expect(row?.nickname).toBe("macOS device");
    });

    it("consumes the challenge cookie even on a malformed body", async () => {
      // A malformed first request would previously short-circuit at the
      // schema validator before the cookie was deleted, leaving the same
      // signed value usable for the rest of its TTL.
      await seedCredential();
      const cookie = await getLoginCookie();
      const beginResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/begin",
        {
          method: "POST",
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        },
      );
      const challengeCookie = beginResponse.headers.get("Set-Cookie") ?? "";
      const passkeyRegCookie = challengeCookie.split(";")[0];

      const finishResponse = await app.request(
        "http://hollo.test/auth/passkeys/registration/finish",
        {
          method: "POST",
          headers: {
            Cookie: `${cookie}; ${passkeyRegCookie}`,
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "same-origin",
          },
          // The schema requires `registrationResponse`, so this body is
          // invalid and used to trip zValidator before the handler ran.
          body: JSON.stringify({ nickname: "no response" }),
        },
      );
      expect(finishResponse.status).toBe(400);
      const setCookie = finishResponse.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toMatch(/passkey_reg=;/);
    });
  });

  describe("POST /auth/passkeys/:id/delete", () => {
    it("deletes the named passkey and redirects to /auth", async () => {
      await seedCredential();
      await db.insert(passkeys).values({
        id: "cred-to-remove",
        credentialEmail: TEST_EMAIL,
        publicKey: "public-key-base64url",
        counter: 0,
        transports: ["internal"],
        deviceType: "multiDevice",
        backedUp: true,
        nickname: "Old phone",
      });
      const cookie = await getLoginCookie();
      const response = await app.request(
        "/auth/passkeys/cred-to-remove/delete",
        {
          method: "POST",
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/auth");
      const rows = await db.query.passkeys.findMany();
      expect(rows).toEqual([]);
    });

    it("redirects to /auth even when the id does not exist", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();
      const response = await app.request(
        "/auth/passkeys/does-not-exist/delete",
        {
          method: "POST",
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/auth");
    });
  });

  describe("GET /auth", () => {
    it("renders a Passkeys section with the enrolled passkeys", async () => {
      await seedCredential();
      await db.insert(passkeys).values({
        id: "cred-listing",
        credentialEmail: TEST_EMAIL,
        publicKey: "public-key-base64url",
        counter: 0,
        transports: ["internal"],
        deviceType: "multiDevice",
        backedUp: true,
        nickname: "My laptop",
      });
      const cookie = await getLoginCookie();
      const response = await app.request("/auth", {
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Passkeys");
      expect(body).toContain("My laptop");
    });
  });
});

describe("auth authorized applications", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function dashboard(): Promise<string> {
    const cookie = await getLoginCookie();
    const response = await app.request("/auth", {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    expect(response.status).toBe(200);
    return await response.text();
  }

  describe("GET /auth", () => {
    it("lists the application and never renders the bearer token", async () => {
      // This assertion is the reason access_tokens carries a surrogate `id`
      // at all: the table's primary key is the bearer token itself, so
      // addressing tokens by the primary key would print live credentials
      // into the page source.  If this ever fails, the revoke forms have
      // regressed to using the token code.
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({
        scopes: ["read:accounts", "write:statuses"],
      });
      const accessToken = await getAccessToken(client, account, [
        "read:accounts",
        "write:statuses",
      ]);
      const stored = await findAccessToken(accessToken.token);

      const body = await dashboard();

      expect(body).toContain("Authorized applications");
      expect(body).toContain("Test Application");
      expect(body).toContain(stored!.id);
      expect(body).toContain("read:accounts");
      expect(body).toContain("write:statuses");
      expect(body).not.toContain(accessToken.token);
    });

    it("shows an empty state when nothing is authorized", async () => {
      await seedCredential();

      const body = await dashboard();

      expect(body).toContain("No applications are authorized yet.");
    });

    it("groups several tokens under a single application", async () => {
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({ scopes: ["read"] });
      const first = await getAccessToken(client, account, ["read"]);
      const second = await getAccessToken(client, account, ["read"]);
      const storedFirst = await findAccessToken(first.token);
      const storedSecond = await findAccessToken(second.token);

      const body = await dashboard();

      expect(body).toContain(storedFirst!.id);
      expect(body).toContain(storedSecond!.id);
      // One heading for the application, not one per token:
      expect(body.split("Test Application").length - 1).toBe(1);
    });

    it("lists client credential tokens and labels them app-only", async () => {
      await seedCredential();
      const client = await createOAuthApplication({
        scopes: ["read:accounts"],
        confidential: true,
      });
      const credential = await getClientCredentialToken(client, [
        "read:accounts",
      ]);
      const stored = await findAccessToken(credential.token);

      const body = await dashboard();

      expect(body).toContain(stored!.id);
      expect(body).toContain("app-only (client credentials)");
      expect(body).not.toContain(credential.token);
    });

    it("does not linkify a website with a non-HTTP scheme", async () => {
      // POST /api/v1/apps is unauthenticated and validates `website` with
      // z.url(), which accepts javascript: URLs, so the page must filter by
      // protocol at render time.  Insert directly to bypass that endpoint.
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({ scopes: ["read"] });
      await db
        .update(applications)
        .set({ website: "javascript:alert(1)" })
        .where(eq(applications.id, client.id));
      await getAccessToken(client, account, ["read"]);

      const body = await dashboard();

      expect(body).toContain("Test Application");
      expect(body).not.toContain("javascript:");
    });

    it("caps the tokens shown per application and reports the total", async () => {
      // POST /api/v1/apps needs no authentication and tokens never expire, so
      // an unbounded listing would let anyone make this page unusable.
      await seedCredential();
      const client = await createOAuthApplication({
        scopes: ["read"],
        confidential: true,
      });
      for (let i = 0; i < 12; i++) {
        await getClientCredentialToken(client, ["read"]);
      }

      const body = await dashboard();

      expect(body).toContain("Showing the 10 most recent of 12 tokens.");
      const revokeForms = body.split("/auth/tokens/").length - 1;
      expect(revokeForms).toBe(10);
    });

    it("paginates applications and links between the pages", async () => {
      await seedCredential();
      const account = await createAccount();
      // One more application than fits on a page.
      for (let i = 0; i < 21; i++) {
        const client = await createOAuthApplication({ scopes: ["read"] });
        await getAccessToken(client, account, ["read"]);
      }
      const cookie = await getLoginCookie();

      const first = await app.request("/auth", {
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
      });
      const firstBody = await first.text();
      expect(firstBody.split("/auth/applications/").length - 1).toBe(20);
      expect(firstBody).toContain("?apps=1#authorized-apps");
      expect(firstBody).not.toContain("Newer applications");

      const second = await app.request("/auth?apps=1", {
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
      });
      const secondBody = await second.text();
      expect(secondBody.split("/auth/applications/").length - 1).toBe(1);
      expect(secondBody).toContain("?apps=0#authorized-apps");
      expect(secondBody).not.toContain("Older applications");
    });

    it("caps tokens per application rather than across the page", async () => {
      // The LIMIT lives inside a LATERAL subquery, so each application gets its
      // own newest ten.  A single global LIMIT would let the busiest
      // application crowd the others out of the listing entirely.
      await seedCredential();
      const first = await createOAuthApplication({ scopes: ["read"] });
      const second = await createOAuthApplication({ scopes: ["read"] });
      const base = Date.parse("2026-08-21T00:00:00.000Z");
      for (const [index, client] of [first, second].entries()) {
        for (let i = 0; i < 12; i++) {
          await db.insert(accessTokens).values({
            code: `token-${index.toString()}-${i.toString()}`,
            applicationId: client.id,
            scopes: ["read"],
            // The first application's tokens are all newer than the second's.
            created: new Date(base + (1 - index) * 100_000 + i * 1000),
          });
        }
      }

      const body = await dashboard();

      const rows = await db.query.accessTokens.findMany({
        columns: { id: true, applicationId: true },
      });
      const shown = (id: Uuid) =>
        rows.filter(
          (row) =>
            row.applicationId === id &&
            body.includes(`/auth/tokens/${row.id}/delete`),
        ).length;
      expect(shown(first.id)).toBe(10);
      expect(shown(second.id)).toBe(10);
      expect(
        body.split("Showing the 10 most recent of 12 tokens.").length - 1,
      ).toBe(2);
    });

    it("never reports fewer tokens than it renders", async () => {
      // The application listing is chosen from a bounded window of the newest
      // tokens, but each application's rows are fetched from the whole table.
      // Counting over that window undercounts an application whose older
      // tokens fall outside it: it would claim fewer tokens than are rendered
      // and suppress the "showing N of M" note.  Reproducing that needs more
      // tokens than the window holds.
      await seedCredential();
      const target = await createOAuthApplication({ scopes: ["read"] });
      const filler = await createOAuthApplication({ scopes: ["read"] });
      const base = Date.parse("2026-08-21T00:00:00.000Z");

      // One very recent token keeps `target` in the window...
      await db.insert(accessTokens).values({
        code: "target-recent",
        applicationId: target.id,
        scopes: ["read"],
        created: new Date(base + 100_000_000),
      });
      // ...while enough filler tokens crowd out its 14 older ones.
      await db.insert(accessTokens).values(
        Array.from({ length: 10_000 }, (_, i) => ({
          code: `filler-${i.toString()}`,
          applicationId: filler.id,
          scopes: ["read" as const],
          created: new Date(base + 1_000_000 + i),
        })),
      );
      await db.insert(accessTokens).values(
        Array.from({ length: 14 }, (_, i) => ({
          code: `target-old-${i.toString()}`,
          applicationId: target.id,
          scopes: ["read" as const],
          created: new Date(base + i),
        })),
      );

      const cookie = await getLoginCookie();
      const response = await app.request("/auth", {
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
      });
      const body = await response.text();

      // `target` sorts first: its newest token is the newest overall.
      const notes = [
        ...body.matchAll(/most recent of (?:over )?(\d+) tokens/g),
      ].map((m) => Number(m[1]));
      expect(notes[0]).toBe(15);
      // And the count is never below the number of rows rendered under it.
      const section = body.slice(
        body.indexOf(`/auth/applications/${target.id}/tokens/delete`),
      );
      const rendered =
        section
          .slice(0, section.indexOf("most recent of"))
          .split("/auth/tokens/").length - 1;
      expect(notes[0]).toBeGreaterThanOrEqual(rendered);
    });

    it("orders applications by id when their newest tokens tie", async () => {
      // PostgreSQL leaves the order of equal sort keys undefined, and because
      // each page is a separate OFFSET query an undefined order could shift
      // between requests and duplicate or skip an application.  Pinning the
      // tie-break to the application id keeps paging over ties stable.
      await seedCredential();
      const tied = new Date("2026-08-21T00:00:00.000Z");
      const ids: string[] = [];
      for (let i = 0; i < 21; i++) {
        const client = await createOAuthApplication({ scopes: ["read"] });
        await db.insert(accessTokens).values({
          code: `tied-token-${i.toString()}`,
          applicationId: client.id,
          scopes: ["read"],
          created: tied,
        });
        ids.push(client.id);
      }
      const cookie = await getLoginCookie();

      const listed: string[] = [];
      for (const page of [0, 1]) {
        const response = await app.request(`/auth?apps=${page.toString()}`, {
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        });
        const body = await response.text();
        for (const match of body.matchAll(
          /\/auth\/applications\/([0-9a-f-]+)\/tokens\/delete/g,
        )) {
          listed.push(match[1]);
        }
      }

      // Every application exactly once, in descending id order.
      expect(listed).toEqual([...ids].sort().reverse());
    });

    it("falls back to the first page when ?apps= is not a page number", async () => {
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({ scopes: ["read"] });
      const accessToken = await getAccessToken(client, account, ["read"]);
      const stored = await findAccessToken(accessToken.token);
      const cookie = await getLoginCookie();

      // "1junk" in particular: Number.parseInt() alone would read it as page 1
      // and hide the only application on the instance.
      for (const value of ["-3", "1junk", "abc", "1e3", " 1", ""]) {
        const response = await app.request(
          `/auth?apps=${encodeURIComponent(value)}`,
          { headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" } },
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(stored!.id);
      }
    });

    it("clamps an out-of-range page instead of a huge offset", async () => {
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({ scopes: ["read"] });
      await getAccessToken(client, account, ["read"]);
      const cookie = await getLoginCookie();

      // A well-formed but absurd page number is a real page request, so it
      // gets an empty page rather than page 0's contents, but the offset it
      // reaches is bounded.
      const response = await app.request("/auth?apps=9999999999", {
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("There is nothing on this page.");
      expect(body).toContain("?apps=499#authorized-apps");
    });

    it("does not render an absurdly long website", async () => {
      // POST /api/v1/apps is unauthenticated and puts no length limit on
      // `website`, so without a cap anyone could inflate this page at will.
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({ scopes: ["read"] });
      const padded = `https://example.com/${"a".repeat(1024 * 1024)}`;
      await db
        .update(applications)
        .set({ website: padded })
        .where(eq(applications.id, client.id));
      await getAccessToken(client, account, ["read"]);

      const body = await dashboard();

      expect(body).not.toContain(padded);
      expect(body.length).toBeLessThan(100_000);
    });

    it("elides a long but acceptable website in the link text", async () => {
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({ scopes: ["read"] });
      const website = `https://example.com/${"b".repeat(500)}`;
      await db
        .update(applications)
        .set({ website })
        .where(eq(applications.id, client.id));
      await getAccessToken(client, account, ["read"]);

      const body = await dashboard();

      // The full URL is still the link target, but not the link text.
      expect(body).toContain(`href="${website}"`);
      expect(body).toContain("\u2026</a>");
      expect(body).not.toContain(`>${website}</a>`);
    });

    it("collapses and caps repeated scopes", async () => {
      // /oauth/token stores the scopes it is given without deduplicating and
      // bounds neither their number nor their repetition, so one token could
      // otherwise emit hundreds of thousands of chips.
      await seedCredential();
      const client = await createOAuthApplication({ scopes: ["read"] });
      await db.insert(accessTokens).values({
        code: "repeated-scopes",
        applicationId: client.id,
        scopes: Array.from({ length: 50_000 }, () => "read" as const),
      });

      const body = await dashboard();

      // One chip for the single distinct scope, not one per stored element.
      expect(body.split("font-mono text-xs text-neutral-700").length - 1).toBe(
        1,
      );
      expect(body.length).toBeLessThan(100_000);
    });

    it("renders an https website as a link", async () => {
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({ scopes: ["read"] });
      await db
        .update(applications)
        .set({ website: "https://example.com/app" })
        .where(eq(applications.id, client.id));
      await getAccessToken(client, account, ["read"]);

      const body = await dashboard();

      expect(body).toContain('href="https://example.com/app"');
    });
  });

  describe("POST /auth/tokens/:id/delete", () => {
    it("revokes only the named token", async () => {
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({ scopes: ["read"] });
      const doomed = await getAccessToken(client, account, ["read"]);
      const survivor = await getAccessToken(client, account, ["read"]);
      const stored = await findAccessToken(doomed.token);
      const cookie = await getLoginCookie();

      const response = await app.request(`/auth/tokens/${stored!.id}/delete`, {
        method: "POST",
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/auth#authorized-apps");
      expect(await findAccessToken(doomed.token)).toBeUndefined();
      expect(await findAccessToken(survivor.token)).toBeDefined();
    });

    it("stops the revoked token from authenticating API requests", async () => {
      // The revocation is a row delete and authenticateToken() treats a row's
      // existence as the entire validity test, so this is the guarantee the
      // whole feature rests on.
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({ scopes: ["read"] });
      const accessToken = await getAccessToken(client, account, ["read"]);
      const stored = await findAccessToken(accessToken.token);
      // The API lives on the root app; `app` here is only the pages router.
      const before = await rootApp.request("/api/v1/apps/verify_credentials", {
        headers: { Authorization: bearerAuthorization(accessToken) },
      });
      expect(before.status).toBe(200);
      const cookie = await getLoginCookie();

      await app.request(`/auth/tokens/${stored!.id}/delete`, {
        method: "POST",
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
      });

      const after = await rootApp.request("/api/v1/apps/verify_credentials", {
        headers: { Authorization: bearerAuthorization(accessToken) },
      });
      expect(after.status).toBe(401);
    });

    it("redirects even when the id matches no token", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();

      const response = await app.request(
        `/auth/tokens/${crypto.randomUUID()}/delete`,
        {
          method: "POST",
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/auth#authorized-apps");
    });

    it("responds 404 when the id is not a UUID", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();

      const response = await app.request("/auth/tokens/not-a-uuid/delete", {
        method: "POST",
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
      });

      expect(response.status).toBe(404);
    });

    it("requires a login session", async () => {
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({ scopes: ["read"] });
      const accessToken = await getAccessToken(client, account, ["read"]);
      const stored = await findAccessToken(accessToken.token);

      const response = await app.request(`/auth/tokens/${stored!.id}/delete`, {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toMatch(/^\/login\?next=/);
      expect(await findAccessToken(accessToken.token)).toBeDefined();
    });
  });

  describe("POST /auth/applications/:id/tokens/delete", () => {
    it("revokes every token of the application and leaves others alone", async () => {
      await seedCredential();
      const account = await createAccount();
      const target = await createOAuthApplication({
        scopes: ["read"],
        confidential: true,
      });
      const other = await createOAuthApplication({ scopes: ["read"] });
      const targetAuthCode = await getAccessToken(target, account, ["read"]);
      const targetClientCredential = await getClientCredentialToken(target, [
        "read",
      ]);
      const otherToken = await getAccessToken(other, account, ["read"]);
      const cookie = await getLoginCookie();

      const response = await app.request(
        `/auth/applications/${target.id}/tokens/delete`,
        {
          method: "POST",
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/auth#authorized-apps");
      expect(await findAccessToken(targetAuthCode.token)).toBeUndefined();
      expect(
        await findAccessToken(targetClientCredential.token),
      ).toBeUndefined();
      expect(await findAccessToken(otherToken.token)).toBeDefined();
    });

    it("revokes the application's pending access grants too", async () => {
      // Otherwise an app holding an unexchanged authorization code could trade
      // it for a fresh token right after the operator revoked everything.
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({ scopes: ["read"] });
      const { code } = await createAccessGrant(
        client.id,
        account.id,
        ["read"],
        "urn:ietf:wg:oauth:2.0:oob",
      );
      expect((await findAccessGrant(code)).revoked).toBeNull();
      const cookie = await getLoginCookie();

      const response = await app.request(
        `/auth/applications/${client.id}/tokens/delete`,
        {
          method: "POST",
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        },
      );

      expect(response.status).toBe(302);
      expect((await findAccessGrant(code)).revoked).not.toBeNull();
    });

    it("stops a pending authorization code from being exchanged afterwards", async () => {
      // The observable half of the ordering inside revokeApplicationAccess:
      // grants are revoked before the tokens are deleted, so an exchange that
      // races the revocation either fails or has its token swept up.
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({
        scopes: ["read"],
        redirectUris: ["urn:ietf:wg:oauth:2.0:oob"],
        confidential: true,
      });
      const application = await getApplication(client);
      const grant = await createAccessGrant(
        application.id,
        account.id,
        ["read"],
        "urn:ietf:wg:oauth:2.0:oob",
      );
      const cookie = await getLoginCookie();

      await app.request(`/auth/applications/${client.id}/tokens/delete`, {
        method: "POST",
        headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
      });

      const body = new FormData();
      body.set("grant_type", "authorization_code");
      body.set("client_id", application.clientId);
      body.set("client_secret", application.clientSecret);
      body.set("redirect_uri", "urn:ietf:wg:oauth:2.0:oob");
      body.set("code", grant.code);
      const exchange = await rootApp.request("/oauth/token", {
        method: "POST",
        body,
      });

      expect(exchange.status).toBe(400);
      expect(((await exchange.json()) as { error: string }).error).toBe(
        "invalid_grant",
      );
    });

    it("responds 404 when the id is not a UUID", async () => {
      await seedCredential();
      const cookie = await getLoginCookie();

      const response = await app.request(
        "/auth/applications/not-a-uuid/tokens/delete",
        {
          method: "POST",
          headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        },
      );

      expect(response.status).toBe(404);
    });

    it("requires a login session", async () => {
      await seedCredential();
      const account = await createAccount();
      const client = await createOAuthApplication({ scopes: ["read"] });
      const accessToken = await getAccessToken(client, account, ["read"]);

      const response = await app.request(
        `/auth/applications/${client.id}/tokens/delete`,
        { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toMatch(/^\/login\?next=/);
      expect(await findAccessToken(accessToken.token)).toBeDefined();
    });
  });
});
