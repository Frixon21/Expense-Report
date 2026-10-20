import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as receipt } from "@/app/api/expenses/[id]/receipt/route";
import { createAppSession, setTestAuthenticator } from "./auth";
import { createTestDatabase, getUser, setTestDatabase } from "./db";
import { createMileageRate, loadEmployeeSnapshot, saveEmployeeSnapshot } from "./records";
import { POST as mileageReport } from "@/app/api/reports/mileage/route";
import type { DatabaseSync } from "node:sqlite";

const owner = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const now = "2026-10-20T00:00:00.000Z";
let db: DatabaseSync;
beforeEach(() => {
  db = createTestDatabase(); setTestDatabase(db);
  db.prepare("INSERT INTO users VALUES (?, 'synthetic', 'employee', 'Employee', NULL, 'active', ?, ?)").run(owner, now, now);
  db.prepare("INSERT INTO roles (user_id, role, granted_at) VALUES (?, 'employee', ?)").run(owner, now);
});
afterEach(() => { setTestAuthenticator(null); vi.unstubAllGlobals(); setTestDatabase(null); db.close(); });

it("rejects oversized sign-in bodies before forwarding credentials", async () => {
  const auth = vi.fn(async () => { throw new Error("Must not contact BT Auth"); });
  setTestAuthenticator(auth);
  const response = await login(new Request("http://localhost/api/auth/login", { method: "POST", headers: { origin: "http://localhost" }, body: JSON.stringify({ username: "synthetic", password: "synthetic", padding: "x".repeat(20 * 1024) }) }));
  expect(response.status).toBe(413); expect(auth).not.toHaveBeenCalled();
});

function submission(dataUrl: string, mimeType = "image/png") {
  return { state: { version: 1, profile: null, annualMileage: [], trips: [] }, expenses: [{ id, createdAt: now, date: "2026-10-20", category: "supplies", amount: 100, paymentMethod: "cash", merchant: "Synthetic", businessPurpose: "Synthetic", receiptFileName: "synthetic.png", receiptMimeType: mimeType, receiptDataUrl: dataUrl }] };
}

it("rejects mismatched receipt MIME declarations and malformed base64 atomically", () => {
  const user = getUser(db, owner)!;
  for (const data of [submission("data:text/html;base64,YWJj"), submission("data:image/png;base64,A===")]) {
    expect(() => saveEmployeeSnapshot(user, data)).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM expenses").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM record_history").get()).toEqual({ n: 0 });
  }
});

it("prevents changing a stored receipt to an executable content type without replacement bytes", () => {
  const user = getUser(db, owner)!;
  saveEmployeeSnapshot(user, submission("data:image/png;base64,YWJj"));
  const snapshot = loadEmployeeSnapshot(db, owner);
  snapshot.expenses[0].receiptMimeType = "text/html";
  expect(() => saveEmployeeSnapshot(user, snapshot)).toThrow();
  expect(db.prepare("SELECT receipt_mime_type FROM expenses WHERE id = ?").get(id)).toEqual({ receipt_mime_type: "image/png" });
});

it("serves legacy unsafe MIME metadata only as an attachment and supports Unicode filenames", async () => {
  saveEmployeeSnapshot(getUser(db, owner)!, submission("data:image/png;base64,YWJj"));
  db.prepare("UPDATE expenses SET receipt_mime_type = 'text/html', receipt_file_name = ? WHERE id = ?").run('領収書-été\r\n".pdf', id);
  const token = (await createAppSession(owner)).token;
  const response = await receipt(new Request("http://localhost/api/expenses/" + id + "/receipt", { headers: { cookie: "expense_report_session=" + token } }), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
  expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
  expect(response.headers.get("content-security-policy")).toBe("sandbox");
  expect(await response.text()).toBe("abc");
});

it("retains inline photo downloads and never includes receipt bytes in edit history", async () => {
  saveEmployeeSnapshot(getUser(db, owner)!, submission("data:image/png;base64,YWJj"));
  const token = (await createAppSession(owner)).token;
  const response = await receipt(new Request("http://localhost/api/expenses/" + id + "/receipt", { headers: { cookie: "expense_report_session=" + token } }), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
  expect(await response.text()).toBe("abc");
  expect(JSON.stringify(db.prepare("SELECT details_json FROM record_history").all())).not.toContain("base64");
});

it("rejects impossible calendar dates for expenses, profiles, rates, and reports", async () => {
  const user = getUser(db, owner)!;
  for (const date of ["2026-99-99", "2026-02-30", "2026-02-29"]) {
    const body = submission("data:image/png;base64,YWJj"); body.expenses[0].date = date;
    expect(() => saveEmployeeSnapshot(user, body)).toThrow();
    const profileBody = { state: { version: 1, profile: { driverName: "Employee", businessName: "Synthetic", vehicleDescription: "Car", businessUseStartDate: date }, annualMileage: [], trips: [] }, expenses: [] };
    expect(() => saveEmployeeSnapshot(user, profileBody)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => createMileageRate({ ...user, roles: ["payroll"] }, { effectiveFrom: date, centsPerMile: 70 })).toThrow();
  }
  const token = (await createAppSession(owner)).token;
  for (const [from, to] of [["2026-02-30", "2026-03-01"], ["2026-10-20", "2026-10-01"]]) {
    const response = await mileageReport(new Request("http://localhost/api/reports/mileage", { method: "POST", headers: { cookie: "expense_report_session=" + token, origin: "http://localhost" }, body: JSON.stringify({ from, to }) }));
    expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("no-store, private");
  }
  const valid = submission("data:image/png;base64,YWJj"); valid.expenses[0].date = "2024-02-29";
  expect(() => saveEmployeeSnapshot(user, valid)).not.toThrow();
});
