import { capitalize } from "es-toolkit";
import iso6391 from "iso-639-1";

import { type PostVisibility, THEME_COLORS, type ThemeColor } from "../schema";
import {
  CheckboxField,
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
  submitLabel: string;
}

export function AccountForm(props: AccountFormProps) {
  return (
    <form
      method={props.method ?? "post"}
      action={props.action}
      class="space-y-6"
    >
      <FieldSection legend="Identity">
        <TextField
          id="account-username"
          name="username"
          label="Username"
          labelExtra={props.readOnly?.username ? "(cannot change)" : undefined}
          placeholder="john"
          required={true}
          readOnly={props.readOnly?.username}
          value={props.values?.username}
          pattern="^[\p{L}\p{N}._\-]+$"
          hint="Your username will be a part of your fediverse handle."
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

      <FieldSection legend="Defaults">
        <div class="grid gap-4 sm:grid-cols-3">
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
          <ThemeColorField selected={props.values?.themeColor} />
        </div>
      </FieldSection>

      <FieldSection legend="Updates">
        <CheckboxField
          name="news"
          checked={props.values?.news}
          label="Receive Hollo news"
          hint={`Follow the official Hollo account (${props.officialAccount}) to receive news and updates.`}
        />
      </FieldSection>

      <div class="flex justify-end">
        <SubmitButton>{props.submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

interface ThemeColorFieldProps {
  selected?: ThemeColor;
}

function ThemeColorField({ selected }: ThemeColorFieldProps) {
  return (
    <SelectField id="account-theme" name="themeColor" label="Theme color">
      {THEME_COLORS.map((color) => (
        <option value={color} selected={selected === color}>
          {capitalize(color)}
        </option>
      ))}
    </SelectField>
  );
}
