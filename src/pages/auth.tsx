import { zValidator } from "@hono/zod-validator";
import { getLogger } from "@logtape/logtape";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import type { HOTP, TOTP } from "otpauth";
import { z } from "zod";

import { DashboardLayout } from "../components/DashboardLayout";
import db from "../db";
import { SECRET_KEY } from "../env";
import { loginRequired } from "../login";
import { revokeAccessToken, revokeApplicationAccess } from "../oauth/helpers";
import {
  buildRegistrationOptions,
  encodePublicKey,
  getRpInfo,
  nicknameFromUserAgent,
  verifyRegistration,
} from "../passkey";
import {
  accessTokens,
  accounts,
  applications,
  type GrantType,
  type Passkey,
  passkeys,
  type Scope,
  type Totp,
  totps,
} from "../schema";
import { isUuid, type Uuid } from "../uuid";

const logger = getLogger(["hollo", "pages", "auth"]);

const PASSKEY_REG_COOKIE = "passkey_reg";
const PASSKEY_REG_MAX_AGE_SECONDS = 5 * 60;

const auth = new Hono();

auth.use(csrf());
auth.use(loginRequired);

/**
 * The number of applications listed on one page of the authorized applications
 * section, and the number of individual tokens shown under each of them.
 *
 * Both caps matter: `POST /api/v1/apps` needs no authentication and access
 * tokens never expire, so anyone can register unlimited applications and mint
 * unlimited `client_credentials` tokens.  An unbounded listing would make this
 * page slowest exactly when the operator needs it to revoke those tokens.
 */
const APPLICATIONS_PER_PAGE = 20;
const TOKENS_PER_APPLICATION = 10;

/**
 * How many of the most recently issued tokens the per-application grouping
 * looks at.
 *
 * Capping the rendered output is not enough on its own: an unbounded
 * `GROUP BY application_id` reads every row before its `LIMIT` applies, so a
 * flooded `access_tokens` table would make this page slowest exactly when it is
 * needed to clean the table up.  Grouping over a bounded window instead keeps
 * the work constant.  Any realistic instance holds far fewer tokens than this,
 * in which case the window covers everything and the figures are exact; when it
 * does not, the page says so.
 */
const TOKEN_SCAN_LIMIT = 10_000;

/**
 * Caps on the attacker-supplied strings this section renders.
 *
 * `POST /api/v1/apps` needs no authentication and bounds neither the `website`
 * it stores nor the number of scopes a token may repeat, and `/oauth/token`
 * does not deduplicate the scopes it records.  Rendering those values verbatim
 * would let anyone inflate the operator's revocation page at will, so the
 * page bounds them on the way out.
 */
const MAX_WEBSITE_LENGTH = 2048;
const MAX_WEBSITE_DISPLAY_LENGTH = 96;
const MAX_SCOPES_SHOWN = 12;

/**
 * How far the per-application token count will go before reporting "more
 * than this many".  Counting exactly would be unbounded again; counting one
 * past the cap keeps the work per application constant while staying exact for
 * any plausible instance.
 */
const MAX_COUNTED_TOKENS = 1000;

/**
 * The last page that can hold anything: the scan window yields at most
 * {@link TOKEN_SCAN_LIMIT} applications, one per token.
 */
const MAX_PAGE = Math.ceil(TOKEN_SCAN_LIMIT / APPLICATIONS_PER_PAGE);

interface AuthorizedToken {
  id: Uuid;
  grantType: GrantType;
  /** Distinct scopes, capped at {@link MAX_SCOPES_SHOWN}. */
  scopes: Scope[];
  /** How many distinct scopes the cap left out. */
  extraScopes: number;
  created: Date;
  ownerHandle: string | null;
}

/** Just the application columns this page renders. */
interface AuthorizedApplication {
  id: Uuid;
  name: string;
  website: string | null;
}

interface AuthorizedApp {
  application: AuthorizedApplication;
  /** The newest {@link TOKENS_PER_APPLICATION} tokens, newest first. */
  tokens: AuthorizedToken[];
  /**
   * How many tokens the application holds, counted over the same population
   * {@link AuthorizedApp.tokens} is drawn from, and capped at
   * {@link MAX_COUNTED_TOKENS}.
   */
  tokenCount: number;
  /** Whether {@link AuthorizedApp.tokenCount} hit that cap. */
  tokenCountCapped: boolean;
}

interface AuthorizedApps {
  apps: AuthorizedApp[];
  page: number;
  hasNext: boolean;
  /**
   * Whether there are more tokens than {@link TOKEN_SCAN_LIMIT}, so the listing
   * and its counts cover only the most recently issued ones.
   */
  truncated: boolean;
}

/**
 * Loads one page of the applications holding an OAuth access token, together
 * with each application's newest tokens.
 *
 * Tokens are deliberately not filtered by account owner: `/auth` is the
 * instance operator's surface, and `client_credentials` tokens have no account
 * owner at all, so filtering would leave a whole class of credential with no
 * revocation UI.  The bearer codes are never selected; the page addresses
 * tokens by their surrogate id so a live credential cannot reach the markup.
 */
async function loadAuthorizedApps(page: number): Promise<AuthorizedApps> {
  // Reading one row past the window is enough to tell whether it covers every
  // token, and costs a constant amount of work either way.
  const probe = await db.select({ scanned: count() }).from(
    db
      .select({ created: accessTokens.created })
      .from(accessTokens)
      .limit(TOKEN_SCAN_LIMIT + 1)
      .as("probe"),
  );
  const truncated = probe[0].scanned > TOKEN_SCAN_LIMIT;

  const recent = db.$with("recent_tokens").as(
    db
      .select({
        applicationId: accessTokens.applicationId,
        created: accessTokens.created,
      })
      .from(accessTokens)
      // The id breaks ties here too.  Tokens sharing the cutoff timestamp would
      // otherwise be picked arbitrarily, so an application could appear on one
      // request and vanish on the next without anything having changed.
      .orderBy(desc(accessTokens.created), desc(accessTokens.id))
      .limit(TOKEN_SCAN_LIMIT),
  );
  // One row per application, ordered by its most recently issued token.  The
  // application id breaks ties: without it two applications whose newest tokens
  // share a timestamp have no defined order, and since each page is a separate
  // OFFSET query they could swap between requests and duplicate or skip an
  // application.  Asking for one more than fits tells us whether a next page
  // exists.
  const groups = await db
    .with(recent)
    .select({
      applicationId: recent.applicationId,
      latest: max(recent.created),
    })
    .from(recent)
    .groupBy(recent.applicationId)
    .orderBy(desc(max(recent.created)), desc(recent.applicationId))
    .limit(APPLICATIONS_PER_PAGE + 1)
    .offset(page * APPLICATIONS_PER_PAGE);
  const hasNext = groups.length > APPLICATIONS_PER_PAGE;
  const visible = hasNext ? groups.slice(0, APPLICATIONS_PER_PAGE) : groups;
  if (visible.length === 0) {
    return { apps: [], page, hasNext: false, truncated };
  }

  const applicationIds = visible.map((group) => group.applicationId);
  // Only the rendered columns.  Skipping `redirectUris` keeps another unbounded
  // attacker-supplied field out of this request entirely, and there is no
  // reason to pull `clientSecret` into the page's memory.
  const applicationRows = await db
    .select({
      id: applications.id,
      name: applications.name,
      // Truncated in the database: `website` is an unbounded column any
      // unauthenticated caller can write, and reading megabytes of it back
      // just to reject it below would defeat the check.  One character past
      // the cap is enough for `safeHttpUrl()` to tell it was too long.
      website: sql<
        string | null
      >`left(${applications.website}, ${MAX_WEBSITE_LENGTH + 1})`.as("website"),
    })
    .from(applications)
    .where(inArray(applications.id, applicationIds));
  const applicationsById = new Map(
    applicationRows.map((application) => [application.id, application]),
  );

  // The newest tokens per application, in one round trip.  The LIMIT lives
  // inside a LATERAL subquery so it applies per application: with the
  // `(application_id, created)` index each side is a backward index scan that
  // stops after TOKENS_PER_APPLICATION rows.  Ranking the applications' tokens
  // with a window function instead would read every row they own first, which
  // one flooded application is enough to make arbitrarily expensive.
  const newestTokens = db
    .select({
      id: accessTokens.id,
      grantType: accessTokens.grant_type,
      // Deduplicated in the database rather than here.  Tokens issued before
      // `scopesSchema` started deduplicating may hold the same scope hundreds
      // of thousands of times, and decoding those arrays into this process is
      // the memory blowup the caps below are meant to prevent; collapsing them
      // first bounds what crosses the wire to the scope enum's size.
      scopes: sql<
        Scope[]
      >`(SELECT array_agg(s::text ORDER BY s::text) FROM (SELECT DISTINCT unnest(${accessTokens.scopes}) AS s) d)::text[]`.as(
        "scopes",
      ),
      created: accessTokens.created,
      ownerHandle: accounts.handle,
    })
    .from(accessTokens)
    .leftJoin(accounts, eq(accounts.id, accessTokens.accountOwnerId))
    .where(eq(accessTokens.applicationId, applications.id))
    // The id breaks ties: tokens issued in the same instant would otherwise
    // have no defined order, leaving it undefined which of them this cap keeps.
    .orderBy(desc(accessTokens.created), desc(accessTokens.id))
    .limit(TOKENS_PER_APPLICATION)
    .as("newest_tokens");
  const tokenRows = await db
    .select({
      applicationId: applications.id,
      id: newestTokens.id,
      grantType: newestTokens.grantType,
      scopes: newestTokens.scopes,
      created: newestTokens.created,
      ownerHandle: newestTokens.ownerHandle,
    })
    .from(applications)
    .crossJoinLateral(newestTokens)
    .where(inArray(applications.id, applicationIds))
    .orderBy(desc(newestTokens.created), desc(newestTokens.id));

  // Per-application counts over the whole table, the same population the
  // lateral above draws from, so a count can never come out lower than the
  // number of rows rendered beneath it.  The inner LIMIT keeps each one to a
  // constant number of index entries.
  const countedTokens = db
    .select({ id: accessTokens.id })
    .from(accessTokens)
    .where(eq(accessTokens.applicationId, applications.id))
    .limit(MAX_COUNTED_TOKENS + 1)
    .as("counted_tokens");
  const countRows = await db
    .select({
      applicationId: applications.id,
      tokenCount: count(countedTokens.id),
    })
    .from(applications)
    .crossJoinLateral(countedTokens)
    .where(inArray(applications.id, applicationIds))
    .groupBy(applications.id);
  const countByApplication = new Map(
    countRows.map((row) => [row.applicationId, row.tokenCount]),
  );

  const tokensByApplication = new Map<Uuid, AuthorizedToken[]>();
  for (const row of tokenRows) {
    const tokens = tokensByApplication.get(row.applicationId) ?? [];
    // Already distinct and bounded by the query above.
    const scopes = row.scopes ?? [];
    tokens.push({
      id: row.id,
      grantType: row.grantType,
      scopes: scopes.slice(0, MAX_SCOPES_SHOWN),
      extraScopes: Math.max(0, scopes.length - MAX_SCOPES_SHOWN),
      created: row.created,
      ownerHandle: row.ownerHandle,
    });
    tokensByApplication.set(row.applicationId, tokens);
  }

  const apps: AuthorizedApp[] = [];
  for (const group of visible) {
    const application = applicationsById.get(group.applicationId);
    // The application row is deleted only by cascade, which takes its tokens
    // with it, so this can only lose a race with a concurrent deletion.
    if (application == null) continue;
    const counted = countByApplication.get(group.applicationId) ?? 0;
    apps.push({
      application,
      tokens: tokensByApplication.get(group.applicationId) ?? [],
      tokenCount: Math.min(counted, MAX_COUNTED_TOKENS),
      tokenCountCapped: counted > MAX_COUNTED_TOKENS,
    });
  }
  return { apps, page, hasNext, truncated };
}

auth.get("/", async (c) => {
  const totp = await db.query.totps.findFirst();
  const passkeysList = await db.query.passkeys.findMany({
    orderBy: (p, { desc }) => [desc(p.created)],
  });
  const authorizedApps = await loadAuthorizedApps(
    parsePage(c.req.query("apps")),
  );
  const open = c.req.query("open");
  if (totp == null && open === "2fa") {
    const credential = await db.query.credentials.findFirst();
    if (credential == null) return c.redirect("/setup");
    const { Secret, TOTP } = await import("otpauth");
    const totp = new TOTP({
      issuer: "Hollo",
      label: credential.email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: new Secret({ size: 20 }),
    });
    logger.debug("The TOTP token: {token}", { token: totp.generate() });
    return c.html(
      <AuthPage
        tfa={{ totp }}
        passkeys={passkeysList}
        authorizedApps={authorizedApps}
      />,
    );
  }
  return c.html(
    <AuthPage
      totp={totp}
      passkeys={passkeysList}
      authorizedApps={authorizedApps}
    />,
  );
});

auth.post(
  "/2fa",
  zValidator(
    "form",
    z.object({ totp: z.url(), token: z.string().regex(/^\d+$/) }),
  ),
  async (c) => {
    const form = c.req.valid("form");
    const { HOTP, URI } = await import("otpauth");
    const totp = URI.parse(form.totp);
    const passkeysList = await db.query.passkeys.findMany({
      orderBy: (p, { desc }) => [desc(p.created)],
    });
    const authorizedApps = await loadAuthorizedApps(0);
    if (totp instanceof HOTP) {
      return c.html(
        <AuthPage
          tfa={{ totp, error: "HOTP is not supported." }}
          passkeys={passkeysList}
          authorizedApps={authorizedApps}
        />,
      );
    }
    const validated = totp.validate({
      token: form.token,
      window: 2,
    });
    if (validated == null) {
      return c.html(
        <AuthPage
          tfa={{ totp, error: "The code you entered is invalid." }}
          passkeys={passkeysList}
          authorizedApps={authorizedApps}
        />,
      );
    }
    await db.insert(totps).values({
      ...totp,
      secret: totp.secret.base32,
    });
    return c.redirect("/auth");
  },
);

auth.post("/2fa/disable", async (c) => {
  await db.delete(totps);
  return c.redirect("/auth");
});

auth.post("/passkeys/registration/begin", async (c) => {
  const login = await getSignedCookie(c, SECRET_KEY, "login");
  // loginRequired ran already, but TypeScript can't narrow that, and the
  // double check costs nothing.
  if (login == null || login === false) {
    return c.redirect(`/login?next=${encodeURIComponent(c.req.url)}`);
  }
  const credential = await db.query.credentials.findFirst();
  if (credential == null) return c.redirect("/setup");
  const enrolled = await db.query.passkeys.findMany({
    columns: { id: true, transports: true },
  });
  const rpInfo = getRpInfo(c.req.url);
  const { options, challenge } = await buildRegistrationOptions({
    rpInfo,
    email: credential.email,
    existingCredentials: enrolled.map((p) => ({
      id: p.id,
      transports: p.transports as AuthenticatorTransportFuture[],
    })),
  });
  const expiresAt = Date.now() + PASSKEY_REG_MAX_AGE_SECONDS * 1000;
  // The signed cookie binds the challenge to (a) the current login
  // session and (b) a server-enforced expiry, so a captured cookie
  // can't be replayed after logout or after the TTL even though
  // Max-Age is only a browser hint.  The pipe character is not part
  // of base64url (the challenge encoding), so it's safe as a
  // separator.
  const value = `${challenge}|${expiresAt.toString()}|${login}`;
  await setSignedCookie(c, PASSKEY_REG_COOKIE, value, SECRET_KEY, {
    httpOnly: true,
    secure: rpInfo.origin.startsWith("https://"),
    sameSite: "Strict",
    path: "/auth/passkeys",
    maxAge: PASSKEY_REG_MAX_AGE_SECONDS,
  });
  return c.json(options);
});

const finishBodySchema = z.object({
  nickname: z.string().trim().max(80).optional(),
  registrationResponse: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.literal("public-key"),
    clientExtensionResults: z.record(z.string(), z.unknown()),
    authenticatorAttachment: z.string().optional(),
    response: z.object({
      clientDataJSON: z.string(),
      attestationObject: z.string(),
      authenticatorData: z.string().optional(),
      publicKey: z.string().optional(),
      publicKeyAlgorithm: z.number().optional(),
      transports: z.array(z.string()).optional(),
    }),
  }),
});

auth.post("/passkeys/registration/finish", async (c) => {
  const login = await getSignedCookie(c, SECRET_KEY, "login");
  if (login == null || login === false) {
    return c.redirect(`/login?next=${encodeURIComponent(c.req.url)}`);
  }
  // Consume the registration challenge cookie up front, before any body
  // parsing or schema validation, so a malformed first request still
  // burns the cookie.  Otherwise zValidator would short-circuit on a bad
  // payload and leave passkey_reg replayable until its TTL.
  const cookieValue = await getSignedCookie(c, SECRET_KEY, PASSKEY_REG_COOKIE);
  deleteCookie(c, PASSKEY_REG_COOKIE, { path: "/auth/passkeys" });
  if (cookieValue == null || cookieValue === false) {
    return c.json({ error: "Missing or invalid challenge cookie." }, 400);
  }
  const parts = cookieValue.split("|");
  if (parts.length !== 3) {
    return c.json({ error: "Malformed challenge cookie." }, 400);
  }
  const [challenge, expiresAtStr, boundLogin] = parts;
  const expiresAt = Number.parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return c.json({ error: "Challenge has expired." }, 400);
  }
  if (boundLogin !== login) {
    return c.json(
      { error: "Challenge is bound to a different login session." },
      400,
    );
  }
  const credential = await db.query.credentials.findFirst();
  if (credential == null) return c.redirect("/setup");

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const parsed = finishBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body." }, 400);
  }
  const body = parsed.data;
  const rpInfo = getRpInfo(c.req.url);
  const verified = await verifyRegistration({
    rpInfo,
    // SimpleWebAuthn validates the inner shape; the Zod schema above
    // just rejects obviously wrong payloads.
    // oxlint-disable-next-line typescript/no-explicit-any
    response: body.registrationResponse as any,
    expectedChallenge: challenge,
  });
  if (verified == null) {
    return c.json({ error: "Registration could not be verified." }, 400);
  }
  // body.nickname has already been .trim()'d by finishBodySchema, so it's
  // either a non-empty trimmed string, an empty string, or undefined.
  const nickname =
    body.nickname != null && body.nickname !== ""
      ? body.nickname
      : nicknameFromUserAgent(c.req.header("user-agent"));
  const inserted = await db
    .insert(passkeys)
    .values({
      id: verified.credentialId,
      credentialEmail: credential.email,
      publicKey: encodePublicKey(verified.publicKey),
      counter: verified.counter,
      transports: verified.transports,
      deviceType: verified.deviceType,
      backedUp: verified.backedUp,
      nickname,
    })
    .onConflictDoNothing()
    .returning({ id: passkeys.id });
  if (inserted.length === 0) {
    return c.json(
      { error: "This passkey is already enrolled on this account." },
      409,
    );
  }
  return c.body(null, 204);
});

auth.post("/passkeys/:id/delete", async (c) => {
  const id = c.req.param("id");
  await db.delete(passkeys).where(eq(passkeys.id, id));
  return c.redirect("/auth");
});

auth.post("/tokens/:id/delete", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.notFound();
  await revokeAccessToken(id);
  return c.redirect("/auth#authorized-apps");
});

auth.post("/applications/:id/tokens/delete", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.notFound();
  await revokeApplicationAccess(id);
  return c.redirect("/auth#authorized-apps");
});

interface AuthPageProps {
  totp?: Totp;
  tfa?: {
    totp: TOTP | HOTP;
    error?: string;
  };
  passkeys: Passkey[];
  authorizedApps: AuthorizedApps;
}

async function AuthPage({
  totp,
  tfa,
  passkeys,
  authorizedApps,
}: AuthPageProps) {
  const tokenTotal = authorizedApps.apps.reduce(
    (total, app) => total + app.tokenCount,
    0,
  );
  const tokenTotalCapped = authorizedApps.apps.some(
    (app) => app.tokenCountCapped,
  );
  return (
    <DashboardLayout title="Hollo: Auth" selectedMenu="auth">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Authentication
        </h1>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Manage how you sign in to this Hollo instance.
        </p>
      </header>

      <section class="rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
        <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Two-factor authentication (TOTP)
            </h2>
            <p class="mt-1 max-w-xl text-sm text-neutral-600 dark:text-neutral-400">
              Secure sign-in with a one-time code from an authenticator app like
              Google Authenticator or Authy.
            </p>
          </div>
          <span
            class={
              totp == null
                ? "inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                : "inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-950 dark:text-green-300"
            }
          >
            <span
              class={
                totp == null
                  ? "size-1.5 rounded-full bg-neutral-400"
                  : "size-1.5 rounded-full bg-green-500"
              }
              aria-hidden="true"
            />
            {totp == null ? "Disabled" : "Enabled"}
          </span>
        </header>
        {totp == null ? (
          tfa == null ? (
            <a
              href="?open=2fa"
              class="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
            >
              Enable two-factor authentication
            </a>
          ) : (
            <div class="space-y-4">
              <div class="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
                <div class="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
                  <img
                    src={await qrCode(tfa.totp.toString())}
                    alt="QR code for two-factor setup"
                    class="block size-40"
                  />
                </div>
                <div class="text-sm text-neutral-700 dark:text-neutral-300">
                  <p>Scan the QR code with your authenticator app.</p>
                  <details class="mt-3">
                    <summary class="cursor-pointer text-brand-700 hover:underline dark:text-brand-400">
                      Can't scan? Copy the setup URL instead.
                    </summary>
                    <input
                      type="text"
                      value={tfa.totp.toString()}
                      readonly
                      aria-label="TOTP setup URL"
                      class="mt-2 w-full rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 font-mono text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                    />
                  </details>
                </div>
              </div>
              <form method="post" action="/auth/2fa" class="space-y-2">
                <p class="text-sm text-neutral-700 dark:text-neutral-300">
                  Enter the six-digit code to confirm setup:
                </p>
                <div class="flex gap-2">
                  <input
                    type="hidden"
                    name="totp"
                    value={tfa.totp.toString()}
                  />
                  <input
                    type="text"
                    name="token"
                    inputmode="numeric"
                    pattern="^[0-9]+$"
                    required
                    placeholder="123456"
                    aria-label="Six-digit authentication code"
                    aria-invalid={tfa.error == null ? undefined : "true"}
                    class={`flex-1 rounded-md border bg-white px-3 py-2 text-center font-mono text-lg tracking-widest text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-brand-900 ${
                      tfa.error == null
                        ? "border-neutral-300 dark:border-neutral-700"
                        : "border-red-500 dark:border-red-500"
                    }`}
                  />
                  <button
                    type="submit"
                    class="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
                  >
                    Verify
                  </button>
                </div>
                {tfa.error && (
                  <p class="text-xs text-red-600 dark:text-red-400">
                    {tfa.error}
                  </p>
                )}
              </form>
            </div>
          )
        ) : (
          <form
            method="post"
            action="/auth/2fa/disable"
            onsubmit="return window.confirm('Are you sure you want to disable two-factor authentication? This will remove the two-factor authentication from your account.');"
          >
            <button
              type="submit"
              class="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-900 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950"
            >
              Disable two-factor authentication
            </button>
          </form>
        )}
      </section>

      <section class="mt-6 rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
        <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Passkeys
            </h2>
            <p class="mt-1 max-w-xl text-sm text-neutral-600 dark:text-neutral-400">
              Sign in without a password using a device-bound key plus a
              biometric or PIN. A passkey on its own counts as multi-factor
              authentication, so the TOTP step is skipped.
            </p>
          </div>
          <span
            class={
              passkeys.length === 0
                ? "inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                : "inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-950 dark:text-green-300"
            }
          >
            <span
              class={
                passkeys.length === 0
                  ? "size-1.5 rounded-full bg-neutral-400"
                  : "size-1.5 rounded-full bg-green-500"
              }
              aria-hidden="true"
            />
            {passkeys.length === 0
              ? "None enrolled"
              : `${passkeys.length.toString()} enrolled`}
          </span>
        </header>

        {passkeys.length === 0 ? (
          <p class="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
            No passkeys are enrolled yet. Enrolling one lets you sign in from
            this browser without typing your password.
          </p>
        ) : (
          <ul class="mb-4 divide-y divide-neutral-200 dark:divide-neutral-800">
            {passkeys.map((p) => (
              <li class="flex flex-wrap items-center justify-between gap-3 py-3">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {p.nickname}
                  </p>
                  <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    Added{" "}
                    <time dateTime={p.created.toISOString()}>
                      {formatDate(p.created)}
                    </time>
                    {p.lastUsed != null ? (
                      <>
                        {" · last used "}
                        <time dateTime={p.lastUsed.toISOString()}>
                          {formatDate(p.lastUsed)}
                        </time>
                      </>
                    ) : (
                      " · never used"
                    )}
                  </p>
                </div>
                <form
                  method="post"
                  action={`/auth/passkeys/${encodeURIComponent(p.id)}/delete`}
                  class="m-0"
                  onsubmit="return window.confirm('Remove this passkey?  You will not be able to sign in with it after this.');"
                >
                  <button
                    type="submit"
                    class="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-900 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950"
                  >
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <form id="passkey-enroll-form" class="space-y-3">
          <label
            class="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
            htmlFor="passkey-nickname"
          >
            Nickname
            <span class="ms-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
              optional
            </span>
          </label>
          <input
            id="passkey-nickname"
            name="nickname"
            type="text"
            maxLength={80}
            placeholder="e.g. iPhone, work laptop, YubiKey"
            aria-label="Nickname"
            class="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-brand-900"
          />
          <div class="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              class="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
            >
              Add passkey
            </button>
            <p
              id="passkey-enroll-status"
              class="text-xs text-neutral-500 dark:text-neutral-400"
              aria-live="polite"
            />
          </div>
        </form>
      </section>

      <section
        id="authorized-apps"
        class="mt-6 rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Authorized applications
            </h2>
            <p class="mt-1 max-w-xl text-sm text-neutral-600 dark:text-neutral-400">
              Apps holding an OAuth access token for this instance. Revoking
              cuts off the tokens listed here immediately. An application that
              still holds its client credentials can request a new app-only
              token at any time, so this clears what an application can reach
              now rather than banning the application itself.
            </p>
          </div>
          <span
            class={
              authorizedApps.apps.length === 0
                ? "inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                : "inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-950 dark:text-green-300"
            }
          >
            <span
              class={
                authorizedApps.apps.length === 0
                  ? "size-1.5 rounded-full bg-neutral-400"
                  : "size-1.5 rounded-full bg-green-500"
              }
              aria-hidden="true"
            />
            {authorizedApps.apps.length === 0
              ? "None authorized"
              : `${authorizedApps.apps.length.toString()} ${
                  authorizedApps.apps.length === 1 ? "app" : "apps"
                } · ${tokenTotalCapped ? "over " : ""}${tokenTotal.toString()} ${
                  tokenTotal === 1 ? "token" : "tokens"
                }`}
          </span>
        </header>

        {authorizedApps.truncated && (
          <p class="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            {`This instance holds more than ${TOKEN_SCAN_LIMIT.toLocaleString()} access tokens, so the list and the counts below cover only the most recently issued ones. Revoking still removes every token it names.`}
          </p>
        )}

        {authorizedApps.apps.length === 0 ? (
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            {authorizedApps.page === 0
              ? "No applications are authorized yet. Apps you sign in to from a Mastodon-compatible client will show up here."
              : "There is nothing on this page. Go back to the first page to see the authorized applications."}
          </p>
        ) : (
          <ul class="divide-y divide-neutral-200 dark:divide-neutral-800">
            {authorizedApps.apps.map((app) => {
              const website = safeHttpUrl(app.application.website);
              return (
                <li class="py-4 first:pt-0 last:pb-0">
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        {app.application.name === ""
                          ? "Unnamed application"
                          : app.application.name}
                      </p>
                      {website != null && (
                        <p class="mt-0.5 truncate text-xs">
                          <a
                            href={website}
                            target="_blank"
                            rel="nofollow noopener noreferrer"
                            class="text-brand-700 hover:underline dark:text-brand-400"
                          >
                            {elideUrl(website)}
                          </a>
                        </p>
                      )}
                    </div>
                    <form
                      method="post"
                      action={`/auth/applications/${encodeURIComponent(
                        app.application.id,
                      )}/tokens/delete`}
                      class="m-0"
                      onsubmit="return window.confirm('Revoke every access token for this application?  It will lose the access those tokens grant immediately.');"
                    >
                      <button
                        type="submit"
                        class="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-900 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950"
                      >
                        <span class="i-lucide-trash-2" aria-hidden="true" />
                        Revoke all
                      </button>
                    </form>
                  </div>

                  <ul class="mt-3 space-y-2">
                    {app.tokens.map((token) => (
                      <li class="flex flex-wrap items-start justify-between gap-3 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
                        <div class="min-w-0 flex-1">
                          <p class="text-xs text-neutral-500 dark:text-neutral-400">
                            Issued{" "}
                            <time dateTime={token.created.toISOString()}>
                              {formatDateTime(token.created)}
                            </time>
                            {token.grantType === "client_credentials"
                              ? " · app-only (client credentials)"
                              : token.ownerHandle != null
                                ? ` · ${token.ownerHandle}`
                                : ""}
                          </p>
                          {token.scopes.length === 0 ? (
                            <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                              No scopes
                            </p>
                          ) : (
                            <ul class="mt-1 flex flex-wrap gap-1">
                              {token.scopes.map((scope) => (
                                <li class="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                                  {scope}
                                </li>
                              ))}
                              {token.extraScopes > 0 && (
                                <li class="px-1.5 py-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                                  {`+${token.extraScopes.toString()} more`}
                                </li>
                              )}
                            </ul>
                          )}
                        </div>
                        <form
                          method="post"
                          action={`/auth/tokens/${encodeURIComponent(
                            token.id,
                          )}/delete`}
                          class="m-0"
                          onsubmit="return window.confirm('Revoke this access token?  Whatever is using it will lose access immediately.');"
                        >
                          <button
                            type="submit"
                            class="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-900 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950"
                          >
                            Revoke
                          </button>
                        </form>
                      </li>
                    ))}
                  </ul>
                  {app.tokenCount > app.tokens.length && (
                    <p class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                      {`Showing the ${app.tokens.length.toString()} most recent of ${
                        app.tokenCountCapped ? "over " : ""
                      }${app.tokenCount.toString()} tokens. Revoke all removes every one of them.`}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {(authorizedApps.page > 0 || authorizedApps.hasNext) && (
          <nav
            class="mt-4 flex items-center justify-between gap-3 border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800"
            aria-label="Authorized applications pages"
          >
            {authorizedApps.page > 0 ? (
              <a
                href={`?apps=${(authorizedApps.page - 1).toString()}#authorized-apps`}
                class="text-brand-700 hover:underline dark:text-brand-400"
              >
                Newer applications
              </a>
            ) : (
              <span />
            )}
            {authorizedApps.hasNext ? (
              <a
                href={`?apps=${(authorizedApps.page + 1).toString()}#authorized-apps`}
                class="text-brand-700 hover:underline dark:text-brand-400"
              >
                Older applications
              </a>
            ) : (
              <span />
            )}
          </nav>
        )}
      </section>

      <script src="/public/simplewebauthn-browser.umd.js" defer />
      <script src="/public/passkey.js" defer />
    </DashboardLayout>
  );
}

function formatDate(value: Date): string {
  // Server-side rendering uses the server's locale, which inside a typical
  // Hollo container is UTC; the wrapping <time dateTime> attribute carries
  // the canonical ISO instant so a browser-side enhancement could re-render
  // it in the visitor's locale.  Same pattern as src/components/AccountList.tsx.
  return value.toLocaleDateString();
}

function formatDateTime(value: Date): string {
  // Access tokens carry no nickname, so the issue time is often the only thing
  // that tells two tokens from the same app apart; the date alone is not
  // enough.  Same server-locale caveat as formatDate() above.
  return value.toLocaleString();
}

/**
 * Returns `value` if it is an `http:` or `https:` URL, and `null` otherwise.
 *
 * An application's website is supplied by whoever registered it through the
 * unauthenticated `POST /api/v1/apps`, which validates it with Zod's `z.url()`.
 * That accepts `javascript:` among others, so linking the raw value here would
 * put an attacker-controlled script URL on the operator's dashboard.
 */
/**
 * Parses the `?apps=` page number, clamping anything odd to the first page.
 *
 * The whole value has to be digits: `Number.parseInt()` alone would read
 * `1junk` as page 1.  Pages past the last one the scan window can produce are
 * clamped too, so a made-up number cannot turn into an enormous OFFSET.
 */
function parsePage(value: string | undefined): number {
  if (value == null || !/^\d+$/.test(value)) return 0;
  const page = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(page) || page < 0) return 0;
  return Math.min(page, MAX_PAGE);
}

function safeHttpUrl(value: string | null): string | null {
  // Anything past MAX_WEBSITE_LENGTH is not a website anyone typed; it is
  // padding aimed at this page, so drop the link rather than render it.
  if (value == null || value === "" || value.length > MAX_WEBSITE_LENGTH) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Shortens a URL for display; the full value stays in the `href`. */
function elideUrl(url: string): string {
  return url.length <= MAX_WEBSITE_DISPLAY_LENGTH
    ? url
    : `${url.slice(0, MAX_WEBSITE_DISPLAY_LENGTH - 1)}\u2026`;
}

function qrCode(data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const run = async () => {
      const { toDataURL } = await import("qrcode");
      toDataURL(data, (err, url) => {
        if (err != null) return reject(err);
        resolve(url);
      });
    };

    run().catch(reject);
  });
}

export default auth;
