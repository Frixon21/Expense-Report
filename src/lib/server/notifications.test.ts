import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDatabase, getUser, setTestDatabase } from "./db";
import {
  notificationSettings,
  notificationStatus,
  updateNotificationSettings,
  queueEntryNotification,
  queueTestNotification,
  dispatchNotifications,
} from "./notifications";
import { saveEmployeeSnapshot } from "./records";
import type { DatabaseSync } from "node:sqlite";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));
let db: DatabaseSync;
const now = Date.now();
beforeEach(() => {
  db = createTestDatabase();
  setTestDatabase(db);
  db.prepare(
    "INSERT INTO users VALUES ('test','synthetic','test','Synthetic Employee',NULL,'active',?,?)",
  ).run(new Date(now).toISOString(), new Date(now).toISOString());
  db.prepare(
    "INSERT INTO roles(user_id,role,granted_at) VALUES ('test','employee',?)",
  ).run(new Date(now).toISOString());
  send
    .mockReset()
    .mockResolvedValue({ data: { id: "synthetic-provider-id" }, error: null });
  vi.stubEnv("RESEND_API_KEY", "synthetic-never-used-key");
  vi.stubEnv("RESEND_DELIVERY_ENABLED", "true");
});
afterEach(() => {
  setTestDatabase(null);
  db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function enable() {
  updateNotificationSettings(getUser(db, "test")!, {
    ...notificationSettings(),
    enabled: true,
  });
}
function queue() {
  db.exec("BEGIN");
  queueEntryNotification(getUser(db, "test")!, "expense", "synthetic-entry");
  db.exec("COMMIT");
}
it("defaults off and never invokes provider without explicit runtime approval and key", async () => {
  queue();
  await dispatchNotifications(now);
  expect(send).not.toHaveBeenCalled();
  enable();
  queue();
  vi.stubEnv("RESEND_DELIVERY_ENABLED", "false");
  await dispatchNotifications(now);
  expect(send).not.toHaveBeenCalled();
  vi.stubEnv("RESEND_DELIVERY_ENABLED", "true");
  vi.stubEnv("RESEND_API_KEY", "");
  await dispatchNotifications(now);
  expect(send).not.toHaveBeenCalled();
  expect(JSON.stringify(notificationStatus())).not.toContain(
    "synthetic-never-used-key",
  );
});
it("sends only employee name/link as escaped HTML and plain text and permanently deduplicates", async () => {
  enable();
  queue();
  queue();
  await dispatchNotifications(now);
  await dispatchNotifications(now + 3 * 86400_000);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]).toEqual([
    {
      from: "BizTech Expense Reports <Notifications@trustbiztech.com>",
      to: ["Office@trustbiztech.com"],
      subject: "New expense or mileage entry submitted",
      html: '<p>Synthetic Employee just submitted a new expense or mileage entry.</p><p><a href="http://192.168.203.180:3001/">Review entry</a></p><p>Don&#39;t have an account? Create one here: <a href="http://192.168.203.238:3210/auth/local-register">http://192.168.203.238:3210/auth/local-register</a></p>',
      text: "Synthetic Employee just submitted a new expense or mileage entry.\n\nReview entry: http://192.168.203.180:3001/\n\nDon't have an account? Create one here: http://192.168.203.238:3210/auth/local-register",
    },
    { idempotencyKey: "entry/expense/synthetic-entry" },
  ]);
});
it("retries 429 with Retry-After using unchanged payload/key even after configuration changes", async () => {
  enable();
  queue();
  send.mockResolvedValueOnce({
    error: { statusCode: 429, message: "secret must never be stored" },
    headers: { "retry-after": "120" },
  });
  await dispatchNotifications(now);
  await dispatchNotifications(now + 60_000);
  expect(send).toHaveBeenCalledTimes(1);
  updateNotificationSettings(getUser(db, "test")!, {
    ...notificationSettings(),
    from: "changed@example.test",
  });
  await dispatchNotifications(now + 121_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(
    JSON.stringify(db.prepare("SELECT * FROM notification_outbox").all()),
  ).not.toContain("secret");
});
it("does not retry permanent provider errors or ambiguous events past the safe window", async () => {
  enable();
  queue();
  send.mockResolvedValueOnce({ error: { statusCode: 422 } });
  await dispatchNotifications(now);
  await dispatchNotifications(now + 100_000);
  expect(send).toHaveBeenCalledTimes(1);
  db.prepare(
    "UPDATE notification_outbox SET status='sending',first_at=?,next_at=0",
  ).run(now - 24 * 3600_000);
  await dispatchNotifications(now);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    db.prepare("SELECT status FROM notification_outbox").get()?.status,
  ).toBe("review");
});
it("recovers a stale lease, serializes concurrent drains and keeps one provider event", async () => {
  enable();
  queue();
  await Promise.all([dispatchNotifications(now), dispatchNotifications(now)]);
  expect(send).toHaveBeenCalledTimes(1);
  db.prepare(
    "UPDATE notification_outbox SET status='sending',next_at=?,first_at=?",
  ).run(now - 1, now - 1000);
  await dispatchNotifications(now);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
});
it("queues only newly saved expense and mileage records, not edits, retries or rejected transactions", () => {
  enable();
  const createdAt = new Date(now).toISOString();
  const expense = {
    id: randomUUID(),
    createdAt,
    date: "2026-10-28",
    category: "other",
    amount: 1234,
    paymentMethod: "cash",
    merchant: "Synthetic",
    businessPurpose: "Test",
  };
  const trip = {
    id: randomUUID(),
    createdAt,
    date: "2026-10-28",
    destination: "Synthetic",
    businessPurpose: "Test",
    start_tenths: 10,
    end_tenths: 20,
    parking_cents: 0,
    tolls_cents: 0,
  };
  const body = {
    state: {
      version: 1,
      profile: {
        driverName: "Synthetic Employee",
        businessName: "Synthetic",
        vehicleDescription: "Synthetic car",
        businessUseStartDate: "2026-01-01",
      },
      annualMileage: [],
      trips: [trip],
    },
    expenses: [expense],
  };
  saveEmployeeSnapshot(getUser(db, "test")!, body);
  saveEmployeeSnapshot(getUser(db, "test")!, body);
  expense.amount = 4567;
  saveEmployeeSnapshot(getUser(db, "test")!, body);
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get()?.n,
  ).toBe(2);
  expect(() =>
    saveEmployeeSnapshot(getUser(db, "test")!, {
      ...body,
      expenses: [{ ...expense, id: randomUUID(), amount: -1 }],
    }),
  ).toThrow();
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get()?.n,
  ).toBe(2);
});
it("keeps expense save successful if notification queue fails, and disabled periods never backfill", () => {
  enable();
  db.exec(
    "CREATE TRIGGER notification_fault BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'synthetic fault'); END",
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const expense = {
    id: randomUUID(),
    createdAt: new Date(now).toISOString(),
    date: "2026-10-28",
    category: "other",
    amount: 1,
    paymentMethod: "cash",
    merchant: "Synthetic",
    businessPurpose: "Test",
  };
  const body = {
    state: { version: 1, profile: null, annualMileage: [], trips: [] },
    expenses: [expense],
  };
  expect(() => saveEmployeeSnapshot(getUser(db, "test")!, body)).not.toThrow();
  expect(db.prepare("SELECT COUNT(*) AS n FROM expenses").get()?.n).toBe(1);
  db.exec("DROP TRIGGER notification_fault");
  saveEmployeeSnapshot(getUser(db, "test")!, body);
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get()?.n,
  ).toBe(0);
});
it("test request retries share a durable key and do not duplicate audit events", () => {
  enable();
  const id = randomUUID();
  queueTestNotification(getUser(db, "test")!, id);
  queueTestNotification(getUser(db, "test")!, id);
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get()?.n,
  ).toBe(1);
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_events WHERE event_type='notification_test_queued'",
      )
      .get()?.n,
  ).toBe(1);
});
it("does not backfill entries created while notifications are off and discards intents on transaction rollback", () => {
  const expense = {
    id: randomUUID(),
    createdAt: new Date(now).toISOString(),
    date: "2026-10-28",
    category: "other",
    amount: 1,
    paymentMethod: "cash",
    merchant: "Synthetic",
    businessPurpose: "Test",
  };
  const body = {
    state: { version: 1, profile: null, annualMileage: [], trips: [] },
    expenses: [expense],
  };
  saveEmployeeSnapshot(getUser(db, "test")!, body);
  enable();
  saveEmployeeSnapshot(getUser(db, "test")!, body);
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get()?.n,
  ).toBe(0);
  db.exec("BEGIN");
  queueEntryNotification(getUser(db, "test")!, "trip", "rolled-back");
  db.exec("ROLLBACK");
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get()?.n,
  ).toBe(0);
});
it("contains thrown transport failures and 5xx without leaking provider errors", async () => {
  enable();
  queue();
  send.mockRejectedValueOnce(new Error("sensitive transport detail"));
  await expect(dispatchNotifications(now)).resolves.toBeUndefined();
  send.mockResolvedValueOnce({ error: { statusCode: 503 } });
  await dispatchNotifications(now + 61_000);
  expect(
    db
      .prepare("SELECT status,error_code,attempts FROM notification_outbox")
      .get(),
  ).toMatchObject({
    status: "pending",
    error_code: "provider_503",
    attempts: 2,
  });
  await dispatchNotifications(now + 182_000);
  expect(send).toHaveBeenCalledTimes(3);
});
it("automatic delivery defaults to Office, and explicit test mail stays Alex", () => {
  expect(notificationSettings().recipient).toBe("Office@trustbiztech.com");
  enable();
  updateNotificationSettings(getUser(db, "test")!, {
    ...notificationSettings(),
    recipient: "Office@trustbiztech.com",
  });
  queueTestNotification(getUser(db, "test")!, randomUUID());
  const row = db.prepare("SELECT payload_json FROM notification_outbox").get();
  expect(JSON.parse(String(row?.payload_json)).to).toEqual([
    "alex@trustbiztech.com",
  ]);
});
it("escapes employee text and link attributes in HTML while preserving readable plain text", async () => {
  enable();
  const reviewUrl = `http://example.test/?q="a"&next='b'`;
  updateNotificationSettings(getUser(db, "test")!, {
    ...notificationSettings(),
    reviewUrl,
  });
  const user = {
    ...getUser(db, "test")!,
    displayName: `<img src=x onerror="bad()"> & O'Neil\n`,
  };
  db.exec("BEGIN");
  queueEntryNotification(user, "expense", "escaped");
  db.exec("COMMIT");
  await dispatchNotifications(now);
  const email = send.mock.calls[0][0];
  expect(email.html).toContain(
    "&lt;img src=x onerror=&quot;bad()&quot;&gt; &amp; O&#39;Neil",
  );
  expect(email.html).toContain(
    'href="http://example.test/?q=&quot;a&quot;&amp;next=&#39;b&#39;"',
  );
  expect(email.html).not.toContain("<img");
  expect(email.text).toContain(
    `<img src=x onerror="bad()"> & O'Neil  just submitted`,
  );
  expect(email.text).toContain(reviewUrl);
  expect(email).not.toHaveProperty("template");
});
it.each([
  "javascript:alert(1)",
  "data:text/html,bad",
  "ftp://example.test/",
  "http://user:password@example.test/",
  "http://example.test/\nfoo",
])("rejects unsafe review URL %s", (reviewUrl) => {
  expect(() =>
    updateNotificationSettings(getUser(db, "test")!, {
      ...notificationSettings(),
      reviewUrl,
    }),
  ).toThrow();
});
it("includes the exact registration link in test mail HTML and text without changing saved roles", () => {
  enable();
  const before = getUser(db, "test")!.roles;
  queueTestNotification(getUser(db, "test")!, randomUUID());
  const row = db.prepare("SELECT payload_json FROM notification_outbox").get();
  const email = JSON.parse(String(row?.payload_json));
  const url = "http://192.168.203.238:3210/auth/local-register";
  expect(new URL(url).protocol).toBe("http:");
  expect(email.html).toContain('href="' + url + '"');
  expect(email.html).toContain("Don&#39;t have an account? Create one here:");
  expect(email.text).toContain(
    "Don't have an account? Create one here: " + url,
  );
  for (const body of [email.html, email.text])
    expect(body).not.toContain(
      "App access approval is still required to review reports.",
    );
  expect(email.to).toEqual(["alex@trustbiztech.com"]);
  expect(getUser(db, "test")!.roles).toEqual(before);
});
it("preserves an existing saved recipient and queued snapshot when settings later change", () => {
  expect(notificationSettings().recipient).toBe("Office@trustbiztech.com");
  enable();
  updateNotificationSettings(getUser(db, "test")!, {
    ...notificationSettings(),
    recipient: "alex@trustbiztech.com",
  });
  expect(notificationSettings().recipient).toBe("alex@trustbiztech.com");
  queue();
  updateNotificationSettings(getUser(db, "test")!, {
    ...notificationSettings(),
    recipient: "Office@trustbiztech.com",
  });
  const row = db.prepare("SELECT payload_json FROM notification_outbox").get();
  expect(JSON.parse(String(row?.payload_json)).to).toEqual([
    "alex@trustbiztech.com",
  ]);
});
