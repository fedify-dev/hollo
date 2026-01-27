import * as timekeeper from "timekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../schema";
import {
  isActorStale,
  REMOTE_ACTOR_STALENESS_DAYS,
  refreshActorIfStale,
} from "./account";

// Create a minimal mock account for testing
function createMockAccount(fetched: Date | null): Account {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    iri: "https://example.com/users/test",
    type: "Person",
    name: "Test User",
    handle: "@test@example.com",
    bioHtml: null,
    url: null,
    protected: false,
    avatarUrl: null,
    coverUrl: null,
    inboxUrl: "https://example.com/users/test/inbox",
    followersUrl: null,
    sharedInboxUrl: null,
    featuredUrl: null,
    followingCount: 0,
    followersCount: 0,
    postsCount: 0,
    fieldHtmls: {},
    emojis: {},
    sensitive: false,
    successorId: null,
    aliases: [],
    instanceHost: "example.com",
    published: null,
    updated: new Date(),
    fetched,
  };
}

describe("isActorStale", () => {
  const now = new Date("2024-06-15T12:00:00Z");

  beforeEach(() => {
    timekeeper.freeze(now);
  });

  afterEach(() => {
    timekeeper.reset();
  });

  it("returns false when fetched is null (local actor)", () => {
    expect.assertions(1);

    const account = createMockAccount(null);
    expect(isActorStale(account)).toBe(false);
  });

  it("returns false when actor was fetched recently", () => {
    expect.assertions(1);

    // Fetched 1 day ago (within staleness period)
    const fetched = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    const account = createMockAccount(fetched);
    expect(isActorStale(account)).toBe(false);
  });

  it("returns false when actor was fetched exactly at staleness threshold", () => {
    expect.assertions(1);

    // Fetched exactly at staleness threshold
    const fetched = new Date(
      now.getTime() - REMOTE_ACTOR_STALENESS_DAYS * 24 * 60 * 60 * 1000,
    );
    const account = createMockAccount(fetched);
    expect(isActorStale(account)).toBe(false);
  });

  it("returns true when actor was fetched beyond staleness threshold", () => {
    expect.assertions(1);

    // Fetched 1ms beyond staleness threshold
    const fetched = new Date(
      now.getTime() - REMOTE_ACTOR_STALENESS_DAYS * 24 * 60 * 60 * 1000 - 1,
    );
    const account = createMockAccount(fetched);
    expect(isActorStale(account)).toBe(true);
  });

  it("returns true when actor was fetched long ago", () => {
    expect.assertions(1);

    // Fetched 30 days ago
    const fetched = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const account = createMockAccount(fetched);
    expect(isActorStale(account)).toBe(true);
  });
});

describe("refreshActorIfStale", () => {
  const now = new Date("2024-06-15T12:00:00Z");

  beforeEach(() => {
    timekeeper.freeze(now);
  });

  afterEach(() => {
    timekeeper.reset();
    vi.restoreAllMocks();
  });

  it("does not refresh when actor is not stale", async () => {
    expect.assertions(1);

    // Mock lookupObject to track if it's called
    const lookupObjectMock = vi.fn();
    vi.doMock("@fedify/fedify", () => ({
      lookupObject: lookupObjectMock,
    }));

    // Fetched 1 day ago (not stale)
    const fetched = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    const account = createMockAccount(fetched);

    // Create a mock db (we won't actually use it since actor is not stale)
    const mockDb = {} as Parameters<typeof refreshActorIfStale>[0];

    refreshActorIfStale(mockDb, account, "https://example.com");

    // Since actor is not stale, lookupObject should not be called
    expect(lookupObjectMock).not.toHaveBeenCalled();
  });
});
