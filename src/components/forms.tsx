import type { Child, JSX, PropsWithChildren } from "hono/jsx";

const fieldBase =
  "w-full rounded-md bg-white px-3 py-2 text-neutral-900 shadow-sm transition-colors placeholder:text-neutral-400 focus:(border-brand-500 outline-none ring-2 ring-brand-100) disabled:(cursor-not-allowed opacity-60) read-only:(bg-neutral-50 text-neutral-500) dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-brand-900 dark:read-only:bg-neutral-900 dark:read-only:text-neutral-400";

const fieldValid = "border-neutral-300 dark:border-neutral-700";
const fieldInvalid = "border-red-500 dark:border-red-500";
const labelClass =
  "block text-sm font-medium text-neutral-800 dark:text-neutral-200";
const hintClass = "mt-1 text-xs text-neutral-500 dark:text-neutral-400";
const errorClass = "mt-1 text-xs text-red-600 dark:text-red-400";

export interface FieldProps {
  id: string;
  label: Child;
  hint?: Child;
  error?: string;
  required?: boolean;
  labelExtra?: Child;
}

/** Wraps a control with a label, hint, and optional error message. */
export function Field({
  id,
  label,
  hint,
  error,
  labelExtra,
  children,
}: PropsWithChildren<FieldProps>) {
  return (
    <div>
      <label for={id} class={labelClass}>
        {label}
        {labelExtra && (
          <span class="ms-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
            {labelExtra}
          </span>
        )}
      </label>
      <div class="mt-1">{children}</div>
      {error ? (
        <p class={errorClass}>{error}</p>
      ) : hint ? (
        <p class={hintClass}>{hint}</p>
      ) : null}
    </div>
  );
}

type InputProps = Omit<JSX.IntrinsicElements["input"], "class" | "className">;

export interface TextFieldProps extends InputProps {
  id: string;
  name: string;
  label: Child;
  hint?: Child;
  error?: string;
  labelExtra?: Child;
}

/** Text/email/password/number/url input with label, hint, and error. */
export function TextField({
  id,
  label,
  hint,
  error,
  labelExtra,
  ...input
}: TextFieldProps) {
  const invalid = error != null;
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      labelExtra={labelExtra}
    >
      <input
        id={id}
        type={input.type ?? "text"}
        aria-invalid={invalid ? "true" : undefined}
        class={`${fieldBase} ${invalid ? fieldInvalid : fieldValid}`}
        {...input}
      />
    </Field>
  );
}

type TextareaProps = Omit<
  JSX.IntrinsicElements["textarea"],
  "class" | "className"
>;

export interface TextareaFieldProps extends TextareaProps {
  id: string;
  name: string;
  label: Child;
  hint?: Child;
  error?: string;
  value?: string;
}

/** Textarea with label, hint, and error.  Accepts a `value` to seed content. */
export function TextareaField({
  id,
  label,
  hint,
  error,
  value,
  rows = 4,
  ...textarea
}: TextareaFieldProps) {
  const invalid = error != null;
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <textarea
        id={id}
        rows={rows}
        aria-invalid={invalid ? "true" : undefined}
        class={`${fieldBase} resize-y ${invalid ? fieldInvalid : fieldValid}`}
        {...textarea}
      >
        {value}
      </textarea>
    </Field>
  );
}

type SelectProps = Omit<JSX.IntrinsicElements["select"], "class" | "className">;

export interface SelectFieldProps extends SelectProps {
  id: string;
  name: string;
  label: Child;
  hint?: Child;
  error?: string;
}

/** Select with label, hint, and error. */
export function SelectField({
  id,
  label,
  hint,
  error,
  children,
  ...select
}: PropsWithChildren<SelectFieldProps>) {
  const invalid = error != null;
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <select
        id={id}
        aria-invalid={invalid ? "true" : undefined}
        class={`${fieldBase} ${invalid ? fieldInvalid : fieldValid}`}
        {...select}
      >
        {children}
      </select>
    </Field>
  );
}

export interface CheckboxFieldProps {
  id?: string;
  name: string;
  checked?: boolean;
  label: Child;
  hint?: Child;
  value?: string;
}

/**
 * Checkbox laid out as: square checkbox on the left, label and optional hint
 * on the right.
 */
export function CheckboxField({
  id,
  name,
  checked,
  label,
  hint,
  value = "true",
}: CheckboxFieldProps) {
  const inputId = id ?? `field-${name}`;
  return (
    <div class="flex items-start gap-3">
      <div class="flex h-5 items-center">
        <input
          id={inputId}
          type="checkbox"
          name={name}
          value={value}
          checked={checked}
          class="size-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-200 focus:ring-offset-0 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:ring-brand-900"
        />
      </div>
      <div class="min-w-0 flex-1 text-sm">
        <label
          for={inputId}
          class="font-medium text-neutral-800 dark:text-neutral-200"
        >
          {label}
        </label>
        {hint && (
          <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

export interface FieldSectionProps {
  legend: Child;
  description?: Child;
}

/** Card-shaped fieldset with a legend and optional description. */
export function FieldSection({
  legend,
  description,
  children,
}: PropsWithChildren<FieldSectionProps>) {
  return (
    <fieldset class="m-0 rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <legend class="px-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
        {legend}
      </legend>
      {description && (
        <p class="-mt-1 mb-4 text-xs text-neutral-500 dark:text-neutral-400">
          {description}
        </p>
      )}
      <div class="space-y-4">{children}</div>
    </fieldset>
  );
}

export type SubmitButtonVariant = "primary" | "secondary" | "danger";

export interface SubmitButtonProps {
  variant?: SubmitButtonVariant;
  fullWidth?: boolean;
  disabled?: boolean;
  name?: string;
  value?: string;
}

/** Submit button with primary/secondary/danger variants. */
export function SubmitButton({
  variant = "primary",
  fullWidth,
  disabled,
  name,
  value,
  children,
}: PropsWithChildren<SubmitButtonProps>) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-950";
  const styles: Record<SubmitButtonVariant, string> = {
    primary:
      "bg-brand-600 text-white hover:bg-brand-700 focus-visible:ring-brand-400",
    secondary:
      "border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100 focus-visible:ring-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800",
    danger:
      "border border-red-300 bg-white text-red-700 hover:bg-red-50 focus-visible:ring-red-400 dark:border-red-900 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950",
  };
  return (
    <button
      type="submit"
      disabled={disabled}
      name={name}
      value={value}
      class={`${base} ${styles[variant]} ${fullWidth ? "w-full" : ""}`}
    >
      {children}
    </button>
  );
}
