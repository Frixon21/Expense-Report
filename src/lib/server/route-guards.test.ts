import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as employee, POST as submit } from "@/app/api/me/route";
import { GET as payroll, POST as transition } from "@/app/api/payroll/route";
import { GET as rates, POST as addRate } from "@/app/api/payroll/rates/route";
import { GET as access, POST as review } from "@/app/api/admin/access/route";
import { GET as audit } from "@/app/api/admin/audit/route";
import { POST as bootstrap } from "@/app/api/admin/bootstrap/route";
import { GET as bootstrapAvailability } from "@/app/api/admin/bootstrap/availability/route";
import { POST as repair } from "@/app/api/admin/repair/route";
import { GET as users } from "@/app/api/admin/users/route";
import { PATCH as updateUser } from "@/app/api/admin/users/[id]/route";
import { POST as mileage } from "@/app/api/reports/mileage/route";
import { GET as reports, POST as report } from "@/app/api/reports/payroll/route";
import { GET as expense } from "@/app/api/expenses/[id]/route";
import { GET as receipt } from "@/app/api/expenses/[id]/receipt/route";
import { createAppSession } from "./auth";
import { createTestDatabase, setTestDatabase } from "./db";
import type { DatabaseSync } from "node:sqlite";

const context = { params: Promise.resolve({ id: "22222222-2222-4222-8222-222222222222" }) };
const mutations = { login, logout, submit, transition, addRate, review, bootstrap, repair, mileage, report, updateUser: (request: Request) => updateUser(request, context) };
const reads = { employee, payroll, rates, access, audit, bootstrapAvailability, users, reports, expense: (request: Request) => expense(request, context), receipt: (request: Request) => receipt(request, context) };
let db: DatabaseSync;
beforeEach(() => {
  db = createTestDatabase(); setTestDatabase(db);
  vi.stubGlobal("fetch", () => { throw new Error("External requests are forbidden in guard tests"); });
});
afterEach(() => { vi.unstubAllGlobals(); setTestDatabase(null); db.close(); });

it.each([undefined, "http://foreign.example.test"])("rejects every mutation with missing/cross-site origin %s before processing a body", async (origin) => {
  for (const [name, handler] of Object.entries(mutations)) {
    const response = await handler(new Request("http://localhost/api/" + name, { method: "POST", headers: origin ? { origin } : {}, body: "{}" }));
    expect(response.status, name).toBe(403);
  }
  expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events").get()).toEqual({ n: 0 });
});

it("denies anonymous reads of all business/admin/receipt/export endpoints", async () => {
  for (const [name, handler] of Object.entries(reads)) {
    expect((await handler(new Request("http://localhost/api/" + name))).status, name).toBe(401);
  }
});

it("denies employee sessions across payroll and super-admin endpoints", async () => {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users VALUES ('employee','synthetic','employee','Employee',NULL,'active',?,?)").run(now, now);
  db.prepare("INSERT INTO roles (user_id,role,granted_at) VALUES ('employee','employee',?)").run(now);
  const token = (await createAppSession("employee")).token;
  for (const [name, handler] of Object.entries({ payroll, rates, access, audit, users, reports, transition, addRate, review, repair, report, updateUser: mutations.updateUser })) {
    const response = await handler(new Request("http://localhost/api/" + name, { method: "POST", headers: { origin: "http://localhost", cookie: "expense_report_session=" + token }, body: "{}" }));
    expect(response.status, name).toBe(403);
  }
});
