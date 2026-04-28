import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { z } from "zod";

import { AuthCard } from "../components/AuthCard.tsx";
import { Layout } from "../components/Layout.tsx";
import { LoginForm } from "../components/LoginForm.tsx";
import { OtpForm } from "../components/OtpForm.tsx";
import { db } from "../db.ts";
import { credentials } from "../schema.ts";

// oxlint-disable-next-line typescript/dot-notation
const SECRET_KEY = process.env["SECRET_KEY"];
if (SECRET_KEY == null) throw new Error("SECRET_KEY is required");

const login = new Hono();

login.get("/", (c) => {
  const next = c.req.query("next");
  return c.html(<LoginPage next={next} />);
});

login.post("/", async (c) => {
  const form = await c.req.formData();
  const email = form.get("email")?.toString();
  const password = form.get("password")?.toString();
  const next = form.get("next")?.toString();
  if (email == null || password == null) {
    return c.html(
      <LoginPage
        next={next}
        values={{ email }}
        errors={{
          email: email == null ? "Email is required." : undefined,
          password: password == null ? "Password is required." : undefined,
        }}
      />,
      400,
    );
  }
  const credential = await db.query.credentials.findFirst({
    where: eq(credentials.email, email),
  });
  const { verify } = await import("argon2");
  if (
    credential == null ||
    !(await verify(credential.passwordHash, password))
  ) {
    return c.html(
      <LoginPage
        next={next}
        values={{ email }}
        errors={{
          email: "Invalid email or password.",
          password: "Invalid email or password.",
        }}
      />,
      400,
    );
  }
  await setSignedCookie(c, "login", new Date().toISOString(), SECRET_KEY);
  return c.redirect(next ?? "/");
});

interface LoginPageProps {
  next?: string;
  values?: {
    email?: string;
  };
  errors?: {
    email?: string;
    password?: string;
  };
}

function LoginPage(props: LoginPageProps) {
  return (
    <Layout title="Sign in to Hollo">
      <AuthCard
        title="Sign in to Hollo"
        subtitle="To continue, sign in with your Hollo account."
      >
        <LoginForm
          action="/login"
          next={props.next}
          values={props.values}
          errors={props.errors}
        />
      </AuthCard>
    </Layout>
  );
}

login.get(
  "/otp",
  zValidator(
    "query",
    z.object({
      next: z.url().optional(),
    }),
  ),
  (c) => {
    const query = c.req.valid("query");
    return c.html(<OtpPage next={query.next} />);
  },
);

login.post(
  "/otp",
  zValidator(
    "form",
    z.object({
      token: z.string().regex(/^\d+$/),
      next: z.url().optional(),
    }),
  ),
  async (c) => {
    const form = c.req.valid("form");
    const login = await getSignedCookie(c, SECRET_KEY, "login");
    if (login == null || login === false) {
      return c.redirect(`/login?next=${encodeURIComponent(form.next ?? "/")}`);
    }
    const totp = await db.query.totps.findFirst();
    if (totp == null) return c.redirect(form.next ?? "/");
    const { TOTP } = await import("otpauth");
    const totpInstance = new TOTP(totp);
    const valid = totpInstance.validate({
      token: form.token,
      window: 2,
    });
    if (valid == null) {
      return c.html(
        <OtpPage next={form.next} errors={{ token: "Invalid token." }} />,
      );
    }
    await setSignedCookie(c, "otp", `${login} totp`, SECRET_KEY);
    return c.redirect(form.next ?? "/");
  },
);

interface OtpPageProps {
  next?: string;
  errors?: {
    token?: string;
  };
}

function OtpPage(props: OtpPageProps) {
  return (
    <Layout title="Sign in to Hollo">
      <AuthCard
        title="Two-factor authentication"
        subtitle="Enter the six-digit code from your authenticator app."
      >
        <OtpForm action="/login/otp" next={props.next} errors={props.errors} />
      </AuthCard>
    </Layout>
  );
}

export default login;
