import type { Gukhanmun, Preset } from "@gukhanmun/napi";

import { MARKDOWN_PRESERVE_CLASS } from "./markdown-math";

const converterPromises = new Map<string, Promise<Gukhanmun>>();
const opendictNames = [
  "opendict:general",
  "opendict:north-korean",
  "opendict:dialect",
  "opendict:archaic",
] as const;
type DictionaryName = "loanwords" | "stdict" | (typeof opendictNames)[number];
const defaultDictionaries =
  "loanwords,opendict:general,opendict:dialect,stdict";

function parseDictionaries(configuration: string): DictionaryName[] {
  return configuration.split(",").flatMap((value): DictionaryName[] => {
    const name = value.trim();
    if (name === "") return [];
    if (name === "opendict") return [...opendictNames];
    if (name === "loanwords" || name === "stdict") return [name];
    for (const category of opendictNames) {
      if (name === category) return [category];
    }
    throw new Error(`Unknown dictionary in GUKHANMUN_DICTS: ${name}`);
  });
}

async function loadDictionary(name: DictionaryName) {
  if (name === "loanwords") {
    const { loanwordsFst } = await import("@gukhanmun/loanwords-fst");
    return loanwordsFst();
  }
  if (name === "stdict") {
    const { stdictFst } = await import("@gukhanmun/stdict-fst");
    return stdictFst();
  }
  const opendict = await import("@gukhanmun/opendict-fst");
  const loaders = {
    "opendict:general": opendict.opendictGeneralFst,
    "opendict:north-korean": opendict.opendictNorthKoreanFst,
    "opendict:dialect": opendict.opendictDialectFst,
    "opendict:archaic": opendict.opendictArchaicFst,
  };
  return loaders[name]();
}
const htmlOptions = {
  preserveAttributes: [{ name: "translate", value: "no" }],
  preserveClasses: [MARKDOWN_PRESERVE_CLASS],
} as const;

function matchesWildcard(value: string, pattern: string): boolean {
  let valueIndex = 0;
  let patternIndex = 0;
  let wildcardIndex = -1;
  let wildcardValueIndex = 0;

  while (valueIndex < value.length) {
    if (
      patternIndex < pattern.length &&
      pattern[patternIndex] === value[valueIndex]
    ) {
      valueIndex++;
      patternIndex++;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      wildcardIndex = patternIndex++;
      wildcardValueIndex = valueIndex;
    } else if (wildcardIndex >= 0) {
      patternIndex = wildcardIndex + 1;
      valueIndex = ++wildcardValueIndex;
    } else {
      return false;
    }
  }

  while (pattern[patternIndex] === "*") patternIndex++;
  return patternIndex === pattern.length;
}

export function matchesGukhanmunLocale(
  locale: string | null | undefined,
  configuredLocales: string | null | undefined,
): boolean {
  if (locale == null || configuredLocales == null) return false;
  const normalizedLocale = locale.toLowerCase();
  return configuredLocales.split(",").some((configuredLocale) => {
    const pattern = configuredLocale.trim().toLowerCase();
    return pattern !== "" && matchesWildcard(normalizedLocale, pattern);
  });
}

export function getGukhanmunPreset(locale: string): Preset {
  try {
    return new Intl.Locale(locale).region === "KP" ? "ko-kp" : "ko-kr";
  } catch {
    return "ko-kr";
  }
}

async function createConverter(
  preset: Preset,
  dictionaryNames: readonly DictionaryName[],
): Promise<Gukhanmun> {
  const { load } = await import("@gukhanmun/napi");
  return await load({
    preset,
    rendering: "ruby-on-hanja",
    dictionaries: await Promise.all(dictionaryNames.map(loadDictionary)),
    html: htmlOptions,
  });
}

function getConverter(
  preset: Preset,
  dictionaryNames: readonly DictionaryName[],
): Promise<Gukhanmun> {
  const key = `${preset}:${dictionaryNames.join(",")}`;
  let converterPromise = converterPromises.get(key);
  if (converterPromise == null) {
    converterPromise = createConverter(preset, dictionaryNames).catch(
      (error: unknown) => {
        converterPromises.delete(key);
        throw error;
      },
    );
    converterPromises.set(key, converterPromise);
  }
  return converterPromise;
}

export async function transformPostHtmlWithGukhanmun(
  html: string,
  locale: string | null | undefined,
): Promise<string> {
  // oxlint-disable-next-line typescript/dot-notation
  const configuredLocales = process.env["GUKHANMUN"];
  if (locale == null || !matchesGukhanmunLocale(locale, configuredLocales))
    return html;

  // oxlint-disable-next-line typescript/dot-notation
  const dictionaryNames = parseDictionaries(
    process.env["GUKHANMUN_DICTS"] ?? defaultDictionaries,
  );
  const converter = await getConverter(
    getGukhanmunPreset(locale),
    dictionaryNames,
  );
  return converter.convert(html, "html");
}
