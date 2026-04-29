import { count } from "drizzle-orm";
import { type Context, Hono } from "hono";

import { AuthCard } from "../../components/AuthCard.tsx";
import { Layout } from "../../components/Layout.tsx";
import { SetupForm } from "../../components/SetupForm.tsx";
import db from "../../db.ts";
import { credentials } from "../../schema.ts";

const setup = new Hono();

function showsProxyWarning(c: Context): boolean {
  const url = new URL(c.req.url);
  return (
    url.protocol === "http:" &&
    url.hostname !== "localhost" &&
    !url.hostname.startsWith("127.") &&
    // oxlint-disable-next-line typescript/dot-notation
    process.env["BEHIND_PROXY"] !== "true"
  );
}

setup.get("/", async (c) => {
  const [{ value: exist }] = await db
    .select({ value: count() })
    .from(credentials);
  if (exist > 0) return c.redirect("/accounts");
  return c.html(<SetupPage proxyWarning={showsProxyWarning(c)} />);
});

setup.post("/", async (c) => {
  const [{ value: exist }] = await db
    .select({ value: count() })
    .from(credentials);
  if (exist > 0) return c.redirect("/accounts");
  const form = await c.req.formData();
  const email = form.get("email")?.toString();
  const password = form.get("password")?.toString();
  const passwordConfirm = form.get("password_confirm")?.toString();
  if (
    email == null ||
    password == null ||
    passwordConfirm == null ||
    password !== passwordConfirm
  ) {
    return c.html(
      <SetupPage
        proxyWarning={showsProxyWarning(c)}
        values={{ email }}
        errors={{
          email: email == null ? "Email is required." : undefined,
          password: password == null ? "Password is required." : undefined,
          passwordConfirm:
            password !== passwordConfirm
              ? "Passwords do not match."
              : undefined,
        }}
      />,
      400,
    );
  }
  const { hash } = await import("argon2");
  await db.insert(credentials).values({
    email,
    passwordHash: await hash(password),
  });
  return c.redirect("/accounts");
});

interface SetupPageProps {
  proxyWarning?: boolean;
  values?: {
    email?: string;
  };
  errors?: {
    email?: string;
    password?: string;
    passwordConfirm?: string;
  };
}

function SetupPage(props: SetupPageProps) {
  return (
    <Layout title="Welcome to Hollo!">
      <AuthCard
        title="Welcome to Hollo!"
        subtitle="It's the first time to use Hollo. Let's set up your account."
      >
        {props.proxyWarning && (
          <div
            role="alert"
            class="mb-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
          >
            <strong class="font-semibold">Warning:</strong> Your Hollo server
            appears to run behind a reverse proxy or L7 load balancer. Set the
            environment variable{" "}
            <a
              href="https://docs.hollo.social/install/env/#behind_proxy-"
              class="underline underline-offset-2 hover:no-underline"
            >
              <code class="font-mono">BEHIND_PROXY</code>
            </a>{" "}
            to <code class="font-mono">true</code> to prevent federation issues.
          </div>
        )}
        <SetupForm
          action="/setup"
          values={props.values}
          errors={props.errors}
        />
      </AuthCard>
    </Layout>
  );
}

export default setup;
