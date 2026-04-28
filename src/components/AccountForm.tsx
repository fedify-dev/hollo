import { capitalize } from "es-toolkit";
import iso6391 from "iso-639-1";

import { type PostVisibility, THEME_COLORS, type ThemeColor } from "../schema";

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
  submitLabel: string;
}

const fieldClass =
  "w-full rounded-md border bg-white px-3 py-2 text-neutral-900 shadow-sm transition-colors placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-brand-900 read-only:bg-neutral-50 read-only:text-neutral-500 dark:read-only:bg-neutral-900 dark:read-only:text-neutral-400";
const fieldValid = "border-neutral-300 dark:border-neutral-700";
const fieldInvalid = "border-red-500 dark:border-red-500";
const labelClass =
  "block text-sm font-medium text-neutral-800 dark:text-neutral-200";
const hintClass = "mt-1 text-xs text-neutral-500 dark:text-neutral-400";
const errorClass = "mt-1 text-xs text-red-600 dark:text-red-400";
const checkboxClass =
  "size-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-200 focus:ring-offset-0 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:ring-brand-900";
const sectionClass =
  "rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900";
const submitClass =
  "rounded-md bg-brand-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-950";

export function AccountForm(props: AccountFormProps) {
  const usernameInvalid = props.errors?.username != null;
  const nameInvalid = props.errors?.name != null;
  const bioInvalid = props.errors?.bio != null;
  return (
    <form
      method={props.method ?? "post"}
      action={props.action}
      class="space-y-6"
    >
      <fieldset class={`${sectionClass} space-y-4 m-0 border-1`}>
        <legend class="px-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
          Identity
        </legend>
        <div>
          <label for="account-username" class={labelClass}>
            Username
            {props.readOnly?.username && (
              <span class="ms-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
                (cannot change)
              </span>
            )}
          </label>
          <input
            id="account-username"
            type="text"
            name="username"
            required={true}
            placeholder="john"
            readOnly={props.readOnly?.username}
            value={props.values?.username}
            aria-invalid={usernameInvalid ? "true" : undefined}
            pattern="^[\p{L}\p{N}._\-]+$"
            class={`${fieldClass} ${usernameInvalid ? fieldInvalid : fieldValid} mt-1`}
          />
          <p class={usernameInvalid ? errorClass : hintClass}>
            {usernameInvalid
              ? props.errors?.username
              : "Your username will be a part of your fediverse handle."}
          </p>
        </div>
        <div>
          <label for="account-name" class={labelClass}>
            Display name
          </label>
          <input
            id="account-name"
            type="text"
            name="name"
            required={true}
            placeholder="John Doe"
            value={props.values?.name}
            aria-invalid={nameInvalid ? "true" : undefined}
            class={`${fieldClass} ${nameInvalid ? fieldInvalid : fieldValid} mt-1`}
          />
          <p class={nameInvalid ? errorClass : hintClass}>
            {nameInvalid
              ? props.errors?.name
              : "Your display name will be shown on your profile."}
          </p>
        </div>
        <div>
          <label for="account-bio" class={labelClass}>
            Bio
          </label>
          <textarea
            id="account-bio"
            name="bio"
            rows={4}
            placeholder="A software engineer in Seoul, and a father of two kids."
            aria-invalid={bioInvalid ? "true" : undefined}
            class={`${fieldClass} ${bioInvalid ? fieldInvalid : fieldValid} mt-1 resize-y`}
          >
            {props.values?.bio}
          </textarea>
          <p class={bioInvalid ? errorClass : hintClass}>
            {bioInvalid
              ? props.errors?.bio
              : "A short description of yourself.  Markdown is supported."}
          </p>
        </div>
      </fieldset>

      <fieldset class={`${sectionClass} space-y-3 m-0 border-1`}>
        <legend class="px-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
          Privacy
        </legend>
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
      </fieldset>

      <fieldset class={`${sectionClass} m-0 border-1`}>
        <legend class="px-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
          Defaults
        </legend>
        <div class="grid gap-4 sm:grid-cols-3">
          <div>
            <label for="account-language" class={labelClass}>
              Default language
            </label>
            <select
              id="account-language"
              name="language"
              class={`${fieldClass} ${fieldValid} mt-1`}
            >
              {iso6391
                .getAllCodes()
                .map((code) => [code, iso6391.getNativeName(code)])
                .sort(([_, nameA], [__, nameB]) => nameA.localeCompare(nameB))
                .map(([code, nativeName]) => (
                  <option
                    value={code}
                    selected={props.values?.language === code}
                  >
                    {nativeName} ({iso6391.getName(code)})
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label for="account-visibility" class={labelClass}>
              Default visibility
            </label>
            <select
              id="account-visibility"
              name="visibility"
              class={`${fieldClass} ${fieldValid} mt-1`}
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
            </select>
          </div>
          <div>
            <label for="account-theme" class={labelClass}>
              Theme color
            </label>
            <select
              id="account-theme"
              name="themeColor"
              class={`${fieldClass} ${fieldValid} mt-1`}
            >
              {THEME_COLORS.map((color) => (
                <option
                  value={color}
                  selected={props.values?.themeColor === color}
                >
                  {capitalize(color)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      <fieldset class={`${sectionClass} m-0 border-1`}>
        <legend class="px-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
          Updates
        </legend>
        <CheckboxField
          name="news"
          checked={props.values?.news}
          label="Receive Hollo news"
          hint={`Follow the official Hollo account (${props.officialAccount}) to receive news and updates.`}
        />
      </fieldset>

      <div class="flex justify-end">
        <button type="submit" class={submitClass}>
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}

interface CheckboxFieldProps {
  name: string;
  checked?: boolean;
  label: string;
  hint?: string;
}

function CheckboxField({ name, checked, label, hint }: CheckboxFieldProps) {
  const id = `account-${name}`;
  return (
    <div class="flex items-start gap-3">
      <div class="flex h-5 items-center">
        <input
          id={id}
          type="checkbox"
          name={name}
          value="true"
          checked={checked}
          class={checkboxClass}
        />
      </div>
      <div class="min-w-0 flex-1 text-sm">
        <label
          for={id}
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
