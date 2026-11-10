import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import { z } from "zod";
import { database, recordAudit, withTransaction, type AppUser } from "./db";

export const notificationSchema = z.object({
  enabled: z.boolean(),
  recipient: z.email().max(254).default("Office@trustbiztech.com"),
  from: z
    .string()
    .max(254)
    .regex(/^(?:[^<>\r\n]+ <)?[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>?$/),
  reviewUrl: z
    .string()
    .max(2048)
    .regex(/^[^\u0000-\u001f\u007f]*$/)
    .pipe(z.url())
    .refine((s) => {
      const u = new URL(s);
      return (
        ["http:", "https:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !/[\u0000-\u001f\u007f]/.test(s)
      );
    }),
});
type Settings = z.infer<typeof notificationSchema>;
const defaults: Settings = {
  enabled: false,
  recipient: "Office@trustbiztech.com",
  from: "BizTech Expense Reports <Notifications@trustbiztech.com>",
  reviewUrl: "http://192.168.203.180:3001/",
};
const testRecipient = "alex@trustbiztech.com";
export function notificationSettings(): Settings {
  const row = database()
    .prepare(
      "SELECT settings_json FROM notification_settings WHERE singleton=1",
    )
    .get();
  return row
    ? notificationSchema.parse(JSON.parse(String(row.settings_json)))
    : { ...defaults };
}
export function notificationStatus() {
  return {
    ...notificationSettings(),
    testRecipient,
    keyConfigured: Boolean(process.env.RESEND_API_KEY),
    deliveryApproved: process.env.RESEND_DELIVERY_ENABLED === "true",
    counts: database()
      .prepare(
        "SELECT status, COUNT(*) AS count FROM notification_outbox GROUP BY status",
      )
      .all(),
  };
}
export function updateNotificationSettings(user: AppUser, input: unknown) {
  const settings = notificationSchema.parse(input);
  withTransaction(database(), () => {
    database()
      .prepare(
        "INSERT INTO notification_settings VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET settings_json=excluded.settings_json",
      )
      .run(JSON.stringify(settings));
    recordAudit(database(), user.id, "notification_settings_updated", user.id, {
      enabled: settings.enabled,
    });
  });
  return notificationStatus();
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
const registrationUrl = notificationSchema.shape.reviewUrl.parse(
  "http://192.168.203.238:3210/auth/local-register",
);
function payload(settings: Settings, name: string, test = false) {
  const employee = name.slice(0, 200).replace(/[\u0000-\u001f\u007f]/g, " ");
  const message = employee + " just submitted a new expense or mileage entry.";
  return {
    from: settings.from,
    to: [test ? testRecipient : settings.recipient],
    subject: "New expense or mileage entry submitted",
    html:
      "<p>" +
      escapeHtml(message) +
      '</p><p><a href="' +
      escapeHtml(settings.reviewUrl) +
      '">Review entry</a></p><p>Don&#39;t have an account? Create one here: <a href="' +
      escapeHtml(registrationUrl) +
      '">' +
      escapeHtml(registrationUrl) +
      "</a></p>",
    text:
      message +
      "\n\nReview entry: " +
      settings.reviewUrl +
      "\n\nDon't have an account? Create one here: " +
      registrationUrl,
  };
}
/** Called only inside the record transaction. Savepoint isolates notification faults from saving an expense. */
export function queueEntryNotification(
  user: AppUser,
  type: "expense" | "trip",
  id: string,
) {
  const db = database();
  db.exec("SAVEPOINT notification_intent");
  try {
    const settings = notificationSettings();
    if (settings.enabled)
      db.prepare(
        "INSERT OR IGNORE INTO notification_outbox(id,payload_json,status,next_at) VALUES (?,?,'pending',0)",
      ).run(
        `entry/${type}/${id}`,
        JSON.stringify(payload(settings, user.displayName)),
      );
    db.exec("RELEASE notification_intent");
  } catch {
    db.exec("ROLLBACK TO notification_intent; RELEASE notification_intent");
    console.warn("Notification could not be queued; entry remains saved.");
  }
}
export function queueTestNotification(user: AppUser, requestId: string) {
  const settings = notificationSettings();
  if (
    !settings.enabled ||
    !process.env.RESEND_API_KEY ||
    process.env.RESEND_DELIVERY_ENABLED !== "true"
  )
    throw new Error("Delivery is not configured and approved.");
  withTransaction(database(), () => {
    const result = database()
      .prepare(
        "INSERT OR IGNORE INTO notification_outbox(id,payload_json,status,next_at) VALUES (?,?,'pending',0)",
      )
      .run(
        `test/${user.id}/${requestId}`,
        JSON.stringify(payload(settings, "Test notification", true)),
      );
    if (result.changes)
      recordAudit(database(), user.id, "notification_test_queued", user.id);
  });
}
type Delivery = {
  id: string;
  payload_json: string;
  attempts: number;
  first_at: number | null;
};
/** Request-driven durable queue; no process timer. Admin retry and future saves drain due work. */
export async function dispatchNotifications(now = Date.now()) {
  const db = database();
  if (
    !notificationSettings().enabled ||
    process.env.RESEND_DELIVERY_ENABLED !== "true" ||
    !process.env.RESEND_API_KEY
  )
    return;
  const client = new Resend(process.env.RESEND_API_KEY);
  // Stop ambiguous retries before Resend's 24-hour idempotency window expires.
  db.prepare(
    "UPDATE notification_outbox SET status='review',error_code='retry_window_expired' WHERE status IN ('pending','sending') AND first_at IS NOT NULL AND first_at < ?",
  ).run(now - 23 * 3600_000);
  for (let i = 0; i < 10; i++) {
    if (!notificationSettings().enabled) break;
    const lease = randomUUID();
    const row = withTransaction(db, () => {
      const item = db
        .prepare(
          "SELECT id,payload_json,attempts,first_at FROM notification_outbox WHERE status IN ('pending','sending') AND next_at<=? ORDER BY rowid LIMIT 1",
        )
        .get(now) as Delivery | undefined;
      if (item)
        db.prepare(
          "UPDATE notification_outbox SET status='sending',lease=?,first_at=COALESCE(first_at,?),next_at=?,attempts=attempts+1 WHERE id=?",
        ).run(lease, now, now + 120_000, item.id);
      return item;
    });
    if (!row) break;
    let code = "network_error",
      retry = true,
      delay = Math.min(3600_000, 60_000 * 2 ** row.attempts);
    try {
      const result = await client.emails.send(JSON.parse(row.payload_json), {
        idempotencyKey: row.id,
      });
      if (!result.error && result.data?.id) {
        db.prepare(
          "UPDATE notification_outbox SET status='sent',provider_id=?,error_code=NULL WHERE id=? AND lease=?",
        ).run(result.data.id, row.id, lease);
        continue;
      }
      const status = result.error?.statusCode;
      code = status ? `provider_${status}` : "provider_unknown";
      retry = !status || status === 429 || status >= 500;
      const retryAfter = result.headers?.["retry-after"];
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const wait = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter) - now;
        if (Number.isFinite(wait)) delay = Math.max(delay, wait);
      }
    } catch {
      /* Never expose SDK messages or credentials. Timeout outcome is ambiguous; reuse same key. */
    }
    db.prepare(
      "UPDATE notification_outbox SET status=?,next_at=?,error_code=? WHERE id=? AND lease=?",
    ).run(
      retry && row.attempts < 7 ? "pending" : "review",
      now + delay,
      code,
      row.id,
      lease,
    );
  }
}
