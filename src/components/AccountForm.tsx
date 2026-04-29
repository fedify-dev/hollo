import { capitalize } from "es-toolkit";
import iso6391 from "iso-639-1";

import { type PostVisibility, THEME_COLORS, type ThemeColor } from "../schema";
import { themeColors } from "../theme/colors";
import {
  CheckboxField,
  Field,
  FieldSection,
  SelectField,
  SubmitButton,
  TextareaField,
  TextField,
} from "./forms";

export interface AccountFormProps {
  method?: "get" | "post" | "dialog";
  action: string;
  readOnly?: {
    username?: boolean;
  };
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
  submitLabel: string;
}

export function AccountForm(props: AccountFormProps) {
  return (
    <form
      method={props.method ?? "post"}
      action={props.action}
      class="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <FieldSection legend="Identity">
        <UsernameField
          host={props.host}
          readOnly={props.readOnly?.username}
          value={props.values?.username}
          error={props.errors?.username}
        />
        <TextField
          id="account-name"
          name="name"
          label="Display name"
          placeholder="John Doe"
          required={true}
          value={props.values?.name}
          hint="Your display name will be shown on your profile."
          error={props.errors?.name}
        />
        <TextareaField
          id="account-bio"
          name="bio"
          label="Bio"
          placeholder="A software engineer in Seoul, and a father of two kids."
          value={props.values?.bio}
          hint="A short description of yourself.  Markdown is supported."
          error={props.errors?.bio}
        />
      </FieldSection>

      <FieldSection legend="Privacy">
        <CheckboxField
          name="protected"
          checked={props.values?.protected}
          label="Protect this account"
          hint="Only approved followers can see your posts."
        />
        <CheckboxField
          name="discoverable"
          checked={props.values?.discoverable}
          label="Discoverable"
          hint="Allow this account to be discovered in the public directory."
        />
        <CheckboxField
          name="expandSpoilers"
          checked={props.values?.expandSpoilers}
          label="Expand content warnings by default"
          hint="Some clients, like Phanpy, use this server preference."
        />
      </FieldSection>

      <FieldSection legend="Preferences">
        <div class="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="account-language"
            name="language"
            label="Default language"
          >
            {iso6391
              .getAllCodes()
              .map((code) => [code, iso6391.getNativeName(code)])
              .sort(([_, nameA], [__, nameB]) => nameA.localeCompare(nameB))
              .map(([code, nativeName]) => (
                <option value={code} selected={props.values?.language === code}>
                  {nativeName} ({iso6391.getName(code)})
                </option>
              ))}
          </SelectField>
          <SelectField
            id="account-visibility"
            name="visibility"
            label="Default visibility"
          >
            <option
              value="public"
              selected={props.values?.visibility === "public"}
            >
              Public
            </option>
            <option
              value="unlisted"
              selected={props.values?.visibility === "unlisted"}
            >
              Unlisted
            </option>
            <option
              value="private"
              selected={props.values?.visibility === "private"}
            >
              Followers only
            </option>
            <option
              value="direct"
              selected={props.values?.visibility === "direct"}
            >
              Direct message
            </option>
          </SelectField>
        </div>
        <ThemeColorField selected={props.values?.themeColor} />
      </FieldSection>

      <FieldSection legend="Updates">
        <CheckboxField
          name="news"
          checked={props.values?.news}
          label="Receive Hollo news"
          hint={`Follow the official Hollo account (${props.officialAccount}) to receive news and updates.`}
        />
      </FieldSection>

      <div class="mt-6 flex justify-end border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <SubmitButton>{props.submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

interface UsernameFieldProps {
  host: string;
  readOnly?: boolean;
  value?: string;
  error?: string;
}

function UsernameField({ host, readOnly, value, error }: UsernameFieldProps) {
  const invalid = error != null;
  const wrapperBase =
    "flex w-full overflow-hidden rounded-md border bg-white shadow-sm transition-colors focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100 dark:bg-neutral-950 dark:focus-within:ring-brand-900";
  const wrapperBorder = invalid
    ? "border-red-500 dark:border-red-500"
    : "border-neutral-300 dark:border-neutral-700";
  const chipClass =
    "flex items-center bg-neutral-50 px-3 text-sm text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400";
  return (
    <Field
      id="account-username"
      label="Username"
      labelExtra={readOnly ? "(cannot change)" : undefined}
      hint="Your username will be a part of your fediverse handle."
      error={error}
    >
      <div class={`${wrapperBase} ${wrapperBorder}`}>
        <span class={chipClass} aria-hidden="true">
          @
        </span>
        <input
          id="account-username"
          type="text"
          name="username"
          required={true}
          placeholder="john"
          readOnly={readOnly}
          value={value}
          aria-invalid={invalid ? "true" : undefined}
          pattern="^[\p{L}\p{N}._\-]+$"
          class="border-0 flex-1 bg-transparent px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:opacity-60 read-only:bg-neutral-50 read-only:text-neutral-500 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:read-only:bg-neutral-900 dark:read-only:text-neutral-400"
        />
        <span class={chipClass} aria-hidden="true">
          @{host}
        </span>
      </div>
    </Field>
  );
}

interface ThemeColorFieldProps {
  selected?: ThemeColor;
}

function ThemeColorField({ selected }: ThemeColorFieldProps) {
  const active = selected ?? "azure";
  return (
    <Field
      id={`account-theme-color-${active}`}
      label="Theme color"
      hint="Tints this account's profile and post pages."
    >
      <div class="grid grid-cols-8 gap-2 sm:grid-cols-10">
        {THEME_COLORS.map((color) => {
          const swatch = `rgb(${themeColors[color][500]})`;
          const inputId = `account-theme-color-${color}`;
          return (
            <label
              for={inputId}
              title={capitalize(color)}
              class="relative aspect-square cursor-pointer rounded-md ring-2 ring-transparent ring-offset-2 ring-offset-white transition-shadow hover:ring-neutral-300 has-[:checked]:ring-neutral-900 dark:ring-offset-neutral-900 dark:hover:ring-neutral-700 dark:has-[:checked]:ring-neutral-100"
              style={`background-color: ${swatch};`}
            >
              <input
                id={inputId}
                type="radio"
                name="themeColor"
                value={color}
                checked={active === color}
                class="peer sr-only"
              />
              <span class="sr-only">{capitalize(color)}</span>
              <span
                class="pointer-events-none absolute inset-0 flex items-center justify-center text-white opacity-0 drop-shadow peer-checked:opacity-100"
                aria-hidden="true"
              >
                <span class="i-lucide-check text-sm" />
              </span>
            </label>
          );
        })}
      </div>
    </Field>
  );
}
