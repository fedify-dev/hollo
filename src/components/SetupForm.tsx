import { SubmitButton, TextField } from "./forms";

export interface SetupFormProps {
  method?: "get" | "post" | "dialog";
  action: string;
  values?: {
    email?: string;
  };
  errors?: {
    email?: string;
    password?: string;
    passwordConfirm?: string;
  };
}

export function SetupForm(props: SetupFormProps) {
  return (
    <form
      method={props.method ?? "post"}
      action={props.action}
      class="space-y-4"
    >
      <TextField
        id="setup-email"
        name="email"
        type="email"
        label="Email"
        placeholder="john@example.com"
        required={true}
        value={props.values?.email}
        hint="Your email address will be used to sign in to Hollo."
        error={props.errors?.email}
      />
      <div class="grid gap-4 sm:grid-cols-2">
        <TextField
          id="setup-password"
          name="password"
          type="password"
          label="Password"
          required={true}
          minLength={6}
          hint="Must be at least 6 characters long."
          error={props.errors?.password}
        />
        <TextField
          id="setup-password-confirm"
          name="password_confirm"
          type="password"
          label="Password (again)"
          required={true}
          minLength={6}
          hint="Enter the same password again for confirmation."
          error={props.errors?.passwordConfirm}
        />
      </div>
      <SubmitButton fullWidth>Start using Hollo</SubmitButton>
    </form>
  );
}
