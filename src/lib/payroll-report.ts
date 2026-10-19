export const PAYROLL_REPORT_PAGE_SIZE = 10;

export type PayrollReportEmployee = {
  id: string; displayName: string; email: string | null; reportName: string;
  tripCount: number; expenseCount: number; recordCount: number;
  canExport: boolean; unavailableReason: string | null; filename: string;
};

export type PayrollReportAvailability = {
  from: string; to: string; employees: PayrollReportEmployee[];
  page: number; pageSize: number; total: number; totalPages: number;
  totalEmployees: number; employeesWithRecords: number; exportableEmployees: number;
};

export function isValidPayrollReportRange(from: string, to: string) {
  const validDate = (date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const value = new Date(date + "T12:00:00Z");
    return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
  };
  return validDate(from) && validDate(to) && from <= to;
}

export function payrollReportName(profileName?: string | null, displayName?: string | null, username?: string | null) {
  return [profileName, displayName, username].find((value) => value?.trim())?.trim() || "Employee";
}

function safeName(name: string) {
  const normalized = name.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[^\p{L}\p{N}\p{M}_-]+/gu, "_").replace(/_+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  return Array.from(normalized).slice(0, 80).join("") || "Employee";
}

export function payrollReportFilename(name: string, from: string, to: string) {
  return safeName(name) + "_" + from + "_to_" + to + ".pdf";
}

export function payrollReportDisposition(filename: string) {
  const ascii = filename.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encoded;
}

export function payrollDownloadFilename(disposition: string | null, fallback: string) {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition?.match(/filename="([^"]+)"/i)?.[1];
  try {
    const candidate = encoded ? decodeURIComponent(encoded.trim()) : quoted;
    return candidate && /^[\p{L}\p{N}\p{M}_-]+_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.pdf$/u.test(candidate) ? candidate : fallback;
  } catch { return fallback; }
}
