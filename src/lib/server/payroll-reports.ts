import { database, hasRole, type AppUser } from "./db";
import { authorizedEmployeeTarget, HttpError } from "./records";
import { isPayrollRecordInRange } from "@/lib/payroll-lines";
import {
  isValidPayrollReportRange, PAYROLL_REPORT_PAGE_SIZE, payrollReportFilename, payrollReportName,
  type PayrollReportAvailability, type PayrollReportEmployee,
} from "@/lib/payroll-report";
import type { Profile } from "@/lib/model";

export function requirePayrollReportUser(user: AppUser) {
  if (user.accessStatus !== "active" || !hasRole(user, "payroll")) throw new HttpError(403, "Payroll access is required.");
}

export function validatePayrollReportRange(from: string, to: string) {
  if (!isValidPayrollReportRange(from, to)) throw new HttpError(400, "Choose valid report dates with the start on or before the end.");
}

export function payrollReportUnavailableReason(hasProfile: boolean, recordCount: number) {
  if (!hasProfile) return "An employee profile is required before creating this report.";
  if (!recordCount) return "No records in the selected dates.";
  return null;
}

function readProfile(value: string | null): Profile | null {
  try { return value ? JSON.parse(value) as Profile : null; } catch { return null; }
}

export function payrollReportAvailability(
  user: AppUser, from: string, to: string,
  options: { query?: string; page?: number; onlyWithRecords?: boolean } = {},
): PayrollReportAvailability {
  requirePayrollReportUser(user);
  validatePayrollReportRange(from, to);
  const requestedPage = options.page ?? 1;
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 1_000_000) throw new HttpError(400, "Choose a valid report employee page.");
  const db = database();
  // Read complete, lightweight record metadata: no history/receipt data and no row cap.
  // The PDF line selector and these counts share the exact inclusive, all-status predicate.
  const counts = new Map<string, { tripCount: number; expenseCount: number }>();
  for (const table of ["trips", "expenses"] as const) {
    const rows = db.prepare("SELECT user_id, date FROM " + table).all() as Array<{ user_id: string; date: string }>;
    for (const row of rows) {
      if (!isPayrollRecordInRange(row.date, from, to)) continue;
      const count = counts.get(row.user_id) ?? { tripCount: 0, expenseCount: 0 };
      if (table === "trips") count.tripCount += 1; else count.expenseCount += 1;
      counts.set(row.user_id, count);
    }
  }
  // Match the active-account list already offered by Payroll; POST retains its existing target authorization.
  const people = db.prepare("SELECT u.id, u.display_name, u.email, p.profile_json FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.access_status = 'active' ORDER BY u.display_name, u.id")
    .all() as Array<{ id: string; display_name: string; email: string | null; profile_json: string | null }>;
  const all: PayrollReportEmployee[] = people.map((person) => {
    const profile = readProfile(person.profile_json);
    // BT Auth's verified upn is already persisted as displayName when no name claim is supplied.
    const reportName = payrollReportName(profile?.driverName, person.display_name);
    const count = counts.get(person.id) ?? { tripCount: 0, expenseCount: 0 };
    const recordCount = count.tripCount + count.expenseCount;
    let unavailableReason = payrollReportUnavailableReason(Boolean(profile), recordCount);
    try { authorizedEmployeeTarget(user, person.id); }
    catch (error) {
      if (!(error instanceof HttpError)) throw error;
      unavailableReason = error.message;
    }
    return { id: person.id, displayName: person.display_name, email: person.email, reportName, ...count, recordCount,
      canExport: unavailableReason === null, unavailableReason, filename: payrollReportFilename(reportName, from, to) };
  });
  const query = options.query?.trim().slice(0, 160).toLocaleLowerCase() ?? "";
  const filtered = all.filter((person) => (!options.onlyWithRecords || person.recordCount > 0)
    && (!query || (person.reportName + " " + person.displayName + " " + (person.email ?? "")).toLocaleLowerCase().includes(query)));
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAYROLL_REPORT_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  return { from, to, employees: filtered.slice((page - 1) * PAYROLL_REPORT_PAGE_SIZE, page * PAYROLL_REPORT_PAGE_SIZE),
    page, pageSize: PAYROLL_REPORT_PAGE_SIZE, total: filtered.length, totalPages, totalEmployees: all.length,
    employeesWithRecords: all.filter((person) => person.recordCount > 0).length,
    exportableEmployees: all.filter((person) => person.canExport).length };
}
