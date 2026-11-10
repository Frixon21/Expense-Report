import { describe, expect, it } from "vitest";
import { presentAuditEvent, type AuditEvent } from "./audit-presentation";
const row: AuditEvent = {
  id: "event",
  createdAt: "2026-10-27T12:00:00.000Z",
  eventType: "payroll_mark_paid",
  actorName: "Private payroll actor",
  actorEmail: "private@example.test",
  subjectUserId: "private-id",
  subjectName: "Private employee",
  subjectEmail: "employee@example.test",
  details: { amount: 123456, privateReason: "private-payroll-marker" },
};
describe("audit presentation without changing API permissions", () => {
  it.each([
    "payroll_mark_paid",
    "mileage_rate_created",
    "mileage_rate_correction",
    "record_repaired",
    "expense_processed",
    "unknown_future_event",
  ])(
    "conceals %s payload and identities while retaining the entry date",
    (eventType) => {
      const result = presentAuditEvent({ ...row, eventType }, false);
      expect(result).toMatchObject({
        id: row.id,
        createdAt: row.createdAt,
        payrollOnly: true,
        details: null,
        actorName: "",
        subjectName: null,
      });
      expect(JSON.stringify(result)).not.toMatch(
        /private|123456|employee@example/,
      );
    },
  );
  it.each([
    "access_request_created",
    "access_request_approved",
    "access_request_denied",
    "first_admin_bootstrap",
    "user_access_updated",
    "session_created",
    "logout",
  ])(
    "keeps administrative %s readable even when Payroll is mentioned",
    (eventType) => {
      const event = {
        ...row,
        eventType,
        details: { roles: ["super_admin", "payroll"] },
      };
      expect(presentAuditEvent(event, false)).toBe(event);
    },
  );
  it("retains full payroll details for an explicit payroll viewer without altering source rows", () => {
    expect(presentAuditEvent(row, true)).toBe(row);
    presentAuditEvent(row, false);
    expect(row.details).toEqual({
      amount: 123456,
      privateReason: "private-payroll-marker",
    });
  });
});
