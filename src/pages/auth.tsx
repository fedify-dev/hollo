import { zValidator } from "@hono/zod-validator";
import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { HOTP, Secret, TOTP, URI } from "otpauth";
import { toDataURL } from "qrcode";
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
      <hgroup>
        <h1>Auth</h1>
        <p>Authentication settings.</p>
      </hgroup>

      <article>
        <header>
          <hgroup>
            <h2>Two-factor authentication (OTP)</h2>
            <p>
              Configure two-factor authentication to secure your account. You
              need an authenticator app like Google Authenticator or Authy to
              use this feature.
            </p>
          </hgroup>
        </header>
        {totp == null ? (
          tfa == null ? (
            <>
              <p>Two-factor authentication is not enabled.</p>
              <a role="button" href="?open=2fa">
                Enable
              </a>
            </>
          ) : (
            <>
              <p>Scan the QR code below with your authenticator app:</p>
              <p style="text-align: center">
                <img src={await qrCode(tfa.totp.toString())} alt="" />
              </p>
              <details>
                <summary>
                  Can't scan the QR code? Click here to copy the URL to your
                  authenticator app.
                </summary>
                <input type="text" value={tfa.totp.toString()} readonly />
              </details>
              <form method="post" action="/auth/2fa">
                <p>Enter the code from your authenticator app to verify:</p>
                <fieldset role="group">
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
                  />
                  <button type="submit">Verify</button>
                </fieldset>
                {tfa.error && <small>{tfa.error}</small>}
              </form>
            </>
          )
        ) : (
          <>
            <p>Two-factor authentication is enabled.</p>
            <form
              method="post"
              action="/auth/2fa/disable"
              onsubmit="return window.confirm('Are you sure you want to disable two-factor authentication? This will remove the two-factor authentication from your account.');"
            >
              <button type="submit" class="secondary">
                Disable
              </button>
            </form>
          </>
        )}
      </article>
    </DashboardLayout>
  );
}

function qrCode(data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    toDataURL(data, (err, url) => {
      if (err != null) return reject(err);
      resolve(url);
    });
  });
}

export default auth;
