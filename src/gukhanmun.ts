import type { Gukhanmun, Preset } from "@gukhanmun/napi";

const converterPromises = new Map<Preset, Promise<Gukhanmun>>();
const htmlOptions = {
  preserveAttributes: [{ name: "translate", value: "no" }],
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

async function createConverter(preset: Preset): Promise<Gukhanmun> {
  const { load } = await import("@gukhanmun/napi");
  if (preset === "ko-kp") {
    const { opendictNorthKoreanFst } = await import("@gukhanmun/opendict-fst");
    return await load({
      preset,
      rendering: "ruby-on-hanja",
      dictionaries: [await opendictNorthKoreanFst()],
      html: htmlOptions,
    });
  }

  const { stdictFst } = await import("@gukhanmun/stdict-fst");
  return await load({
    preset,
    rendering: "ruby-on-hanja",
    dictionaries: [await stdictFst()],
    html: htmlOptions,
  });
}

function getConverter(preset: Preset): Promise<Gukhanmun> {
  let converterPromise = converterPromises.get(preset);
  if (converterPromise == null) {
    converterPromise = createConverter(preset).catch((error: unknown) => {
      converterPromises.delete(preset);
      throw error;
    });
    converterPromises.set(preset, converterPromise);
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

  const converter = await getConverter(getGukhanmunPreset(locale));
  return converter.convert(html, "html");
}
