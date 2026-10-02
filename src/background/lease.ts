import { getLogger } from "@logtape/drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";

import { createPostgresClient, type Database } from "../db";
import { relations } from "../relations";
import { LeaseLostError } from "./errors";

type Client = ReturnType<typeof createPostgresClient>;
interface Slot {
  client?: Client;
  active?: Lease;
  busy: boolean;
}
export interface Lease {
  db: Database;
  lost: boolean;
  assertOwned(): void;
}

// A max:1 client per slot allows a manual transaction without postgres.js's
// begin() race: a disconnected begin() can reject while its callback runs on.
// Never return a slot, reconnect it, or issue SQL until the real callback ends.
export class ItemLeasePool {
  private readonly slots: Slot[];
  private readonly waiters: Array<() => void> = [];
  constructor(concurrency = 4) {
    this.slots = Array.from({ length: concurrency }, () => ({ busy: false }));
  }

  async run<T>(callback: (lease: Lease) => Promise<T>): Promise<T> {
    let slot: Slot | undefined;
    while (!(slot = this.slots.find((candidate) => !candidate.busy))) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    slot.busy = true;
    const ownedSlot = slot;
    if (slot.client == null) {
      const client = createPostgresClient(1, {
        max_lifetime: null,
        onclose() {
          if (ownedSlot.client === client && ownedSlot.active)
            ownedSlot.active.lost = true;
        },
      });
      const unsafe = client.unsafe.bind(client);
      client.unsafe = ((...args: Parameters<Client["unsafe"]>) => {
        ownedSlot.active?.assertOwned();
        return unsafe(...args);
      }) as Client["unsafe"];
      slot.client = client;
    }
    const client = slot.client;
    const lease: Lease = {
      db: drizzle({ client, relations, logger: getLogger() }),
      lost: false,
      assertOwned() {
        if (this.lost) throw new LeaseLostError("Item lease connection lost");
      },
    };
    slot.active = lease;
    let began = false;
    try {
      await client.unsafe("BEGIN");
      began = true;
      await client.unsafe("SET LOCAL idle_in_transaction_session_timeout = 0");
      await client.unsafe("SET LOCAL lock_timeout = '10s'");
      const result = await callback(lease);
      lease.assertOwned();
      await client.unsafe("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began && !lease.lost) {
        try {
          await client.unsafe("ROLLBACK");
        } catch {
          lease.lost = true;
        }
      }
      if (lease.lost)
        throw new LeaseLostError("Item lease connection lost", {
          cause: error,
        });
      throw error;
    } finally {
      if (lease.lost) {
        // No rollback or release against a reconnected connection object.
        await client.end({ timeout: 0 });
        slot.client = undefined;
      }
      slot.active = undefined;
      slot.busy = false;
      this.waiters.shift()?.();
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      this.slots.map(async (slot) => {
        if (slot.busy)
          throw new Error("Drain item handlers before closing leases");
        await slot.client?.end({ timeout: 5 });
        slot.client = undefined;
      }),
    );
  }
}

export const itemLeases = new ItemLeasePool();
