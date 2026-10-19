import { currentUser, appAuthStatus } from "@/lib/server/auth";
import { privateError, privateJson } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await currentUser(request, true);
    return privateJson(appAuthStatus(user));
  } catch (error) {
    return privateError(error);
  }
}
