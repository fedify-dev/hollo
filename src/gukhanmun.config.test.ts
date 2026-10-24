import { createHash } from "node:crypto";

import { loanwordsFst } from "@gukhanmun/loanwords-fst";
import {
  opendictArchaicFst,
  opendictDialectFst,
  opendictGeneralFst,
  opendictNorthKoreanFst,
} from "@gukhanmun/opendict-fst";
import { stdictFst } from "@gukhanmun/stdict-fst";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

function fingerprint(source: { data: unknown }): string {
  if (!ArrayBuffer.isView(source.data))
    throw new Error("Expected dictionary bytes");
  return createHash("sha256")
    .update(
      new Uint8Array(
        source.data.buffer,
        source.data.byteOffset,
        source.data.byteLength,
      ),
    )
    .digest("hex");
}

const dictionaryHashes = new Map<string, string>();
beforeAll(async () => {
  for (const [name, loader] of [
    ["loanwords", loanwordsFst],
    ["stdict", stdictFst],
    ["general", opendictGeneralFst],
    ["north-korean", opendictNorthKoreanFst],
    ["dialect", opendictDialectFst],
    ["archaic", opendictArchaicFst],
  ] as const)
    dictionaryHashes.set(name, fingerprint(await loader()));
});

const load = vi.hoisted(() => vi.fn());
vi.mock("@gukhanmun/napi", () => ({ load }));

beforeEach(() => {
  vi.resetModules();
  load.mockReset().mockResolvedValue({ convert: () => "converted" });
  vi.stubEnv("GUKHANMUN", "ko");
});

afterEach(() => vi.unstubAllEnvs());

describe("GUKHANMUN_DICTS", () => {
  it.each([
    [undefined, ["loanwords", "general", "dialect", "stdict"]],
    [
      "stdict,opendict,loanwords",
      ["stdict", "general", "north-korean", "dialect", "archaic", "loanwords"],
    ],
    [
      "opendict:archaic,opendict:north-korean,opendict:dialect,opendict:general",
      ["archaic", "north-korean", "dialect", "general"],
    ],
    [" , loanwords , , stdict , ", ["loanwords", "stdict"]],
    ["", []],
    [" , ", []],
  ] as const)(
    "loads %s in the specified priority order",
    async (configuration, expected) => {
      vi.stubEnv("GUKHANMUN_DICTS", configuration);
      const { transformPostHtmlWithGukhanmun } = await import("./gukhanmun");
      await transformPostHtmlWithGukhanmun("<p>香港</p>", "ko");
      expect(load).toHaveBeenCalledTimes(1);
      const options = load.mock.calls[0][0];
      expect(options.dictionaries.map(fingerprint)).toEqual(
        expected.map((name) => dictionaryHashes.get(name)),
      );
    },
  );

  it.each(["unknown", "opendict:unknown", "loanwords:general"])(
    "rejects unknown dictionary %s",
    async (configuration) => {
      vi.stubEnv("GUKHANMUN_DICTS", configuration);
      const { transformPostHtmlWithGukhanmun } = await import("./gukhanmun");
      await expect(
        transformPostHtmlWithGukhanmun("<p>香港</p>", "ko"),
      ).rejects.toThrow(
        `Unknown dictionary in GUKHANMUN_DICTS: ${configuration}`,
      );
      expect(load).not.toHaveBeenCalled();
    },
  );

  it("ignores dictionary configuration when the locale does not match", async () => {
    vi.stubEnv("GUKHANMUN_DICTS", "unknown");
    const { transformPostHtmlWithGukhanmun } = await import("./gukhanmun");
    await expect(
      transformPostHtmlWithGukhanmun("<p>香港</p>", "en"),
    ).resolves.toBe("<p>香港</p>");
    expect(load).not.toHaveBeenCalled();
  });
});
