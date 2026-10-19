import { managedUsers } from "@/lib/server/records";
import { privateError, privateJson, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return privateJson({ users: managedUsers(user) });
  } catch (error) {
    return privateError(error);
  }
}
