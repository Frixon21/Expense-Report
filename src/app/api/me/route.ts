import { after } from "next/server";
import { dispatchNotifications } from "@/lib/server/notifications";
import { loadEmployeeSnapshot, saveEmployeeSnapshot, ensureEmployee } from "@/lib/server/records";
import { database } from "@/lib/server/db";
import { MAX_EMPLOYEE_REQUEST_BYTES, privateError, privateJson, requestJson, requireProtectedMutation, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    ensureEmployee(user);
    return privateJson({ user: { id: user.id, displayName: user.displayName, email: user.email, roles: user.roles }, ...loadEmployeeSnapshot(database(), user.id) });
  } catch (error) {
    return privateError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireProtectedMutation(request);
    const user = await requireUser(request);
    ensureEmployee(user);
    const snapshot = saveEmployeeSnapshot(user, await requestJson(request, MAX_EMPLOYEE_REQUEST_BYTES));
    // Register only after the business transaction commits; never make email failure a save failure.
    try { after(() => dispatchNotifications().catch(() => console.warn("Notification dispatch unavailable."))); } catch { console.warn("Notification dispatch deferred."); }
    return privateJson(snapshot);
  } catch (error) {
    return privateError(error);
  }
}
