import { AuthCard } from "../../components/AuthCard";
import { Layout } from "../../components/Layout";
import type { Application } from "../../schema";

interface AuthorizationCodePageProps {
  application: Application;
  code: string;
}

export function AuthorizationCodePage(props: AuthorizationCodePageProps) {
  return (
    <Layout title="Hollo: Authorization code">
      <AuthCard
        title="Authorization code"
        subtitle={`Copy this code and paste it into ${props.application.name}.`}
      >
        <div class="rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
          <code class="block break-all font-mono text-sm text-neutral-900 dark:text-neutral-100">
            {props.code}
          </code>
        </div>
      </AuthCard>
    </Layout>
  );
}
