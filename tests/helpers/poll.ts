import db from "../../src/db";
import * as Schema from "../../src/schema";
import type { Uuid } from "../../src/uuid";
import { uuidv7 } from "../../src/uuid";

export async function createExpiredPollPost(
  accountId: Uuid,
  expires: Date,
): Promise<{ pollId: Uuid; postId: Uuid }> {
  const pollId = uuidv7(+expires - 60_000);
  const postId = uuidv7(+expires - 60_000);

  await db.transaction(async (tx) => {
    await tx.insert(Schema.polls).values({
      id: pollId,
      multiple: false,
      expires,
    });
    await tx.insert(Schema.pollOptions).values([
      {
        pollId,
        index: 0,
        title: "First option",
      },
      {
        pollId,
        index: 1,
        title: "Second option",
      },
    ]);
    await tx.insert(Schema.posts).values({
      id: postId,
      iri: `https://hollo.test/@hollo/${postId}`,
      type: "Question",
      accountId,
      visibility: "public",
      contentHtml: "<p>Which option?</p>",
      content: "Which option?",
      pollId,
      published: new Date(+expires - 60_000),
    });
  });

  return { pollId, postId };
}
