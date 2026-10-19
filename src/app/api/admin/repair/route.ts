import { adminRepairRecord } from "@/lib/server/records";
import { privateError, privateJson, requestJson, requireProtectedMutation, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireProtectedMutation(request);
    const user = await requireUser(request);
    return privateJson(adminRepairRecord(user, await requestJson(request)));
  } catch (error) {
    return privateError(error);
  }
}
