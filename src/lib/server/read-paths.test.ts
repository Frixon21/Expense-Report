import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestDatabase, getUser, setTestDatabase } from "./db";
import { directOwnerExpense, loadEmployeeSnapshot, payrollRates, payrollSnapshot } from "./records";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
const now = "2026-10-20T00:00:00.000Z";
beforeEach(() => {
  db = createTestDatabase(); setTestDatabase(db);
  db.prepare("INSERT INTO users VALUES ('employee','synthetic','employee','Employee',NULL,'active',?,?)").run(now, now);
  db.prepare("INSERT INTO roles (user_id, role, granted_at) VALUES ('employee','employee',?),('employee','payroll',?)").run(now, now);
  db.prepare("INSERT INTO mileage_rates VALUES ('early','2025-01-01',70,'employee',?),('late','2026-01-01',75,'employee',?)").run(now, now);
});
afterEach(() => { vi.restoreAllMocks(); setTestDatabase(null); db.close(); });

it("keeps payroll SQL work bounded as trips grow and preserves effective and locked rates", () => {
  const insert = db.prepare("INSERT INTO trips (id,user_id,date,destination,business_purpose,start_tenths,end_tenths,parking_cents,tolls_cents,processed_rate_cents_per_mile,created_at,updated_at) VALUES (?,'employee',?,'Office','Synthetic',100,200,100,200,?,?,?)");
  const user = getUser(db, "employee")!;
  insert.run("early", "2025-06-01", null, now, now);
  insert.run("late", "2026-06-01", null, now, now);
  insert.run("locked", "2026-06-01", 65, now, now);
  insert.run("unpriced", "2024-06-01", null, now, now);
  const prepare = vi.spyOn(db, "prepare");
  const first = payrollSnapshot(user);
  const firstCount = prepare.mock.calls.length;
  for (let i = 0; i < 100; i++) insert.run("bulk-" + i, "2026-06-01", null, now, now);
  prepare.mockClear(); payrollSnapshot(user);
  expect(prepare.mock.calls.length).toBe(firstCount);
  expect(first.trips.find((trip) => trip.id === "early")).toMatchObject({ rateCentsPerMile: 70, reimbursementCents: 1000 });
  expect(first.trips.find((trip) => trip.id === "late")).toMatchObject({ rateCentsPerMile: 75, reimbursementCents: 1050 });
  expect(first.trips.find((trip) => trip.id === "locked")).toMatchObject({ rateCentsPerMile: 65, reimbursementCents: 950 });
  expect(first.trips.find((trip) => trip.id === "unpriced")).toMatchObject({ rateCentsPerMile: null, reimbursementCents: null });
  expect(() => payrollRates({ ...user, roles: ["employee"] })).toThrow("Payroll access is required");
});

it("returns authorized receipt URLs without embedding receipt bytes in metadata responses", () => {
  db.prepare("INSERT INTO expenses (id,user_id,date,category,amount,payment_method,merchant,business_purpose,receipt_file_name,receipt_mime_type,receipt_data_url,created_at,updated_at) VALUES ('expense','employee','2026-10-20','supplies',100,'cash','Shop','Synthetic','receipt.png','image/png','data:image/png;base64,YWJj',?,?)").run(now, now);
  const user = getUser(db, "employee")!;
  for (const response of [loadEmployeeSnapshot(db, user.id), payrollSnapshot(user), directOwnerExpense(user, "expense")]) {
    expect(JSON.stringify(response)).toContain("/api/expenses/expense/receipt");
    expect(JSON.stringify(response)).not.toContain("base64");
  }
});
