import { SubmitButton } from "./forms";

export interface OtpFormProps {
  method?: "get" | "post" | "dialog";
  action: string;
  next?: string;
  errors?: {
    token?: string;
  };
}

const tokenInputClass =
  "flex-1 rounded-md border bg-white px-3 py-2 text-center font-mono text-lg tracking-widest text-neutral-900 shadow-sm transition-colors placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-brand-900";
const fieldValid = "border-neutral-300 dark:border-neutral-700";
const fieldInvalid = "border-red-500 dark:border-red-500";

export function OtpForm(props: OtpFormProps) {
  const invalid = props.errors?.token != null;
  return (
    <form method={props.method ?? "post"} action={props.action}>
      <label
        for="otp-token"
        class="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
      >
        Authentication code
      </label>
      <div class="mt-1 flex gap-2">
        <input
          id="otp-token"
          type="text"
          name="token"
          inputMode="numeric"
          pattern="^[0-9]+$"
          required
          placeholder="123456"
          autocomplete="one-time-code"
          aria-invalid={invalid ? "true" : undefined}
          class={`${tokenInputClass} ${invalid ? fieldInvalid : fieldValid}`}
        />
        <SubmitButton>Verify</SubmitButton>
      </div>
      {props.errors?.token && (
        <p class="mt-2 text-xs text-red-600 dark:text-red-400">
          {props.errors.token}
        </p>
      )}
      {props.next && <input type="hidden" name="next" value={props.next} />}
    </form>
  );
}
