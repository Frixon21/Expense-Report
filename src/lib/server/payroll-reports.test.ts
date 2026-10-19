import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFPage } from "pdf-lib";
import { GET, POST } from "@/app/api/reports/payroll/route";
import { createAppSession } from "./auth";
import { createTestDatabase, setTestDatabase } from "./db";
import { payrollDownloadFilename, type PayrollReportAvailability } from "@/lib/payroll-report";
import type { DatabaseSync } from "node:sqlite";

const from = "2026-10-10", to = "2026-10-23", now = "2026-10-19T12:00:00.000Z";
const profile = (name: string) => ({ driverName: name, businessName: "Synthetic Business", vehicleDescription: "Synthetic Car", businessUseStartDate: "2026-01-01" });

describe("authorized Payroll report availability and PDF export", () => {
  let db: DatabaseSync;
  function person(id: string, name: string, roles = ["employee"], driver: string | null = name) {
    db.prepare("INSERT INTO users (id, issuer, subject, display_name, email, access_status, created_at, updated_at) VALUES (?, 'https://synthetic.test', ?, ?, ?, 'active', ?, ?)")
      .run(id, id, name, id + "@example.test", now, now);
    for (const role of roles) db.prepare("INSERT INTO roles (user_id, role, granted_at) VALUES (?, ?, ?)").run(id, role, now);
    if (driver !== null) db.prepare("INSERT INTO profiles (user_id, profile_json, updated_at) VALUES (?, ?, ?)").run(id, JSON.stringify(profile(driver)), now);
  }
  function expense(id: string, owner: string, date: string, status = "Submitted", payment = "personal_card") {
    db.prepare("INSERT INTO expenses (id, user_id, date, category, amount, payment_method, merchant, business_purpose, status, ever_processed, created_at, updated_at) VALUES (?, ?, ?, 'supplies', 1000, ?, ?, 'Synthetic expense', ?, ?, ?, ?)")
      .run(id, owner, date, payment, id, status, status === "Submitted" ? 0 : 1, now, now);
  }
  function trip(id: string, owner: string, date: string, status: string) {
    db.prepare("INSERT INTO trips (id, user_id, date, destination, business_purpose, start_tenths, end_tenths, status, ever_processed, processed_rate_cents_per_mile, created_at, updated_at) VALUES (?, ?, ?, ?, 'Synthetic travel', 0, 100, ?, ?, 70, ?, ?)")
      .run(id, owner, date, id, status, status === "Submitted" ? 0 : 1, now, now);
  }
  beforeEach(() => {
    db = createTestDatabase(); setTestDatabase(db);
    person("payroll", "Payroll User", ["employee", "payroll"]);
    person("alice", "alice.username", ["employee"], "Álex Pinto");
    person("empty", "Empty Employee");
    person("no-profile", "No Profile", ["employee"], null);
    const statuses = ["Submitted", "Processed", "Paid", "Voided"];
    statuses.forEach((status, index) => {
      const day = index === 0 ? from : index === 3 ? to : "2026-10-15";
      expense("IN-" + status, "alice", day, status, status === "Voided" ? "company_card" : "personal_card");
      trip("TRIP-" + status, "alice", day, status);
    });
    expense("OUT-before", "alice", "2026-10-09"); expense("OUT-after", "alice", "2026-10-24");
    expense("NeedsProfile", "no-profile", from);
  });
  afterEach(() => { vi.restoreAllMocks(); setTestDatabase(null); db.close(); });
  async function cookie(id = "payroll") { return "expense_report_session=" + encodeURIComponent((await createAppSession(id)).token); }
  function request(path: string, session = "", method = "GET", body?: unknown) {
    return new Request("http://localhost" + path, { method, headers: { cookie: session, origin: "http://localhost", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  const path = "/api/reports/payroll?from=" + from + "&to=" + to;
  function pdfRequest(session: string, employeeId: string, dates = { from, to }) { return request("/api/reports/payroll", session, "POST", { employeeId, ...dates }); }

  it("counts the same complete inclusive, mixed-status records actually printed by the PDF", async () => {
    const session = await cookie();
    const response = await GET(request(path, session)); expect(response.status).toBe(200);
    const data = await response.json() as PayrollReportAvailability;
    expect(data.employees.find((row) => row.id === "alice")).toMatchObject({ tripCount: 4, expenseCount: 4, recordCount: 8, canExport: true, filename: "Álex_Pinto_2026-10-10_to_2026-10-23.pdf" });
    expect(data.employees.find((row) => row.id === "empty")).toMatchObject({ recordCount: 0, canExport: false, unavailableReason: "No records in the selected dates." });
    const draw = vi.spyOn(PDFPage.prototype, "drawText");
    const pdf = await POST(pdfRequest(session, "alice")); expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(payrollDownloadFilename(pdf.headers.get("content-disposition"), "fallback")).toBe("Álex_Pinto_2026-10-10_to_2026-10-23.pdf");
    expect(pdf.headers.get("content-disposition")).not.toContain("alice-payroll");
    expect((await PDFDocument.load(await pdf.arrayBuffer())).getPageCount()).toBeGreaterThan(0);
    const text = draw.mock.calls.map(([value]) => value).join(" ");
    for (const status of ["Submitted", "Processed", "Paid", "Voided"]) { expect(text).toContain("IN-" + status); expect(text).toContain("TRIP-" + status); }
    expect(text).not.toContain("OUT-before"); expect(text).not.toContain("OUT-after");
    expect(text).toContain("Unpaid"); expect(text).toContain("Paid");
  });

  it("rejects empty or profile-less exports with the same availability explanation", async () => {
    const session = await cookie();
    for (const id of ["empty", "no-profile"]) {
      const availability = await (await GET(request(path, session))).json() as PayrollReportAvailability;
      const row = availability.employees.find((employee) => employee.id === id)!;
      expect(row.canExport).toBe(false);
      const response = await POST(pdfRequest(session, id)); expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: row.unavailableReason });
    }
  });

  it("supports 100 employees with bounded server search/pagination and a records-only filter", async () => {
    for (let index = 0; index < 100; index += 1) { const suffix = String(index).padStart(3, "0"); person("large-" + suffix, "Employee " + suffix); }
    const session = await cookie();
    const first = await (await GET(request(path + "&q=Employee%200&page=1", session))).json() as PayrollReportAvailability;
    const second = await (await GET(request(path + "&q=Employee%200&page=2", session))).json() as PayrollReportAvailability;
    expect(first.total).toBe(100); expect(first.totalPages).toBe(10); expect(first.employees).toHaveLength(10);
    expect(new Set([...first.employees, ...second.employees].map((row) => row.id)).size).toBe(20);
    const filtered = await (await GET(request(path + "&withRecords=true&q=Pinto", session))).json() as PayrollReportAvailability;
    expect(filtered.total).toBe(1); expect(filtered.employees[0]?.id).toBe("alice");
  });

  it("counts records beyond the existing history response caps and includes zero-reimbursement card records", async () => {
    for (let index = 0; index < 2101; index += 1) expense("bulk-" + index, "empty", from, "Submitted", "company_card");
    const data = await (await GET(request(path, await cookie()))).json() as PayrollReportAvailability;
    expect(data.employees.find((row) => row.id === "empty")).toMatchObject({ recordCount: 2101, expenseCount: 2101, canExport: true });
  });

  it("enforces authorization for availability and export, including next-request role removal", async () => {
    expect((await GET(request(path))).status).toBe(401);
    const employee = await cookie("alice"); expect((await GET(request(path, employee))).status).toBe(403); expect((await POST(pdfRequest(employee, "empty"))).status).toBe(403);
    const session = await cookie(); db.prepare("DELETE FROM roles WHERE user_id = 'payroll' AND role = 'payroll'").run();
    expect((await GET(request(path, session))).status).toBe(403); expect((await POST(pdfRequest(session, "alice"))).status).toBe(403);
  });

  it("preserves the existing employee-role requirement for payroll's own export", async () => {
    expense("own", "payroll", from); db.prepare("DELETE FROM roles WHERE user_id = 'payroll' AND role = 'employee'").run(); const session = await cookie();
    const data = await (await GET(request(path, session))).json() as PayrollReportAvailability;
    expect(data.employees.find((row) => row.id === "payroll")).toMatchObject({ canExport: false, unavailableReason: "Employee access is required." });
    expect((await POST(pdfRequest(session, "payroll"))).status).toBe(403); expect((await POST(pdfRequest(session, "alice"))).status).toBe(200);
  });

  it("uses the verified username/display-name fallback and rejects invalid dates/pages", async () => {
    db.prepare("UPDATE profiles SET profile_json = ? WHERE user_id = 'alice'").run(JSON.stringify(profile("")));
    const session = await cookie(); const data = await (await GET(request(path, session))).json() as PayrollReportAvailability;
    expect(data.employees.find((row) => row.id === "alice")?.filename).toBe("alice_username_2026-10-10_to_2026-10-23.pdf");
    for (const dates of [{ from: "2026-02-30", to: "2026-03-01" }, { from: to, to: from }]) {
      expect((await GET(request("/api/reports/payroll?" + new URLSearchParams(dates), session))).status).toBe(400);
      expect((await POST(pdfRequest(session, "alice", dates))).status).toBe(400);
    }
    expect((await GET(request(path + "&page=0", session))).status).toBe(400);
  });
});
