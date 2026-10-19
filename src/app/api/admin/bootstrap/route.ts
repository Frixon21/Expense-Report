import { currentUser } from "@/lib/server/auth";
import { bootstrapFirstAdmin, HttpError } from "@/lib/server/records";
import { privateError, privateJson, requestJson, requireProtectedMutation } from "@/lib/server/http";
import { z } from "zod";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireProtectedMutation(request);
    const user = await currentUser(request, true);
    if (!user) throw new HttpError(401, "Sign in to continue.");
    const parsed = z.object({ token: z.string().min(1).max(500) }).safeParse(await requestJson(request));
    if (!parsed.success) throw new HttpError(400, "Enter the configured one-time bootstrap token.");
    return privateJson(bootstrapFirstAdmin(user, parsed.data.token));
  } catch (error) {
    return privateError(error);
  }
}
