import { SubmitButton, TextField } from "./forms";

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

export function LoginForm(props: LoginFormProps) {
  return (
    <form
      method={props.method ?? "post"}
      action={props.action}
      class="space-y-4"
    >
      <TextField
        id="login-email"
        name="email"
        type="email"
        label="Email"
        placeholder="john@example.com"
        required={true}
        value={props.values?.email}
        error={props.errors?.email}
      />
      <TextField
        id="login-password"
        name="password"
        type="password"
        label="Password"
        required={true}
        minLength={6}
        error={props.errors?.password}
      />
      {props.next && <input type="hidden" name="next" value={props.next} />}
      <SubmitButton fullWidth>Sign in</SubmitButton>
    </form>
  );
}
