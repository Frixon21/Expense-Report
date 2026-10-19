"use client";

import { useEffect, useRef, useState } from "react";
import {
  isValidPayrollReportRange, payrollDownloadFilename,
  type PayrollReportAvailability, type PayrollReportEmployee,
} from "@/lib/payroll-report";

async function jsonResponse<T>(response: Response) {
  const value = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(value.error ?? "Could not check report availability.");
  return value as T;
}

export default function PayrollReports({ from, to, revision }: { from: string; to: string; revision: number }) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [onlyWithRecords, setOnlyWithRecords] = useState(false);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{ key: string; data?: PayrollReportAvailability; error?: string } | null>(null);
  const [downloading, setDownloading] = useState("");
  const [exportError, setExportError] = useState<{ range: string; message: string } | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const range = from + "/" + to;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const valid = isValidPayrollReportRange(from, to);
  const key = JSON.stringify([from, to, search, onlyWithRecords, page, revision, retry]);
  const current = valid && response?.key === key ? response.data : undefined;
  const availabilityError = response?.key === key ? response.error : undefined;
  const loading = valid && !current && !availabilityError;

  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ from, to, page: String(page) });
    if (search.trim()) params.set("q", search.trim());
    if (onlyWithRecords) params.set("withRecords", "true");
    void fetch("/api/reports/payroll?" + params.toString(), { cache: "no-store", signal: controller.signal })
      .then((result) => jsonResponse<PayrollReportAvailability>(result))
      .then((data) => { if (!controller.signal.aborted) setResponse({ key, data }); })
      .catch((error) => {
        if (!controller.signal.aborted) setResponse({ key, error: error instanceof Error ? error.message : "Could not check report availability." });
      });
    return () => controller.abort();
  }, [from, to, search, onlyWithRecords, page, revision, retry, valid, key]);

  useEffect(() => () => downloadController.current?.abort(), [from, to]);
  useEffect(() => { setPage(1); }, [from, to]);

  const download = async (employee: PayrollReportEmployee) => {
    if (!current || !employee.canExport || downloading) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(employee.id);
    setExportError(null);
    try {
      const result = await fetch("/api/reports/payroll", {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ employeeId: employee.id, from, to }),
      });
      if (!result.ok) await jsonResponse(result);
      if (!result.headers.get("content-type")?.includes("application/pdf")) throw new Error("The report response was not a PDF. Try again.");
      const blob = await result.blob();
      if (controller.signal.aborted || rangeRef.current !== range) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = payrollDownloadFilename(result.headers.get("content-disposition"), employee.filename);
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      if (!controller.signal.aborted) {
        setExportError({ range, message: error instanceof Error ? error.message : "Could not create the payroll PDF." });
        setRetry((value) => value + 1);
      }
    } finally {
      if (downloadController.current === controller) { downloadController.current = null; setDownloading(""); }
    }
  };

  return <div className="employee-reports">
    <div className="employee-report-toolbar">
      <button type="button" className="employee-report-toggle" aria-expanded={expanded} aria-controls="employee-report-results" onClick={() => setExpanded(!expanded)}>
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span> Employee reports
        {current && current.totalEmployees > 10 && <span className="employee-report-badge">{current.totalEmployees}</span>}
      </button>
      <label className="employee-report-search"><span className="report-sr-only">Search report employees</span><input type="search" maxLength={160} placeholder="Find employee" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); setExpanded(true); }} /></label>
      <label className="employee-report-only"><input type="checkbox" checked={onlyWithRecords} onChange={(event) => { setOnlyWithRecords(event.target.checked); setPage(1); setExpanded(true); }} /> With records</label>
    </div>
    <details id="employee-report-results" open={expanded}>
    <summary className="report-sr-only">Employee report results</summary>
    {!valid && <p className="error" role="alert">Choose valid report dates with the start on or before the end.</p>}
    {loading && <p className="payroll-empty-state" role="status">Checking employee records for these dates...</p>}
    {availabilityError && <div className="employee-report-error" role="alert"><p>{availabilityError}</p><button type="button" className="secondary" onClick={() => setRetry((value) => value + 1)}>Retry availability</button></div>}
    {exportError?.range === range && <p className="error" role="alert">{exportError.message}</p>}
    {current && <>
      {!current.total && <p className="employee-report-count" role="status">No employees match these filters.</p>}
      <ul className="employee-payroll-list employee-report-list">
        {current.employees.map((employee) => <li key={employee.id}>
          <div className="employee-report-person">
            <strong>{employee.reportName}</strong>
            <small>{employee.email ?? employee.displayName}</small>
            <span>{employee.recordCount ? employee.recordCount + (employee.recordCount === 1 ? " record" : " records") : "No records in the selected dates."}</span>
            {!employee.canExport && employee.recordCount > 0 && <small className="error">{employee.unavailableReason}</small>}
            {!employee.canExport && employee.recordCount === 0 && employee.unavailableReason !== "No records in the selected dates." && <small className="error">{employee.unavailableReason}</small>}
          </div>
          <button type="button" className="secondary" aria-label={"Payroll PDF for " + employee.reportName}
            title={employee.unavailableReason ?? "Download " + employee.filename}
            disabled={!employee.canExport || Boolean(downloading)} onClick={() => void download(employee)}>
            {downloading === employee.id ? "Preparing..." : "PDF"}
          </button>
        </li>)}
      </ul>
      {current.totalPages > 1 && <nav className="employee-report-pagination" aria-label="Report employee pages">
        <button type="button" className="secondary" disabled={current.page <= 1 || Boolean(downloading)} onClick={() => setPage(current.page - 1)}>Previous</button>
        <span>Page {current.page} of {current.totalPages} · {current.total} employees</span>
        <button type="button" className="secondary" disabled={current.page >= current.totalPages || Boolean(downloading)} onClick={() => setPage(current.page + 1)}>Next</button>
      </nav>}
    </>}
    </details>
  </div>;
}
