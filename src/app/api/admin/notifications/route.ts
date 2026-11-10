import { after } from "next/server";
import { z } from "zod";
import {
  requireUser,
  requireProtectedMutation,
  requestJson,
  privateJson,
  privateError,
} from "@/lib/server/http";
import { HttpError } from "@/lib/server/records";
import {
  notificationStatus,
  updateNotificationSettings,
  queueTestNotification,
  dispatchNotifications,
} from "@/lib/server/notifications";
export const runtime = "nodejs";
async function admin(request: Request) {
  const user = await requireUser(request);
  if (user.accessStatus !== "active" || !user.roles.includes("super_admin"))
    throw new HttpError(403, "Super admin access is required.");
  return user;
}
export async function GET(request: Request) {
  try {
    await admin(request);
    return privateJson(notificationStatus());
  } catch (error) {
    return privateError(error);
  }
}
export async function POST(request: Request) {
  try {
    requireProtectedMutation(request);
    const user = await admin(request);
    const body = z
      .object({
        action: z.enum(["save", "test", "retry"]),
        settings: z.unknown().optional(),
        requestId: z.uuid().optional(),
      })
      .parse(await requestJson(request));
    if (body.action === "save") {
      try {
        return privateJson(updateNotificationSettings(user, body.settings));
      } catch {
        throw new HttpError(400, "Check sender, recipient and review URL.");
      }
    }
    if (body.action === "test") {
      if (!body.requestId)
        throw new HttpError(400, "A test request ID is required.");
      try {
        queueTestNotification(user, body.requestId);
      } catch {
        throw new HttpError(
          400,
          "Configure the server key and approve delivery before testing.",
        );
      }
    }
    if (!notificationStatus().enabled)
      throw new HttpError(400, "Enable notifications first.");
    after(() =>
      dispatchNotifications().catch(() =>
        console.warn("Notification dispatch unavailable."),
      ),
    );
    return privateJson({ queued: true });
  } catch (error) {
    return privateError(
      error instanceof z.ZodError
        ? new HttpError(400, "Invalid notification request.")
        : error,
    );
  }
}
