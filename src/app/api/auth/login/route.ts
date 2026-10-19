import { z } from "zod";
import { appSessionCookie, authenticateWithBtAuth, BtAuthIntegrationError, createAppSession, LoginForbiddenError, LoginLockedError, LoginRateLimitedError, LoginRejectedError, registerVerifiedIdentity } from "@/lib/server/auth";
import { HttpError } from "@/lib/server/records";
import { privateError, privateJson, requestJson, requireProtectedMutation } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireProtectedMutation(request);
    const parsed = z.object({ username: z.string().trim().min(1).max(320), password: z.string().min(1).max(2000) }).safeParse(await requestJson(request));
    if (!parsed.success) throw new HttpError(400, "Enter your BT Auth username and password.");
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
    const user = registerVerifiedIdentity(identity);
    if (user.accessStatus === "disabled") throw new HttpError(403, "This Expense Report account is disabled.");
    const session = await createAppSession(user.id, identity.sessionProof);
    return privateJson(
      { authenticated: true, user: { id: user.id, displayName: user.displayName, email: user.email, accessStatus: user.accessStatus, roles: user.roles } },
      200,
      { "Set-Cookie": appSessionCookie(session.token, request, false, session.expiresAt) },
    );
  } catch (error) {
    return privateError(error);
  }
}
