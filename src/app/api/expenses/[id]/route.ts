import { currentUser } from "@/lib/server/auth";
import { directOwnerExpense, ensureEmployee } from "@/lib/server/records";
import { privateError, privateJson, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    ensureEmployee(user);
    const { id } = await context.params;
    return privateJson(directOwnerExpense(user, id));
  } catch (error) {
    return privateError(error);
  }
}
