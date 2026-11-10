import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createTestDatabase, setTestDatabase, type AppUser } from "./db";
import { GET, POST } from "@/app/api/admin/notifications/route";
import type { DatabaseSync } from "node:sqlite";
const state = vi.hoisted(() => ({
  user: null as AppUser | null,
  after: vi.fn(),
}));
vi.mock("next/server", () => ({ after: state.after }));
vi.mock("./http", async (original) => {
  const actual = await original<typeof import("./http")>();
  return {
    ...actual,
    requireUser: vi.fn(async () => {
      if (!state.user) throw new Error("not signed in");
      return state.user;
    }),
  };
});
let db: DatabaseSync;
beforeEach(() => {
  db = createTestDatabase();
  setTestDatabase(db);
  state.after.mockReset();
  db.prepare(
    "INSERT INTO users VALUES ('admin','synthetic','admin','Synthetic Admin',NULL,'active','now','now')",
  ).run();
  state.user = {
    id: "admin",
    issuer: "synthetic",
    subject: "admin",
    displayName: "Synthetic Admin",
    email: null,
    accessStatus: "active",
    roles: ["super_admin"],
  };
  vi.stubEnv("APP_PUBLIC_ORIGIN", "http://localhost");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("RESEND_DELIVERY_ENABLED", "false");
});
afterEach(() => {
  setTestDatabase(null);
  db.close();
  vi.unstubAllEnvs();
});
function post(body: unknown, origin = "http://localhost") {
  return POST(
    new Request("http://localhost/api/admin/notifications", {
      method: "POST",
      headers: { origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
it("allows pure super admin settings but excludes employees/payroll and rejects wrong origins", async () => {
  expect(
    (await GET(new Request("http://localhost/api/admin/notifications"))).status,
  ).toBe(200);
  state.user!.roles = ["payroll"];
  expect(
    (await GET(new Request("http://localhost/api/admin/notifications"))).status,
  ).toBe(403);
  state.user!.roles = ["employee"];
  expect((await post({ action: "retry" })).status).toBe(403);
  state.user!.roles = ["super_admin"];
  expect((await post({ action: "retry" }, "http://wrong.test")).status).toBe(
    403,
  );
});
it("validates settings, audits successful saves and blocks unconfigured tests without side effects", async () => {
  expect(
    (
      await post({
        action: "save",
        settings: {
          enabled: true,
          from: "bad\r\naddress",
          reviewUrl: "javascript:alert(1)",
        },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post({
        action: "save",
        settings: {
          enabled: false,
          from: "Notifications@trustbiztech.com",
          reviewUrl: "http://192.168.203.180:3001/",
        },
      })
    ).status,
  ).toBe(200);
  expect(
    db.prepare("SELECT event_type FROM audit_events").get()?.event_type,
  ).toBe("notification_settings_updated");
  expect(
    (await post({ action: "test", requestId: crypto.randomUUID() })).status,
  ).toBe(400);
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get()?.n,
  ).toBe(0);
  expect(state.after).not.toHaveBeenCalled();
});
