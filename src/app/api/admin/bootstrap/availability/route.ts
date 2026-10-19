import { currentUser } from "@/lib/server/auth";
import { firstAdminBootstrapAvailable, HttpError } from "@/lib/server/records";
import { privateError, privateJson } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await currentUser(request, true);
    if (!user) throw new HttpError(401, "Sign in to continue.");
    return privateJson({ available: firstAdminBootstrapAvailable(user) });
  } catch (error) {
    return privateError(error);
  }
}
