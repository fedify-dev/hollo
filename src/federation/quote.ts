import type { Context } from "@fedify/fedify";
import {
  type InteractionAuthorizationVerificationFailure,
  type QuotePost,
  quoteInteraction,
} from "@fedify/interaction-controls";
import {
  type DocumentLoader,
  type InteractionRule,
  InteractionPolicy,
  Note,
  type QuoteAuthorization,
  type QuoteRequest,
} from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";

import type { Account, Post } from "../schema";

const logger = getLogger(["hollo", "federation", "quote"]);

export function getQuoteAuthorizationIri(
  target: Pick<Post, "iri">,
  quote: Pick<Post, "id">,
): string {
  return `${target.iri}/quote_authorizations/${quote.id}`;
}

export function getQuoteRequestId(quote: Pick<Post, "iri">): URL {
  return new URL("#quote-request", quote.iri);
}

export function createQuoteAuthorization(
  target: Pick<Post, "iri"> & { account: Pick<Account, "iri"> },
  quote: Pick<Post, "id" | "iri">,
  authorizationIri: string = getQuoteAuthorizationIri(target, quote),
): QuoteAuthorization {
  return quoteInteraction.createAuthorization({
    id: new URL(authorizationIri),
    attributedTo: new URL(target.account.iri),
    interactingObject: new URL(quote.iri),
    interactionTarget: new URL(target.iri),
  });
}

export function createQuoteRequest(
  quote: Pick<Post, "iri">,
  actorIri: string,
  targetIri: string,
  instrument: QuotePost,
): QuoteRequest {
  return quoteInteraction.createRequest({
    id: getQuoteRequestId(quote),
    actor: new URL(actorIri),
    object: new URL(targetIri),
    instrument,
  });
}

/**
 * Builds the local quote target as the helper's policy subject, so policy
 * evaluation and request verification work on Hollo's stored settings
 * instead of a self-fetch of the local post.
 */
export function createQuoteTargetSubject(
  target: Pick<Post, "iri"> & { account: Pick<Account, "iri"> },
  canQuote: InteractionRule,
): Note {
  return new Note({
    id: new URL(target.iri),
    attribution: new URL(target.account.iri),
    interactionPolicy: new InteractionPolicy({ canQuote }),
  });
}

export type QuoteAuthorizationVerification =
  | { verified: true; authorizationIri: string }
  | {
      verified: false;
      failure: InteractionAuthorizationVerificationFailure;
      retryable: boolean;
    };

/**
 * Whether a document loader error is worth retrying: network failures,
 * timeouts, DNS lookup failures, and 5xx/408/429 responses are; other HTTP
 * errors and disallowed URLs (e.g., private addresses blocked by SSRF
 * protection) are permanent.
 */
export function isTransientLoaderError(error: unknown): boolean {
  if (error instanceof Error && error.name === "UrlError") {
    return "reason" in error && error.reason === "dns";
  }
  if (
    error instanceof Error &&
    "response" in error &&
    error.response instanceof Response
  ) {
    const status = error.response.status;
    return status >= 500 || status === 408 || status === 429;
  }
  return true;
}

/**
 * Verifies a FEP-044f `QuoteAuthorization` by dereferencing its IRI.
 * Embedded authorization bodies are never trusted.
 */
export async function verifyQuoteAuthorization(
  ctx: Context<unknown>,
  options: {
    authorizationId: URL;
    quoteIri: string;
    targetIri: string;
    targetAuthorIri: string;
    documentLoader?: DocumentLoader;
  },
): Promise<QuoteAuthorizationVerification> {
  const documentLoader = options.documentLoader ?? ctx.documentLoader;
  const loaderErrors: unknown[] = [];
  const trackingLoader: DocumentLoader = async (url, loaderOptions) => {
    try {
      return await documentLoader(url, loaderOptions);
    } catch (error) {
      loaderErrors.push(error);
      throw error;
    }
  };
  const result = await quoteInteraction.verifyAuthorization(ctx, {
    authorization: options.authorizationId,
    interactingObject: new URL(options.quoteIri),
    interactionTarget: new URL(options.targetIri),
    attributedTo: new URL(options.targetAuthorIri),
    documentLoader: trackingLoader,
  });
  if (result.verified) {
    return { verified: true, authorizationIri: result.authorizationId.href };
  }
  const retryable =
    result.failure.category === "unverifiable" &&
    loaderErrors.some(isTransientLoaderError);
  logger.debug(
    "Failed to verify the quote authorization {authorizationId}: {failure}",
    {
      authorizationId: options.authorizationId.href,
      failure: result.failure,
      retryable,
    },
  );
  return { verified: false, failure: result.failure, retryable };
}
