import { manageUserAccess } from "@/lib/server/records";
import { privateError, privateJson, requestJson, requireProtectedMutation, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireProtectedMutation(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    return privateJson(manageUserAccess(user, id, await requestJson(request)));
  } catch (error) {
    return privateError(error);
  }
}
