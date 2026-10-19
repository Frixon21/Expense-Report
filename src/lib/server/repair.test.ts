import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestDatabase, getUser, setTestDatabase } from "./db";
import { adminRepairRecord, payrollSnapshot, transitionPayrollRecord } from "./records";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
const id = "11111111-1111-4111-8111-111111111111";
const created = "2026-01-01T00:00:00.000Z";
beforeEach(() => {
  db = createTestDatabase(); setTestDatabase(db);
  for (const [user, role] of [["admin", "super_admin"], ["employee", "employee"], ["payroll", "payroll"]]) {
    db.prepare("INSERT INTO users (id,issuer,subject,display_name,access_status,created_at,updated_at) VALUES (?, 'synthetic', ?, ?, 'active', ?, ?)").run(user, user, user, created, created);
    db.prepare("INSERT INTO roles (user_id,role,granted_at) VALUES (?,?,?)").run(user, role, created);
  }
  db.prepare("INSERT INTO trips (id,user_id,date,destination,business_purpose,start_tenths,end_tenths,parking_cents,tolls_cents,status,ever_processed,processed_rate_cents_per_mile,created_at,updated_at) VALUES (?, 'employee','2026-10-06','Office','Synthetic travel',100,400,100,200,'Processed',1,70,?,?)").run(id, created, created);
});
afterEach(() => { setTestDatabase(null); db.close(); });
const repair = (patch: Record<string, unknown>, reason = "Synthetic mileage correction") => adminRepairRecord(getUser(db, "admin")!, { type: "trip", id, reason, patch });

it("updates both readings atomically, retains historical date and processed rate, and audits before/after with server time", () => {
  const now = Date.now();
  repair({ start_tenths: 1000, end_tenths: 1455 });
  expect(payrollSnapshot(getUser(db, "admin")!).trips[0]).toMatchObject({ start_tenths: 1000, end_tenths: 1455, date: "2026-10-06", rateCentsPerMile: 70, reimbursementCents: 3485, status: "Processed" });
  const history = db.prepare("SELECT * FROM record_history WHERE action='admin_repair'").get()!;
  const details = JSON.parse(String(history.details_json));
  expect(details.before).toMatchObject({ start_tenths: 100, end_tenths: 400, processed_rate_cents_per_mile: 70 });
  expect(details.after).toMatchObject({ start_tenths: 1000, end_tenths: 1455, processed_rate_cents_per_mile: 70 });
  expect(Date.parse(details.repairedAt)).toBeGreaterThanOrEqual(now);
  expect(Date.parse(String(history.created_at))).toBeGreaterThanOrEqual(now);
  expect(history.reason).toBe("Synthetic mileage correction");
  expect(JSON.parse(String(db.prepare("SELECT details_json FROM audit_events WHERE event_type='record_repaired'").get()!.details_json))).toMatchObject(details);
});

it("rejects invalid readings, client timestamps, blank reasons and unauthorized roles without mutations", () => {
  for (const patch of [{ start_tenths: 500, end_tenths: 400 }, { end_tenths: -1 }, { end_tenths: 100.5 }, { end_tenths: Infinity }, { correctedAt: created }]) expect(() => repair(patch)).toThrow();
  expect(() => repair({ end_tenths: 500 }, " ")).toThrow();
  for (const user of ["employee", "payroll"]) expect(() => adminRepairRecord(getUser(db, user)!, { type: "trip", id, reason: "Synthetic", patch: { end_tenths: 500 } })).toThrow();
  expect(db.prepare("SELECT end_tenths FROM trips WHERE id=?").get(id)).toEqual({ end_tenths: 400 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM record_history").get()).toEqual({ n: 0 });
});

it("blocks paid mileage changes until Undo Paid, preserving the original rate", () => {
  transitionPayrollRecord(getUser(db, "admin")!, { type: "trip", id, action: "mark_paid" });
  expect(() => repair({ end_tenths: 500 })).toThrow("Undo Paid");
  transitionPayrollRecord(getUser(db, "admin")!, { type: "trip", id, action: "undo_paid", reason: "Synthetic payment reversal" });
  repair({ end_tenths: 500 });
  expect(payrollSnapshot(getUser(db, "admin")!).trips[0]).toMatchObject({ status: "Processed", rateCentsPerMile: 70, reimbursementCents: 3100 });
});

it("rolls back the repair and business history if required auditing fails", () => {
  db.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'Synthetic audit failure'); END");
  expect(() => repair({ end_tenths: 500 })).toThrow("Synthetic audit failure");
  expect(db.prepare("SELECT end_tenths FROM trips WHERE id=?").get(id)).toEqual({ end_tenths: 400 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM record_history").get()).toEqual({ n: 0 });
});
