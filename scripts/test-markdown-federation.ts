import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";

import { load } from "cheerio";
import { z } from "zod";

const serverSchema = z.object({
  url: z.url(),
  token: z.string().min(1),
});
const configSchema = z.object({
  hollo: serverSchema,
  mastodon: serverSchema,
  misskey: serverSchema,
  misskeyNoteUpdates: z.enum(["applied", "ignored"]).default("applied"),
});
type Server = z.infer<typeof serverSchema>;
type Status = { id: string; uri: string; content: string };
type Note = { id: string; uri?: string; text: string | null };

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    report: { type: "string" },
  },
});
assert(values.config && values.report, "Use --config FILE --report FILE");
const config = configSchema.parse(
  JSON.parse(await readFile(values.config, "utf8")),
);

async function request<T>(
  server: Server,
  path: string,
  body?: object,
  method = body == null ? "GET" : "POST",
): Promise<T> {
  const options: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  };
  if (body != null) {
    assert.notEqual(method, "GET");
    options.body = JSON.stringify(body);
  }
  const response = await fetch(new URL(path, server.url), options);
  assert(response.ok, `${method} ${path}: HTTP ${response.status}`);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function misskey<T>(path: string, body: object = {}): Promise<T> {
  return await request(config.misskey, `/api/${path}`, {
    i: config.misskey.token,
    ...body,
  });
}

async function eventually<T>(
  label: string,
  check: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 120_000;
  do {
    const result = await check();
    if (result != null) return result;
    await setTimeout(1_000);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

const fixtures = [
  {
    name: "footnote",
    selector: "sup.footnote-ref a[href]",
    source: "Reference[^n]\n\n[^n]: Footnote detail",
    visible: ["Reference", "Footnote detail", "1"],
  },
  {
    name: "deflist",
    selector: "dl dt",
    source: "Term\n: Definition",
    visible: ["Term", "Definition"],
  },
  {
    name: "sub",
    selector: "sub",
    source: "Water H~2~O",
    visible: ["Water", "2"],
  },
  {
    name: "sup",
    selector: "sup",
    source: "Power x^2^",
    visible: ["Power", "2"],
  },
  {
    name: "mark",
    selector: "mark",
    source: "==Highlight==",
    visible: ["Highlight"],
  },
  {
    name: "ruby",
    selector: "ruby rt",
    source: "{漢字:かんじ}",
    visible: ["漢字", "かんじ"],
  },
  {
    name: "ins",
    selector: "ins",
    source: "++Addition++",
    visible: ["Addition"],
  },
  {
    name: "abbr",
    selector: "abbr",
    source: "HTML\n\n*[HTML]: Hypertext Markup Language",
    visible: ["HTML", "Hypertext Markup Language"],
  },
  {
    name: "tasklist",
    selector: "li.task-list-item",
    source: "- [x] Done\n- [ ] Pending",
    visible: ["[x] Done", "[ ] Pending"],
  },
  {
    name: "math",
    selector: "math annotation",
    source: "Inline $x^2$\n\n$$\nx^2\n$$",
    visible: ["Inline", "x", "2"],
  },
];

const report: {
  testedAt: string;
  servers: { hollo: string; mastodon: string; misskey: string };
  results: object[];
  error?: string;
  cleanupErrors?: string[];
} = {
  testedAt: new Date().toISOString(),
  servers: { hollo: "", mastodon: "", misskey: "" },
  results: [],
};
const createdIds: string[] = [];
try {
  const [holloInstance, mastodonInstance, misskeyInstance, sender] =
    await Promise.all([
      request<{ version: string }>(config.hollo, "/api/v1/instance"),
      request<{ version: string }>(config.mastodon, "/api/v2/instance"),
      misskey<{ version: string }>("meta"),
      request<{ id: string; url: string }>(
        config.hollo,
        "/api/v1/accounts/verify_credentials",
      ),
    ]);
  report.servers = {
    hollo: holloInstance.version,
    mastodon: mastodonInstance.version,
    misskey: misskeyInstance.version,
  };
  if (config.misskeyNoteUpdates === "ignored") {
    assert.equal(
      misskeyInstance.version,
      "2026.10.0",
      "The recorded Note update limitation is specific to Misskey 2026.10.0",
    );
  }
  const search = new URLSearchParams({
    q: sender.url,
    type: "accounts",
    resolve: "true",
  });
  const mastodonSearch = await request<{ accounts: { id: string }[] }>(
    config.mastodon,
    `/api/v2/search?${search}`,
  );
  assert.equal(mastodonSearch.accounts.length, 1);
  const mastodonSender = mastodonSearch.accounts[0].id;
  await request(
    config.mastodon,
    `/api/v1/accounts/${mastodonSender}/follow`,
    {},
  );
  const misskeyResolved = await misskey<{
    type: string;
    object: { id: string };
  }>("ap/show", { uri: sender.url });
  assert.equal(misskeyResolved.type, "User");
  const misskeySender = misskeyResolved.object.id;
  const relationship = await misskey<{ isFollowing: boolean }>("users/show", {
    userId: misskeySender,
  });
  if (!relationship.isFollowing)
    await misskey("following/create", { userId: misskeySender });
  await eventually("both follows to reach Hollo", async () => {
    const account = await request<{ followers_count: number }>(
      config.hollo,
      "/api/v1/accounts/verify_credentials",
    );
    return account.followers_count >= 2 ? true : undefined;
  });

  const runId = crypto.randomUUID();
  for (const fixture of fixtures) {
    const marker = `HolloMarkdown ${runId} ${fixture.name}`;
    const source = `${marker} Phase1\n\n${fixture.source}`;
    const created = await request<Status>(config.hollo, "/api/v1/statuses", {
      status: source,
      visibility: "public",
      language: "en",
    });
    createdIds.push(created.id);
    assert(
      load(created.content)(fixture.selector).length > 0,
      `${fixture.name}: extension was not rendered by Hollo`,
    );
    const storedSource = await request<{ text: string }>(
      config.hollo,
      `/api/v1/statuses/${created.id}/source`,
    );
    assert.equal(storedSource.text, source);
    const mastodonCreated = await eventually(
      `${fixture.name} Create on Mastodon`,
      async () => {
        const statuses = await request<Status[]>(
          config.mastodon,
          `/api/v1/accounts/${mastodonSender}/statuses?limit=40`,
        );
        return statuses.find((status) => status.uri === created.uri);
      },
    );
    const misskeyCreated = await eventually(
      `${fixture.name} Create on Misskey`,
      async () => {
        const notes = await misskey<Note[]>("users/notes", {
          userId: misskeySender,
          limit: 100,
        });
        return notes.find((note) => note.uri === created.uri);
      },
    );
    const updatedSource = source.replace("Phase1", "Phase2");
    const updated = await request<Status>(
      config.hollo,
      `/api/v1/statuses/${created.id}`,
      { status: updatedSource },
      "PUT",
    );
    assert(
      load(updated.content)(fixture.selector).length > 0,
      `${fixture.name}: extension was not rendered after editing`,
    );
    const updatedStoredSource = await request<{ text: string }>(
      config.hollo,
      `/api/v1/statuses/${created.id}/source`,
    );
    assert.equal(updatedStoredSource.text, updatedSource);
    const mastodonUpdated = await eventually(
      `${fixture.name} Update on Mastodon`,
      async () => {
        const status = await request<Status>(
          config.mastodon,
          `/api/v1/statuses/${mastodonCreated.id}`,
        );
        return status.content.includes("Phase2") ? status : undefined;
      },
    );
    const misskeyUpdated =
      config.misskeyNoteUpdates === "ignored"
        ? (await setTimeout(5_000),
          await misskey<Note>("notes/show", { noteId: misskeyCreated.id }))
        : await eventually(`${fixture.name} Update on Misskey`, async () => {
            const note = await misskey<Note>("notes/show", {
              noteId: misskeyCreated.id,
            });
            return note.text?.includes("Phase2") ? note : undefined;
          });
    for (const [phase, mastodon, misskeyNote] of [
      ["Phase1", mastodonCreated, misskeyCreated],
      ["Phase2", mastodonUpdated, misskeyUpdated],
    ] as const) {
      const mastodonText = load(mastodon.content).text();
      const misskeyText = misskeyNote.text ?? "";
      for (const [receiver, text] of [
        ["mastodon", mastodonText],
        ["misskey", misskeyText],
      ] as const) {
        const expectedPhase =
          receiver === "misskey" && config.misskeyNoteUpdates === "ignored"
            ? "Phase1"
            : phase;
        assert(
          !text.includes(expectedPhase === "Phase1" ? "Phase2" : "Phase1"),
        );
        for (const expected of [marker, expectedPhase, ...fixture.visible]) {
          assert(
            text.includes(expected),
            `${fixture.name} ${phase}: missing ${JSON.stringify(expected)}`,
          );
        }
      }
    }
    report.results.push({
      extension: fixture.name,
      source: fixture.source,
      uri: created.uri,
      receiverIds: { mastodon: mastodonCreated.id, misskey: misskeyCreated.id },
      create: {
        hollo: created.content,
        mastodon: mastodonCreated.content,
        misskey: misskeyCreated.text,
      },
      update: {
        hollo: updated.content,
        mastodon: mastodonUpdated.content,
        misskey: misskeyUpdated.text,
        misskeyNoteUpdates: config.misskeyNoteUpdates,
        ...(config.misskeyNoteUpdates === "ignored"
          ? {
              observation:
                "unchanged after 5 seconds; delivery must be checked in receiver logs",
            }
          : {}),
      },
    });
    console.log(
      `${fixture.name}: Create received on both; Mastodon updated; Misskey update ${config.misskeyNoteUpdates}`,
    );
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  const cleanup = await Promise.allSettled(
    createdIds.map(async (id) => {
      await request(
        config.hollo,
        `/api/v1/statuses/${id}`,
        undefined,
        "DELETE",
      );
    }),
  );
  report.cleanupErrors = cleanup.flatMap((result) =>
    result.status === "rejected" ? [String(result.reason)] : [],
  );
  await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`);
}
assert.equal(
  report.cleanupErrors?.length,
  0,
  "Cleanup failed; see report.cleanupErrors",
);
