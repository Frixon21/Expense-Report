import { appSessionCookie, currentUser, deleteAppSession } from "@/lib/server/auth";
import { privateError, privateJson, requireProtectedMutation } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireProtectedMutation(request);
    const user = await currentUser(request, true);
    await deleteAppSession(request, user);
    return privateJson({ ok: true }, 200, { "Set-Cookie": appSessionCookie("", request, true) });
  } catch (error) {
    return privateError(error);
  }
}
