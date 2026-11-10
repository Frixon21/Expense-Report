"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  categoryLabel,
  formatExpenseAmount,
  paymentMethodLabel,
} from "@/lib/expense";
import { formatDollars, formatMiles } from "@/lib/model";
import { dateRangePresets } from "@/lib/model";
import PayPeriodNote from "@/components/pay-period-note";
import PayrollReports from "@/components/payroll-reports";
import ActionFeedback from "@/components/action-feedback";

type RecordRow = {
  id: string;
  ownerId: string;
  ownerName: string;
  date: string;
  status: "Submitted" | "Processed" | "Paid" | "Voided";
  everProcessed: boolean;
  processedBy: string | null;
  paidBy: string | null;
  reimbursementCents: number | null;
  type: "expense" | "trip";
  label: string;
  receiptFileName?: string;
  receiptUrl?: string;
  rateCentsPerMile?: number | null;
  startTenths?: number;
  endTenths?: number;
};

type PayrollData = {
  employees: Array<{
    id: string;
    displayName: string;
    email: string | null;
    profile: { driverName?: string } | null;
  }>;
  rates: Array<{
    id: string;
    effective_from: string;
    cents_per_mile: number;
    created_at: string;
  }>;
  trips: Array<{
    id: string;
    ownerId: string;
    ownerName: string;
    date: string;
    destination: string;
    vehicleName?: string;
    vehicleId?: string;
    businessPurpose: string;
    start_tenths: number;
    end_tenths: number;
    status: RecordRow["status"];
    everProcessed: boolean;
    processedBy: string | null;
    paidBy: string | null;
    reimbursementCents: number | null;
    rateCentsPerMile: number | null;
    receiptFileName?: string;
  }>;
  expenses: Array<{
    id: string;
    ownerId: string;
    ownerName: string;
    date: string;
    category: string;
    amount: number;
    paymentMethod: string;
    merchant: string;
    businessPurpose: string;
    status: RecordRow["status"];
    everProcessed: boolean;
    processedBy: string | null;
    paidBy: string | null;
    reimbursableCents: number;
    receiptFileName?: string;
    receiptDataUrl?: string;
  }>;
  history: Array<{
    id: string;
    recordId: string;
    actorName: string;
    action: string;
    reason: string | null;
    createdAt: string;
  }>;
};

type Action = "process" | "mark_paid" | "undo_paid" | "undo_processed" | "void";

async function responseJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed.");
  return data as T;
}

export default function PayrollWorkspace({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<PayrollData | null>(null);
  const [reportRevision, setReportRevision] = useState(0);
  const [error, setError] = useState("");
  const [errorRecord, setErrorRecord] = useState("");
  const [busy, setBusy] = useState("");
  const [reason, setReason] = useState<Record<string, string>>({});
  const [correctedRate, setCorrectedRate] = useState<Record<string, string>>(
    {},
  );
  const [rateDate, setRateDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [rateValue, setRateValue] = useState("");
  const [recordSearch, setRecordSearch] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [recordFrom, setRecordFrom] = useState("");
  const [recordTo, setRecordTo] = useState("");
  const [from, setFrom] = useState(() =>
    new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      .toISOString()
      .slice(0, 10),
  );
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const reportPresets = useMemo(() => dateRangePresets(), []);

  const refresh = async () => {
    const response = await fetch("/api/payroll", { cache: "no-store" });
    const next = await responseJson<PayrollData>(response);
    setData(next);
    setReportRevision((value) => value + 1);
  };

  useEffect(() => {
    void refresh().catch((reason) =>
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not load payroll records.",
      ),
    );
  }, []);

  const recordAction = async (record: RecordRow, action: Action) => {
    setErrorRecord(record.id);
    const message = reason[record.id]?.trim() ?? "";
    if (["undo_paid", "undo_processed", "void"].includes(action) && !message) {
      setError("Enter a reason before reversing or voiding a record.");
      return;
    }
    setBusy(record.id);
    setError("");
    try {
      const response = await fetch("/api/payroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: record.type,
          id: record.id,
          action,
          reason: message || undefined,
        }),
      });
      await responseJson(response);
      await refresh();
      setReason((old) => ({ ...old, [record.id]: "" }));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not update payroll status.",
      );
    } finally {
      setBusy("");
    }
  };

  const createRate = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setErrorRecord("");
    try {
      const amount = Number(rateValue);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 10)
        throw new Error("Enter a rate from $0.01 to $10.00 per mile.");
      const response = await fetch("/api/payroll/rates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          effectiveFrom: rateDate,
          centsPerMile: Math.round(amount * 100),
        }),
      });
      await responseJson(response);
      await refresh();
      setRateValue("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not save the dated mileage rate.",
      );
    }
  };

  const correctMileageRate = async (record: RecordRow) => {
    setErrorRecord(record.id);
    const message = reason[record.id]?.trim() ?? "";
    const amount = Number(correctedRate[record.id]);
    if (!message) return setError("Enter a reason for the rate correction.");
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10)
      return setError("Enter a corrected rate from $0.01 to $10.00 per mile.");
    setBusy(record.id);
    setError("");
    try {
      const response = await fetch("/api/payroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "trip",
          id: record.id,
          action: "correct_rate",
          reason: message,
          correctedRateCentsPerMile: Math.round(amount * 100),
        }),
      });
      await responseJson(response);
      await refresh();
      setReason((old) => ({ ...old, [record.id]: "" }));
      setCorrectedRate((old) => ({ ...old, [record.id]: "" }));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not correct the processed rate.",
      );
    } finally {
      setBusy("");
    }
  };

  const rows = useMemo<RecordRow[]>(() => {
    if (!data) return [];
    return [
      ...data.trips.map((trip) => ({
        id: trip.id,
        ownerId: trip.ownerId,
        ownerName: trip.ownerName,
        date: trip.date,
        status: trip.status,
        everProcessed: trip.everProcessed,
        processedBy: trip.processedBy,
        paidBy: trip.paidBy,
        reimbursementCents: trip.reimbursementCents,
        type: "trip" as const,
        label: `${trip.destination} — ${trip.businessPurpose} | Vehicle: ${trip.vehicleName || "Legacy vehicle needs review"} (${formatMiles(trip.end_tenths - trip.start_tenths)} mi)`,
        rateCentsPerMile: trip.rateCentsPerMile,
        startTenths: trip.start_tenths,
        endTenths: trip.end_tenths,
      })),
      ...data.expenses.map((expense) => ({
        id: expense.id,
        ownerId: expense.ownerId,
        ownerName: expense.ownerName,
        date: expense.date,
        status: expense.status,
        everProcessed: expense.everProcessed,
        processedBy: expense.processedBy,
        paidBy: expense.paidBy,
        reimbursementCents: expense.reimbursableCents,
        type: "expense" as const,
        label: `${expense.merchant} — ${categoryLabel(expense.category as never)} — ${paymentMethodLabel(expense.paymentMethod as never)}${expense.paymentMethod === "company_card" ? " (no reimbursement)" : ""}`,
        receiptFileName: expense.receiptFileName,
        receiptUrl: expense.receiptDataUrl,
      })),
    ].sort((a, b) => b.date.localeCompare(a.date));
  }, [data]);
  const filteredRows = useMemo(() => {
    const query = recordSearch.trim().toLocaleLowerCase();
    return rows.filter((record) => {
      if (employeeFilter && record.ownerId !== employeeFilter) return false;
      if (statusFilter && record.status !== statusFilter) return false;
      if (typeFilter && record.type !== typeFilter) return false;
      if (recordFrom && record.date < recordFrom) return false;
      if (recordTo && record.date > recordTo) return false;
      if (
        query &&
        !(record.ownerName + " " + record.label + " " + record.id)
          .toLocaleLowerCase()
          .includes(query)
      )
        return false;
      return true;
    });
  }, [
    rows,
    recordSearch,
    employeeFilter,
    statusFilter,
    typeFilter,
    recordFrom,
    recordTo,
  ]);

  if (!data)
    return (
      <main className="workspace payroll-workspace">
        <p>{error || "Loading shared payroll records."}</p>
      </main>
    );

  return (
    <main className="workspace payroll-workspace">
      <div className="page-heading">
        <div>
          <p className="section-kicker">SHARED BUSINESS RECORDS</p>
          <h1>Payroll</h1>
          <p>
            Process mileage and expenses with saved rates and a visible audit
            trail.
          </p>
        </div>
      </div>
      <ActionFeedback
        message={error}
        onDismiss={() => {
          setError("");
          setErrorRecord("");
        }}
      />

      <div className="dashboard-grid">
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Dated mileage rates</h2>
              <p>
                Processed trips keep the rate used at processing. Corrections
                are recorded in history.
              </p>
            </div>
          </div>
          <form className="form-grid payroll-rate-form" onSubmit={createRate}>
            <label>
              Effective from
              <input
                type="date"
                required
                value={rateDate}
                onChange={(event) => setRateDate(event.target.value)}
              />
            </label>
            <label>
              Rate per mile
              <input
                inputMode="decimal"
                required
                placeholder="0.70"
                value={rateValue}
                onChange={(event) => setRateValue(event.target.value)}
              />
            </label>
            <button className="primary" type="submit">
              Add rate
            </button>
          </form>
          {data.rates.length ? (
            <ul className="payroll-rate-list">
              {data.rates.map((rate) => (
                <li key={rate.id}>
                  <time dateTime={rate.effective_from}>
                    {rate.effective_from}
                  </time>
                  <strong>{formatDollars(rate.cents_per_mile)}</strong>
                  <span>per mile</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="payroll-empty-state">
              No mileage rates have been set.
            </p>
          )}
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Payroll reports</h2>
            </div>
          </div>
          <div className="range-toolbar payroll-report-range">
            <label>
              From
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
          </div>
          <div
            className="range-presets payroll-report-presets"
            role="group"
            aria-label="Payroll report date shortcuts"
          >
            {reportPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={
                  preset.id.includes("pay-period")
                    ? "preset-chip preset-chip-payroll"
                    : "preset-chip"
                }
                onClick={() => {
                  setFrom(preset.from);
                  setTo(preset.to);
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <PayPeriodNote from={from} to={to} compact />
          <PayrollReports from={from} to={to} revision={reportRevision} />
        </section>
      </div>

      <details
        className="panel payroll-records-panel payroll-records-section"
        open
      >
        <summary className="section-heading payroll-records-summary">
          <div>
            <h2>Submitted and processed records</h2>
            <p>
              Payroll members can process their own claims. Each change records
              who made it.
            </p>
          </div>
          <span className="payroll-collapse-hint">Collapse records</span>
        </summary>
        <div className="payroll-records-content">
          <div
            className="payroll-record-filters"
            aria-label="Filter payroll records"
          >
            <label>
              Search
              <input
                type="search"
                value={recordSearch}
                onChange={(event) => setRecordSearch(event.target.value)}
                placeholder="Employee, merchant, record ID"
              />
            </label>
            <label>
              Employee
              <select
                value={employeeFilter}
                onChange={(event) => setEmployeeFilter(event.target.value)}
              >
                <option value="">All employees</option>
                {data.employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="">All statuses</option>
                <option>Submitted</option>
                <option>Processed</option>
                <option>Paid</option>
                <option>Voided</option>
              </select>
            </label>
            <label>
              Record type
              <select
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
              >
                <option value="">All record types</option>
                <option value="trip">Mileage</option>
                <option value="expense">Expense</option>
              </select>
            </label>
            <label>
              From
              <input
                type="date"
                value={recordFrom}
                onChange={(event) => setRecordFrom(event.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={recordTo}
                onChange={(event) => setRecordTo(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setRecordSearch("");
                setEmployeeFilter("");
                setStatusFilter("");
                setTypeFilter("");
                setRecordFrom("");
                setRecordTo("");
              }}
            >
              Clear filters
            </button>
          </div>
          <p className="payroll-record-count" role="status">
            Showing {filteredRows.length} of {rows.length} records
          </p>
          <div className="table-scroll">
            <table className="records-table payroll-records-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Employee</th>
                  <th>Record</th>
                  <th>Status</th>
                  <th>Reimbursement</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((record) => {
                  const last = data.history.find(
                    (item) => item.recordId === record.id,
                  );
                  const isBusy = busy === record.id;
                  const canCorrectRate =
                    record.type === "trip" &&
                    (["Processed", "Paid"].includes(record.status) ||
                      (record.status === "Submitted" && record.everProcessed));
                  const hasActions =
                    record.status !== "Voided" || isAdmin || canCorrectRate;
                  return (
                    <tr key={`${record.type}-${record.id}`}>
                      <td>{record.date}</td>
                      <td>{record.ownerName}</td>
                      <td>
                        <strong>
                          {record.type === "trip" ? "Mileage" : "Expense"}
                        </strong>
                        <br />
                        {record.label}
                        {(record.receiptUrl || last) && (
                          <details className="payroll-record-detail">
                            <summary>Receipt and latest history</summary>
                            {record.receiptUrl && (
                              <p>
                                <a
                                  href={record.receiptUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Receipt: {record.receiptFileName}
                                </a>
                              </p>
                            )}
                            {last && (
                              <small>
                                Last action: {last.action} by {last.actorName}
                                {last.reason ? " | " + last.reason : ""}
                              </small>
                            )}
                          </details>
                        )}
                      </td>
                      <td>
                        {record.status}
                        {record.type === "trip" &&
                        record.rateCentsPerMile !== null &&
                        record.rateCentsPerMile !== undefined ? (
                          <small>
                            Rate: {formatDollars(record.rateCentsPerMile)}/mi
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {record.reimbursementCents === null
                          ? "Set a rate"
                          : formatExpenseAmount(record.reimbursementCents)}
                      </td>
                      <td className="record-action-cell">
                        {hasActions ? (
                          <details
                            className="payroll-record-controls"
                            onChangeCapture={() => {
                              if (errorRecord === record.id) {
                                setError("");
                                setErrorRecord("");
                              }
                            }}
                          >
                            <summary>Actions</summary>
                            <div className="payroll-action-bar">
                              {record.status === "Submitted" && (
                                <button
                                  className="secondary"
                                  disabled={isBusy}
                                  onClick={() =>
                                    void recordAction(record, "process")
                                  }
                                >
                                  Process
                                </button>
                              )}
                              {record.status === "Processed" && (
                                <>
                                  <button
                                    className="secondary"
                                    disabled={isBusy}
                                    onClick={() =>
                                      void recordAction(record, "mark_paid")
                                    }
                                  >
                                    Mark paid
                                  </button>
                                  <button
                                    className="secondary"
                                    disabled={isBusy}
                                    onClick={() =>
                                      void recordAction(
                                        record,
                                        "undo_processed",
                                      )
                                    }
                                  >
                                    Return to submitted
                                  </button>
                                  <button
                                    className="danger-button"
                                    disabled={isBusy}
                                    onClick={() =>
                                      void recordAction(record, "void")
                                    }
                                  >
                                    Void
                                  </button>
                                </>
                              )}
                              {record.status === "Paid" && (
                                <>
                                  <button
                                    className="secondary"
                                    disabled={isBusy}
                                    onClick={() =>
                                      void recordAction(record, "undo_paid")
                                    }
                                  >
                                    Undo paid
                                  </button>
                                  <button
                                    className="danger-button"
                                    disabled={isBusy}
                                    onClick={() =>
                                      void recordAction(record, "void")
                                    }
                                  >
                                    Void
                                  </button>
                                </>
                              )}
                            </div>
                            {(["Processed", "Paid"].includes(record.status) ||
                              (record.status === "Submitted" &&
                                record.everProcessed)) && (
                              <label>
                                Reason for reversal, void, or rate correction
                                <input
                                  aria-invalid={
                                    errorRecord === record.id &&
                                    Boolean(error) &&
                                    !reason[record.id]?.trim()
                                  }
                                  aria-describedby={
                                    errorRecord === record.id && error
                                      ? "action-error-" + record.id
                                      : undefined
                                  }
                                  value={reason[record.id] ?? ""}
                                  onChange={(event) =>
                                    setReason((old) => ({
                                      ...old,
                                      [record.id]: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                            )}
                            {(isAdmin || canCorrectRate) && (
                              <AdminRepair
                                record={record}
                                isAdmin={isAdmin}
                                onSaved={refresh}
                                onError={(message) => {
                                  setErrorRecord("");
                                  setError(message);
                                }}
                                rateCorrection={
                                  canCorrectRate && (
                                    <div className="rate-correction-form">
                                      <label>
                                        Corrected $/mi
                                        <input
                                          inputMode="decimal"
                                          aria-invalid={
                                            errorRecord === record.id &&
                                            Boolean(error)
                                          }
                                          aria-describedby={
                                            errorRecord === record.id && error
                                              ? "action-error-" + record.id
                                              : undefined
                                          }
                                          value={correctedRate[record.id] ?? ""}
                                          onChange={(event) =>
                                            setCorrectedRate((old) => ({
                                              ...old,
                                              [record.id]: event.target.value,
                                            }))
                                          }
                                        />
                                      </label>
                                      <button
                                        type="button"
                                        className="secondary"
                                        disabled={isBusy}
                                        onClick={() =>
                                          void correctMileageRate(record)
                                        }
                                      >
                                        Audited rate correction
                                      </button>
                                    </div>
                                  )
                                }
                              />
                            )}
                            {error && errorRecord === record.id && (
                              <p
                                className="error action-field-error"
                                id={"action-error-" + record.id}
                              >
                                {error}
                              </p>
                            )}
                          </details>
                        ) : (
                          <span className="payroll-no-actions">
                            No actions available
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!filteredRows.length && (
                  <tr>
                    <td className="payroll-empty-cell" colSpan={6}>
                      {rows.length
                        ? "No records match these filters."
                        : "No employee records are available yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </main>
  );
}

function AdminRepair({
  record,
  onSaved,
  onError,
  isAdmin,
  rateCorrection,
}: {
  record: RecordRow;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
  isAdmin: boolean;
  rateCorrection?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const reportError = (message: string) => {
    setLocalError(message);
    onError(message);
  };
  const [mileageMode, setMileageMode] = useState<"total" | "odometer">("total");
  const [miles, setMiles] = useState(
    String(((record.endTenths ?? 0) - (record.startTenths ?? 0)) / 10),
  );
  const [start, setStart] = useState(String((record.startTenths ?? 0) / 10));
  const [end, setEnd] = useState(String((record.endTenths ?? 0) / 10));
  const mileageValue = (value: string) =>
    /^\d{1,8}(\.\d)?$/.test(value.trim())
      ? Math.round(Number(value) * 10)
      : NaN;
  const startTenths =
    mileageMode === "total" ? (record.startTenths ?? 0) : mileageValue(start);
  const endTenths =
    mileageMode === "total"
      ? startTenths + mileageValue(miles)
      : mileageValue(end);
  const validMileage =
    Number.isSafeInteger(startTenths) &&
    Number.isSafeInteger(endTenths) &&
    startTenths >= 0 &&
    endTenths >= startTenths;

  useEffect(() => {
    setMiles(
      String(((record.endTenths ?? 0) - (record.startTenths ?? 0)) / 10),
    );
    setStart(String((record.startTenths ?? 0) / 10));
    setEnd(String((record.endTenths ?? 0) / 10));
  }, [record.startTenths, record.endTenths]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    onError("");
    if (!reason.trim())
      return reportError("An audited repair requires a reason.");
    const patch: Record<string, unknown> = {};
    if (record.type === "trip" && record.status !== "Paid") {
      if (!validMileage)
        return reportError(
          "Use nonnegative readings with at most one decimal; end must be at least start.",
        );
      if (
        startTenths !== record.startTenths ||
        endTenths !== record.endTenths
      ) {
        patch.start_tenths = startTenths;
        patch.end_tenths = endTenths;
      }
    }
    if (date) patch.date = date;
    if (description.trim())
      patch[record.type === "trip" ? "destination" : "merchant"] =
        description.trim();
    if (amount && record.type === "expense") {
      const cents = Math.round(Number(amount) * 100);
      if (!Number.isFinite(cents) || cents < 0)
        return reportError("Enter a valid corrected amount.");
      patch.amount = cents;
    }
    if (!Object.keys(patch).length)
      return reportError("Enter at least one field to correct.");
    setBusy(true);
    try {
      const response = await fetch("/api/admin/repair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: record.type,
          id: record.id,
          reason: reason.trim(),
          patch,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Repair failed.");
      await onSaved();
      setReason("");
      setDate("");
      setAmount("");
      setDescription("");
    } catch (error) {
      reportError(
        error instanceof Error
          ? error.message
          : "Could not repair this record.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="admin-repair">
      <summary>Audited repair</summary>
      {rateCorrection && (
        <details className="repair-rate-details">
          <summary>Rate correction</summary>
          {rateCorrection}
        </details>
      )}
      {isAdmin && (
        <form
          className="form-grid admin-repair-form"
          noValidate
          onChangeCapture={() => {
            if (localError) {
              setLocalError("");
              onError("");
            }
          }}
          onSubmit={(event) => void submit(event)}
        >
          {record.type === "trip" &&
            (record.status === "Paid" ? (
              <small>Undo Paid before changing mileage.</small>
            ) : (
              <div className="repair-mileage">
                <label>
                  Mileage entry
                  <select
                    aria-label="Mileage entry"
                    value={mileageMode}
                    onChange={(event) =>
                      setMileageMode(event.target.value as "total" | "odometer")
                    }
                  >
                    <option value="total">Total miles</option>
                    <option value="odometer">Odometer</option>
                  </select>
                </label>
                {mileageMode === "total" ? (
                  <label>
                    Total miles
                    <input
                      inputMode="decimal"
                      value={miles}
                      onChange={(event) => setMiles(event.target.value)}
                    />
                  </label>
                ) : (
                  <div className="repair-odometer">
                    <label>
                      Odometer start
                      <input
                        inputMode="decimal"
                        value={start}
                        onChange={(event) => setStart(event.target.value)}
                      />
                    </label>
                    <label>
                      Odometer end
                      <input
                        inputMode="decimal"
                        value={end}
                        onChange={(event) => setEnd(event.target.value)}
                      />
                    </label>
                  </div>
                )}
                <output className={validMileage ? "repair-distance" : "error"}>
                  {validMileage
                    ? formatMiles(endTenths - startTenths) + " mi"
                    : "Check readings"}
                </output>
              </div>
            ))}
          <details className="repair-record-details">
            <summary>Record details</summary>
            <label>
              {record.type === "trip" ? "Trip date" : "Expense date"}
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label>
              {record.type === "trip" ? "Destination" : "Merchant"}
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
          </details>
          {record.type === "expense" && (
            <label>
              Corrected amount
              <input
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
          )}
          <label>
            Repair reason
            <input
              required
              aria-invalid={Boolean(localError) && !reason.trim()}
              aria-describedby={
                localError ? "repair-error-" + record.id : undefined
              }
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {localError && (
            <p
              className="error action-field-error"
              id={"repair-error-" + record.id}
            >
              {localError}
            </p>
          )}
          <button className="secondary" type="submit" disabled={busy}>
            Save repair
          </button>
        </form>
      )}
    </details>
  );
}
