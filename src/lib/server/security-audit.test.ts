import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, getUser, setTestDatabase } from "./db";
import { HttpError, SECURITY_AUDIT_PAGE_SIZE, securityAudit } from "./records";
import type { DatabaseSync } from "node:sqlite";

describe("security audit search and pagination", () => {
  let db: DatabaseSync;
  const adminId = "audit-admin";
  const employeeId = "audit-employee";
  const createdAt = "2026-10-19T12:00:00.000Z";

  beforeEach(() => {
    db = createTestDatabase();
    setTestDatabase(db);
    db.prepare("INSERT INTO users (id, issuer, subject, display_name, email, access_status, created_at, updated_at) VALUES (?, 'https://synthetic.example.test', 'admin', 'Admin Alpha', 'admin@example.test', 'active', ?, ?)")
      .run(adminId, createdAt, createdAt);
    db.prepare("INSERT INTO users (id, issuer, subject, display_name, email, access_status, created_at, updated_at) VALUES (?, 'https://synthetic.example.test', 'employee', 'Employee Beta', 'employee@example.test', 'active', ?, ?)")
      .run(employeeId, createdAt, createdAt);
    db.prepare("INSERT INTO roles (user_id, role, granted_at) VALUES (?, 'super_admin', ?)").run(adminId, createdAt);
    db.prepare("INSERT INTO roles (user_id, role, granted_at) VALUES (?, 'employee', ?)").run(employeeId, createdAt);
    const insert = db.prepare("INSERT INTO audit_events (id, actor_id, event_type, subject_user_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (let index = 0; index < 61; index += 1) {
      const suffix = String(index).padStart(3, "0");
      insert.run("event-" + suffix, adminId, "expense_processed", employeeId, JSON.stringify({ detail: "marker-" + suffix }), createdAt);
    }
  });

  afterEach(() => {
    setTestDatabase(null);
    db.close();
  });

  it("returns every retained match newest first with bounded non-overlapping pages", () => {
    const admin = getUser(db, adminId)!;
    const first = securityAudit(admin, { page: 1 });
    const second = securityAudit(admin, { page: 2 });
    const third = securityAudit(admin, { page: 3 });

    expect(first.pageSize).toBe(SECURITY_AUDIT_PAGE_SIZE);
    expect(first.total).toBe(61);
    expect(first.totalPages).toBe(3);
    expect(first.events).toHaveLength(25);
    expect(first.events[0]?.id).toBe("event-060");
    expect(second.events[0]?.id).toBe("event-035");
    expect(third.events.map((event) => event.id)).toEqual(Array.from({ length: 11 }, (_, index) => "event-" + String(10 - index).padStart(3, "0")));
    expect(new Set([...first.events, ...second.events, ...third.events].map((event) => event.id)).size).toBe(61);

    const beyondEnd = securityAudit(admin, { page: 99 });
    expect(beyondEnd.page).toBe(3);
    expect(beyondEnd.events.map((event) => event.id)).toEqual(third.events.map((event) => event.id));
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 61 });
  });

  it("combines date, event, actor, account, and event-detail filters on the server", () => {
    const result = securityAudit(getUser(db, adminId)!, {
      page: 1,
      from: "2026-10-19",
      to: "2026-10-19",
      event: "PROCESSED",
      actor: "admin alpha",
      account: "employee@example.test",
      query: "marker-042",
    });

    expect(result.total).toBe(1);
    expect(result.events).toMatchObject([{
      id: "event-042",
      eventType: "expense_processed",
      actorName: "Admin Alpha",
      actorEmail: "admin@example.test",
      subjectName: "Employee Beta",
      subjectEmail: "employee@example.test",
      details: { detail: "marker-042" },
    }]);
  });

  it("rejects invalid filters and non-admin viewers", () => {
    const admin = getUser(db, adminId)!;
    expect(() => securityAudit(admin, { from: "2026-02-30" })).toThrow(HttpError);
    expect(() => securityAudit(admin, { from: "2026-10-20", to: "2026-10-19" })).toThrow(HttpError);
    expect(() => securityAudit(admin, { page: 0 })).toThrow(HttpError);
    expect(() => securityAudit(getUser(db, employeeId)!, {})).toThrow(HttpError);
  });
});
