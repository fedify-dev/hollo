import { zValidator } from "@hono/zod-validator";
import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import type { HOTP, TOTP } from "otpauth";
import { z } from "zod";

import { DashboardLayout } from "../components/DashboardLayout";
import db from "../db";
import { loginRequired } from "../login";
import { type Totp, totps } from "../schema";

const logger = getLogger(["hollo", "pages", "auth"]);

const auth = new Hono();

auth.use(loginRequired);

auth.get("/", async (c) => {
  const totp = await db.query.totps.findFirst();
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
    return c.html(<AuthPage tfa={{ totp }} />);
  }
  return c.html(<AuthPage totp={totp} />);
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
    if (totp instanceof HOTP) {
      return c.html(
        <AuthPage tfa={{ totp, error: "HOTP is not supported." }} />,
      );
    }
    const validated = totp.validate({
      token: form.token,
      window: 2,
    });
    if (validated == null) {
      return c.html(
        <AuthPage tfa={{ totp, error: "The code you entered is invalid." }} />,
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

interface AuthPageProps {
  totp?: Totp;
  tfa?: {
    totp: TOTP | HOTP;
    error?: string;
  };
}

async function AuthPage({ totp, tfa }: AuthPageProps) {
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
              class="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
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
                    aria-invalid={tfa.error == null ? undefined : "true"}
                    class={`flex-1 rounded-md border bg-white px-3 py-2 text-center font-mono text-lg tracking-widest text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-brand-900 ${
                      tfa.error == null
                        ? "border-neutral-300 dark:border-neutral-700"
                        : "border-red-500 dark:border-red-500"
                    }`}
                  />
                  <button
                    type="submit"
                    class="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
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
    </DashboardLayout>
  );
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
