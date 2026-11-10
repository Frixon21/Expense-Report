import { z } from "zod";
import { appSessionCookie, authenticateWithBtAuth, BtAuthIntegrationError, createAppSession, LoginForbiddenError, LoginLockedError, LoginRateLimitedError, LoginRejectedError, registerVerifiedIdentity } from "@/lib/server/auth";
import { HttpError } from "@/lib/server/records";
import { privateError, privateJson, requestJson, requireProtectedMutation } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let stage: "request" | "provider" | "account" | "session" = "request";
  try {
    requireProtectedMutation(request);
    const parsed = z.object({ username: z.string().trim().min(1).max(320), password: z.string().min(1).max(2000) }).safeParse(await requestJson(request));
    if (!parsed.success) throw new HttpError(400, "Enter your BT Auth username and password.");
    stage = "provider";
    let identity;
    try {
      identity = await authenticateWithBtAuth(parsed.data.username, parsed.data.password);
    } catch (error) {
      if (error instanceof LoginRejectedError) throw new HttpError(401, "BT Auth did not accept those credentials.");
      if (error instanceof LoginForbiddenError) throw new HttpError(403, "BT Auth did not permit this sign-in.");
      if (error instanceof LoginLockedError) throw new HttpError(423, "BT Auth temporarily locked this account. Contact support.");
      if (error instanceof LoginRateLimitedError) throw new HttpError(429, "Too many sign-in attempts. Wait before trying again.");
      const code = error instanceof BtAuthIntegrationError ? error.code : "BT_AUTH_UNEXPECTED_FAILURE";
      console.warn("BT_AUTH_LOGIN_FAILURE", { code });
      return privateJson({ error: "BT Auth could not complete sign-in.", code }, 503);
    }
    stage = "account";
    const user = registerVerifiedIdentity(identity);
    if (user.accessStatus === "disabled") throw new HttpError(403, "This Expense Report account is disabled.");
    stage = "session";
    const session = await createAppSession(user.id, identity.sessionProof);
    return privateJson(
      { authenticated: true, user: { id: user.id, displayName: user.displayName, email: user.email, accessStatus: user.accessStatus, roles: user.roles } },
      200,
      { "Set-Cookie": appSessionCookie(session.token, request, false, session.expiresAt) },
    );
  } catch (error) {
    if (error instanceof HttpError || error instanceof SyntaxError) return privateError(error);
    const code = error instanceof BtAuthIntegrationError ? error.code
      : stage === "session" ? "BT_AUTH_APP_SESSION_FAILED"
      : stage === "account" ? "BT_AUTH_ACCOUNT_REGISTRATION_FAILED" : "BT_AUTH_UNEXPECTED_FAILURE";
    // Never log request bodies, identity details, exception messages, cookies or secrets.
    console.warn("BT_AUTH_LOGIN_FAILURE", { stage, code });
    return privateJson({ error: "BT Auth could not complete sign-in.", code }, error instanceof BtAuthIntegrationError ? 503 : 500);
  }
}
