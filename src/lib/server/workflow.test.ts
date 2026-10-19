import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDatabase, getUser, setTestDatabase } from "./db";
import { createAppSession, registerVerifiedIdentity } from "./auth";
import { createMileageRate, manageUserAccess, reviewAccessRequest, securityAudit } from "./records";
import { GET as own, POST as submit } from "@/app/api/me/route";
import { POST as action, GET as payroll } from "@/app/api/payroll/route";
import { GET as receipt } from "@/app/api/expenses/[id]/receipt/route";
import { POST as pdf } from "@/app/api/reports/payroll/route";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
beforeEach(() => { db = createTestDatabase(); setTestDatabase(db); });
afterEach(() => { setTestDatabase(null); db.close(); });
const request = (path: string, token: string, body?: unknown) => new Request("http://localhost" + path, { method: body === undefined ? "GET" : "POST", headers: { cookie: "expense_report_session=" + token, origin: "http://localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

it("runs pending approval, employee submission, payroll attribution, reversal, PDF, history and immediate access removal through authorized APIs", async () => {
  const make = (name: string) => registerVerifiedIdentity({ issuer: "https://synthetic.example.test", subject: name, displayName: name, email: name + "@example.test" });
  const admin = make("admin"); db.prepare("UPDATE users SET access_status='active' WHERE id=?").run(admin.id); db.prepare("INSERT INTO roles(user_id,role,granted_at) VALUES (?,'super_admin',?)").run(admin.id, new Date().toISOString());
  const employee = make("employee"), pay = make("payroll");
  const employeeSession = await createAppSession(employee.id), paySession = await createAppSession(pay.id);
  expect((await own(request("/api/me", employeeSession.token))).status).toBe(401);
  for (const target of [employee, pay]) {
    const pending = db.prepare("SELECT id FROM access_requests WHERE user_id=?").get(target.id)!;
    reviewAccessRequest(getUser(db, admin.id)!, { requestId: pending.id, decision: "approve", grantPayroll: target.id === pay.id });
  }
  const profile = { driverName: "Synthetic Employee", businessName: "Synthetic Business", vehicleDescription: "Synthetic Car", businessUseStartDate: "2026-01-01" };
  const tripId = randomUUID(), expenseId = randomUUID(), cardId = randomUUID();
  const state = { version: 1, profile, annualMileage: [], trips: [{ id: tripId, createdAt: new Date().toISOString(), date: "2026-10-10", destination: "Synthetic office", businessPurpose: "Synthetic trip", start_tenths: 100, end_tenths: 200, parking_cents: 0, tolls_cents: 0 }] };
  const expense = { id: expenseId, createdAt: new Date().toISOString(), date: "2026-10-23", category: "supplies", amount: 4250, paymentMethod: "personal_card", merchant: "Synthetic merchant", businessPurpose: "Synthetic supplies", receiptFileName: "synthetic.pdf", receiptMimeType: "application/pdf", receiptDataUrl: "data:application/pdf;base64," + Buffer.from("%PDF-1.4\nSynthetic receipt\n%%EOF").toString("base64") };
  expect((await submit(request("/api/me", employeeSession.token, { state, expenses: [expense, { ...expense, id: cardId, paymentMethod: "company_card" }] }))).status).toBe(200);
  expect((await action(request("/api/payroll", employeeSession.token, { type: "trip", id: tripId, action: "process" }))).status).toBe(403);
  const another = make("another"); reviewAccessRequest(getUser(db, admin.id)!, { requestId: db.prepare("SELECT id FROM access_requests WHERE user_id=?").get(another.id)!.id, decision: "approve" }); const otherSession = await createAppSession(another.id);
  expect((await receipt(request("/api/expenses/" + expenseId + "/receipt", otherSession.token), { params: Promise.resolve({ id: expenseId }) })).status).toBe(404);
  expect((await receipt(request("/api/expenses/" + expenseId + "/receipt", employeeSession.token), { params: Promise.resolve({ id: expenseId }) })).status).toBe(200);
  createMileageRate(getUser(db, pay.id)!, { effectiveFrom: "2026-10-01", centsPerMile: 70 });
  for (const [type, id] of [["trip", tripId], ["expense", expenseId], ["expense", cardId]]) expect((await action(request("/api/payroll", paySession.token, { type, id, action: "process" }))).status).toBe(200);
  const snapshot = await (await payroll(request("/api/payroll", paySession.token))).json();
  expect(snapshot.expenses.find((row: { id: string }) => row.id === cardId)).toMatchObject({ reimbursableCents: 0, processedBy: pay.id });
  expect((await action(request("/api/payroll", paySession.token, { type: "trip", id: tripId, action: "mark_paid" }))).status).toBe(200);
  expect((await action(request("/api/payroll", paySession.token, { type: "trip", id: tripId, action: "undo_paid" }))).status).toBe(400);
  for (const step of ["undo_paid", "undo_processed"]) expect((await action(request("/api/payroll", paySession.token, { type: "trip", id: tripId, action: step, reason: "Synthetic reversal" }))).status).toBe(200);
  expect(db.prepare("SELECT status,processed_rate_cents_per_mile FROM trips WHERE id=?").get(tripId)).toEqual({ status: "Submitted", processed_rate_cents_per_mile: 70 });
  const report = await pdf(request("/api/reports/payroll", paySession.token, { employeeId: employee.id, from: "2026-10-10", to: "2026-10-23" })); expect(report.status).toBe(200); expect(report.headers.get("content-type")).toContain("application/pdf");
  expect((await (await own(request("/api/me", employeeSession.token))).json()).history.some((item: { action: string }) => item.action === "undo_processed")).toBe(true);
  expect(securityAudit(getUser(db, admin.id)!, {}).total).toBeGreaterThan(0);
  manageUserAccess(getUser(db, admin.id)!, pay.id, { roles: ["employee"] }); expect((await payroll(request("/api/payroll", paySession.token))).status).toBe(403);
  manageUserAccess(getUser(db, admin.id)!, employee.id, { accessStatus: "disabled" }); expect((await own(request("/api/me", employeeSession.token))).status).toBe(401);
});
