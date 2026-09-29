import { Person } from "@fedify/vocab";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import { getLoginCookie } from "../../tests/helpers/web";
import federation from "../federation";
import * as accountModule from "../federation/account";
import app from "./index";

function createRemoteActor(): Person {
  return new Person({
    id: new URL("https://remote.test/users/alice"),
    preferredUsername: "alice",
    name: "Alice",
    inbox: new URL("https://remote.test/users/alice/inbox"),
  });
}

describe("federation force refresh", { concurrent: false }, () => {
  beforeEach(async () => {
    await cleanDatabase();
    await createAccount();
    vi.restoreAllMocks();
  });

  it("shows a dedicated canonical handle conflict message", async () => {
    expect.assertions(2);

    const cookie = await getLoginCookie();
    const response = await app.request(
      "/federation?error=refresh:account-conflict",
      {
        headers: {
          Cookie: cookie,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "Account refresh was blocked by a canonical handle conflict.",
    );
  });

  it("redirects force refresh failures caused by canonical handle conflicts to the dedicated error state", async () => {
    expect.assertions(2);

    const actor = createRemoteActor();
    vi.spyOn(federation, "createContext").mockReturnValue({
      getDocumentLoader: vi.fn(async () => undefined),
      lookupObject: vi.fn(async () => actor),
    } as never);
    vi.spyOn(accountModule, "persistAccount").mockRejectedValue(
      new accountModule.AccountHandleConflictError(
        actor.id!.href,
        "@alice@remote.test",
        {
          id: "00000000-0000-0000-0000-000000000000",
          iri: "https://stale.remote.test/users/alice",
          type: "Person",
          name: "Stale Alice",
          handle: "@alice@remote.test",
          bioHtml: "",
          url: "https://stale.remote.test/@alice",
          protected: false,
          avatarUrl: null,
          coverUrl: null,
          inboxUrl: "https://stale.remote.test/users/alice/inbox",
          followersUrl: "https://stale.remote.test/users/alice/followers",
          sharedInboxUrl: "https://stale.remote.test/inbox",
          featuredUrl: "https://stale.remote.test/users/alice/featured",
          followingCount: 0,
          followersCount: 0,
          postsCount: 0,
          fieldHtmls: {},
          emojis: {},
          sensitive: false,
          successorId: null,
          aliases: [],
          instanceHost: "stale.remote.test",
          published: null,
          updated: new Date(),
          fetched: new Date(),
          owner: null,
        },
        "unverified",
      ),
    );

    const form = new FormData();
    form.append("uri", actor.id!.href);
    const cookie = await getLoginCookie();
    const response = await app.request("/federation/refresh", {
      method: "POST",
      body: form,
      headers: {
        Cookie: cookie,
        "Sec-Fetch-Site": "same-origin",
      },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/federation?error=refresh:account-conflict",
    );
  });
});
