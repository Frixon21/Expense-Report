import { describe, expect, it } from "vitest";
import { isValidPayrollReportRange, payrollDownloadFilename, payrollReportDisposition, payrollReportFilename, payrollReportName } from "./payroll-report";

describe("payroll PDF filenames", () => {
  const from = "2026-10-10", to = "2026-10-23";
  it("starts with the employee name and includes the inclusive date range", () => {
    expect(payrollReportFilename("Alex Pinto", from, to)).toBe("Alex_Pinto_2026-10-10_to_2026-10-23.pdf");
    expect(payrollReportName("Profile Name", "Display Name", "username")).toBe("Profile Name");
    expect(payrollReportName(" ", "Display Name", "username")).toBe("Display Name");
    expect(payrollReportName(null, "", "sample.user")).toBe("sample.user");
  });
  it("retains Unicode while removing path/header controls and unsafe separators", () => {
    const filename = payrollReportFilename('Álex / Pinto "\r\n../李\u202e', from, to);
    expect(filename).toBe("Álex_Pinto_李_2026-10-10_to_2026-10-23.pdf");
    const header = payrollReportDisposition(filename);
    expect(header).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    expect(header).not.toMatch(/[\r\n]/);
    expect(payrollDownloadFilename(header, "fallback.pdf")).toBe(filename);
  });
  it("rejects malformed or path-like download headers and uses the provided safe fallback", () => {
    const fallback = payrollReportFilename("Alex Pinto", from, to);
    expect(payrollDownloadFilename("attachment; filename*=UTF-8''%ZZ", fallback)).toBe(fallback);
    expect(payrollDownloadFilename('attachment; filename="../bad.pdf"', fallback)).toBe(fallback);
    expect(payrollDownloadFilename(null, fallback)).toBe(fallback);
  });
  it("validates real ordered dates, including same-day ranges", () => {
    expect(isValidPayrollReportRange(from, to)).toBe(true);
    expect(isValidPayrollReportRange(from, from)).toBe(true);
    expect(isValidPayrollReportRange(to, from)).toBe(false);
    expect(isValidPayrollReportRange("2026-02-30", "2026-03-01")).toBe(false);
    expect(isValidPayrollReportRange("", to)).toBe(false);
  });
});
