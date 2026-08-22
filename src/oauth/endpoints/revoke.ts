import { Hono } from "hono";
import { z } from "zod";

import { requestBody } from "../../helpers";
import { revokeAccessTokenByCode } from "../helpers";
import {
  type ClientAuthenticationVariables,
  clientAuthentication,
} from "../middleware";

const app = new Hono<{ Variables: ClientAuthenticationVariables }>();

// RFC7009 - OAuth Token Revocation:
const tokenRevocationSchema = z.strictObject({
  token: z.string(),
  token_type_hint: z.string().optional(),
  // client_id and client_secret are present but consumed by the
  // clientAuthentication middleware:
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
});

app.post("/", clientAuthentication, async (c) => {
  const client = c.get("client");
  const result = await requestBody(c.req, tokenRevocationSchema);

  if (!result.success) {
    return c.json({ error: "invalid_request", zod_error: result.error }, 400);
  }

  if (
    result.data.token_type_hint &&
    result.data.token_type_hint !== "access_token"
  ) {
    return c.json(
      {
        error: "unsupported_token_type",
        error_description:
          "The authorization server does not support the revocation of the presented token type",
      },
      400,
    );
  }

  await revokeAccessTokenByCode(result.data.token, client.id);

  // The spec is a little strange here in that the response status is 200, but
  // there's actually no response body, so 204 would be more appropriate.
  // We return an empty json response to make testing easier:
  return c.json({}, 200);
});

export default app;
