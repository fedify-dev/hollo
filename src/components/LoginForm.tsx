export interface LoginFormProps {
  method?: "get" | "post" | "dialog";
  action: string;
  next?: string;
  values?: {
    email?: string;
  };
  errors?: {
    email?: string;
    password?: string;
  };
}

const fieldClass =
  "w-full rounded-md border bg-white px-3 py-2 text-neutral-900 shadow-sm transition-colors placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-brand-900";
const fieldValid = "border-neutral-300 dark:border-neutral-700";
const fieldInvalid = "border-red-500 dark:border-red-500";
const labelClass =
  "block text-sm font-medium text-neutral-800 dark:text-neutral-200";
const errorClass = "mt-1 text-xs text-red-600 dark:text-red-400";
const submitClass =
  "w-full rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-900";

export function LoginForm(props: LoginFormProps) {
  const emailInvalid = props.errors?.email != null;
  const passwordInvalid = props.errors?.password != null;
  return (
    <form
      method={props.method ?? "post"}
      action={props.action}
      class="space-y-4"
    >
      <div>
        <label for="login-email" class={labelClass}>
          Email
        </label>
        <input
          id="login-email"
          type="email"
          name="email"
          required={true}
          placeholder="john@example.com"
          value={props.values?.email}
          aria-invalid={emailInvalid ? "true" : undefined}
          class={`${fieldClass} ${emailInvalid ? fieldInvalid : fieldValid} mt-1`}
        />
        {props.errors?.email && <p class={errorClass}>{props.errors.email}</p>}
      </div>
      <div>
        <label for="login-password" class={labelClass}>
          Password
        </label>
        <input
          id="login-password"
          type="password"
          name="password"
          required={true}
          minLength={6}
          aria-invalid={passwordInvalid ? "true" : undefined}
          class={`${fieldClass} ${passwordInvalid ? fieldInvalid : fieldValid} mt-1`}
        />
        {props.errors?.password && (
          <p class={errorClass}>{props.errors.password}</p>
        )}
      </div>
      {props.next && <input type="hidden" name="next" value={props.next} />}
      <button type="submit" class={submitClass}>
        Sign in
      </button>
    </form>
  );
}
