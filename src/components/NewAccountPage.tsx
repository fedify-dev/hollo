import type { PostVisibility, ThemeColor } from "../schema.ts";
import { AccountForm } from "./AccountForm.tsx";
import { DashboardLayout } from "./DashboardLayout.tsx";

export interface NewAccountPageProps {
  values?: {
    username?: string;
    name?: string;
    bio?: string;
    protected?: boolean;
    discoverable?: boolean;
    expandSpoilers?: boolean;
    language?: string;
    visibility?: PostVisibility;
    themeColor?: ThemeColor;
    news?: boolean;
  };
  errors?: {
    username?: string;
    name?: string;
    bio?: string;
  };
  officialAccount: string;
  host: string;
}

export function NewAccountPage(props: NewAccountPageProps) {
  return (
    <DashboardLayout title="Hollo: New account" selectedMenu="accounts">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Create a new account
        </h1>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Fill out the form below to add another account to this Hollo instance.
        </p>
      </header>
      <AccountForm
        action="/accounts"
        values={props.values}
        errors={props.errors}
        submitLabel="Create account"
        officialAccount={props.officialAccount}
        host={props.host}
      />
    </DashboardLayout>
  );
}
