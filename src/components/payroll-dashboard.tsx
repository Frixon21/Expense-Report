"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import {
  ReceiptViewerModal,
  ReceiptViewButton,
  type ReceiptAttachment,
} from "@/components/receipt-viewer";
import {
  dateRangePresets,
  formatDollars,
  formatMiles,
  safeFilenamePart,
  totalBusinessMiles,
  type Trip,
} from "@/lib/model";
import { createPayrollEmployeeReport } from "@/lib/payroll-pdf";
import { monthStart, monthEnd } from "@/lib/date-defaults";
import { downloadBlob } from "@/lib/download";
import {
  expensesInPayrollRange,
  payrollLinesForEmployee,
  tripsInPayrollRange,
} from "@/lib/payroll-lines";
import {
  payPeriodAtIndex,
  payPeriodIndexForDate,
} from "@/lib/pay-period";
import {
  categoryLabel,
  expenseReimbursableCents,
  formatExpenseAmount,
  paymentMethodLabel,
  type Expense,
} from "@/lib/expense";
import {
  employeeExpenseMeta,
  employeeTripMeta,
  tripReimbursement,
  type DemoEmployee,
  type DemoOrg,
  type TripPayrollMeta,
} from "@/lib/demo-types";

function PayrollToggleButton({
  active,
  disabled = false,
  activeLabel,
  inactiveLabel,
  title,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  activeLabel: string;
  inactiveLabel: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${active ? "danger-button" : "secondary"} payroll-action-btn`}
      disabled={active ? undefined : disabled}
      title={active ? title : undefined}
      onClick={onClick}
    >
      {active ? activeLabel : inactiveLabel}
    </button>
  );
}

function EmployeePayrollActions({
  itemCount,
  allProcessed,
  allPaid,
  pdfBusy,
  onPdf,
  onToggleProcessed,
  onTogglePaid,
}: {
  itemCount: number;
  allProcessed: boolean;
  allPaid: boolean;
  pdfBusy: boolean;
  onPdf: () => void;
  onToggleProcessed: () => void;
  onTogglePaid: () => void;
}) {
  const disabled = itemCount === 0;
  return (
    <div className="payroll-action-bar">
      <button
        type="button"
        className="secondary payroll-action-btn"
        disabled={disabled || pdfBusy}
        onClick={onPdf}
      >
        <Download size={13} aria-hidden />
        PDF
      </button>
      <PayrollToggleButton
        active={allProcessed}
        disabled={disabled}
        activeLabel="✓ Processed"
        inactiveLabel="✓ Process all"
        title="Click to unmark all processed"
        onClick={onToggleProcessed}
      />
      <PayrollToggleButton
        active={allPaid}
        disabled={disabled || !allProcessed}
        activeLabel="✓ Paid"
        inactiveLabel="$ Pay all"
        title="Click to unmark all paid"
        onClick={onTogglePaid}
      />
    </div>
  );
}

function LinePayrollAction({
  processed,
  paid,
  onToggleProcessed,
  onTogglePaid,
}: {
  processed: boolean;
  paid: boolean;
  onToggleProcessed: () => void;
  onTogglePaid: () => void;
}) {
  return (
    <div className="payroll-action-bar payroll-action-bar-line">
      <PayrollToggleButton
        active={processed}
        activeLabel="Processed"
        inactiveLabel="Process"
        title="Click to unmark processed"
        onClick={onToggleProcessed}
      />
      <PayrollToggleButton
        active={paid}
        disabled={!processed}
        activeLabel="Paid"
        inactiveLabel="Paid"
        title="Click to unmark paid"
        onClick={onTogglePaid}
      />
    </div>
  );
}

function LinePayrollActionsCells({
  processed,
  paid,
  paidNote,
  onToggleProcessed,
  onTogglePaid,
  onPaidNoteChange,
}: {
  processed: boolean;
  paid: boolean;
  paidNote: string;
  onToggleProcessed: () => void;
  onTogglePaid: () => void;
  onPaidNoteChange: (value: string) => void;
}) {
  return (
    <>
      <td className="payroll-line-flag">
        {processed ? <span className="payroll-line-check">✓</span> : "—"}
      </td>
      <td className="payroll-line-flag">
        {paid ? <span className="payroll-line-check">✓</span> : "—"}
      </td>
      <td className="payroll-row-actions payroll-line-actions-cell">
        <div className="payroll-line-actions-stack">
          <LinePayrollAction
            processed={processed}
            paid={paid}
            onToggleProcessed={onToggleProcessed}
            onTogglePaid={onTogglePaid}
          />
          <input
            className="paid-note paid-note-full"
            placeholder="Payment note"
            value={paidNote}
            onChange={(e) => onPaidNoteChange(e.target.value)}
          />
        </div>
      </td>
    </>
  );
}

export default function PayrollDashboard({
  org,
  onChange,
  onResetDemo,
}: {
  org: DemoOrg;
  onChange: (org: DemoOrg) => void;
  onResetDemo: () => void;
}) {
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(monthEnd);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [periodIndex, setPeriodIndex] = useState<number | null>(null);
  const [viewerReceipt, setViewerReceipt] = useState<ReceiptAttachment | null>(
    null,
  );
  const [exportError, setExportError] = useState("");
  const [exportingId, setExportingId] = useState<string | null>(null);
  const rangePresets = useMemo(() => dateRangePresets(), []);
  const currentPayPeriodIndex = useMemo(() => payPeriodIndexForDate(), []);
  const autoPayPeriod = useMemo(
    () => payPeriodAtIndex(currentPayPeriodIndex),
    [currentPayPeriodIndex],
  );
  const selectedPeriodIndex = periodIndex ?? currentPayPeriodIndex;

  const applyPeriodIndex = (index: number) => {
    const safe = Math.max(0, index);
    const period = payPeriodAtIndex(safe);
    setPeriodIndex(safe);
    setFrom(period.from);
    setTo(period.to);
  };

  const rows = useMemo(() => {
    return org.employees.map((employee) => {
      const visibleTrips = tripsInPayrollRange(employee.state.trips, from, to);
      const visibleExpenses = expensesInPayrollRange(
        employee.expenses,
        from,
        to,
      );
      const payrollLines = payrollLinesForEmployee(
        employee.state.trips,
        employee.expenses,
        from,
        to,
      );
      const itemCount = visibleTrips.length + visibleExpenses.length;
      const miles = totalBusinessMiles(visibleTrips);
      const parkingTolls = visibleTrips.reduce(
        (sum, trip) => sum + trip.parking_cents + trip.tolls_cents,
        0,
      );
      const mileagePay = visibleTrips.reduce(
        (sum, trip) => sum + tripReimbursement(trip, org.dollarsPerMile),
        0,
      );
      const expenseReimburse = visibleExpenses.reduce(
        (sum, item) => sum + expenseReimbursableCents(item),
        0,
      );
      let processed = 0;
      let paid = 0;
      for (const trip of visibleTrips) {
        const meta = employeeTripMeta(employee, trip.id);
        if (meta.processed) processed += 1;
        if (meta.paid) paid += 1;
      }
      for (const item of visibleExpenses) {
        const meta = employeeExpenseMeta(employee, item.id);
        if (meta.processed) processed += 1;
        if (meta.paid) paid += 1;
      }
      return {
        employee,
        visibleTrips,
        visibleExpenses,
        payrollLines,
        itemCount,
        miles,
        parkingTolls,
        mileagePay,
        expenseReimburse,
        processed,
        paid,
      };
    });
  }, [org, from, to]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, row) => ({
        miles: acc.miles + row.miles,
        mileagePay: acc.mileagePay + row.mileagePay,
        parkingTolls: acc.parkingTolls + row.parkingTolls,
        trips: acc.trips + row.visibleTrips.length,
        expenses: acc.expenses + row.visibleExpenses.length,
        expenseReimburse: acc.expenseReimburse + row.expenseReimburse,
        items: acc.items + row.itemCount,
      }),
      {
        miles: 0,
        mileagePay: 0,
        parkingTolls: 0,
        trips: 0,
        expenses: 0,
        expenseReimburse: 0,
        items: 0,
      },
    );
  }, [rows]);

  const setRate = (value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    onChange({ ...org, dollarsPerMile: parsed });
  };

  const updateTripMeta = (
    employeeId: string,
    tripId: string,
    patch: Partial<TripPayrollMeta>,
  ) => {
    onChange({
      ...org,
      employees: org.employees.map((employee) => {
        if (employee.id !== employeeId) return employee;
        const current = employeeTripMeta(employee, tripId);
        return {
          ...employee,
          tripMeta: {
            ...employee.tripMeta,
            [tripId]: { ...current, ...patch },
          },
        };
      }),
    });
  };

  const updateExpenseMeta = (
    employeeId: string,
    expenseId: string,
    patch: Partial<TripPayrollMeta>,
  ) => {
    onChange({
      ...org,
      employees: org.employees.map((employee) => {
        if (employee.id !== employeeId) return employee;
        const current = employeeExpenseMeta(employee, expenseId);
        return {
          ...employee,
          expenseMeta: {
            ...employee.expenseMeta,
            [expenseId]: { ...current, ...patch },
          },
        };
      }),
    });
  };

  const exportEmployeePdf = async (employee: DemoEmployee) => {
    setExportError("");
    if (from > to) {
      setExportError("Choose an end date on or after the start date.");
      return;
    }
    setExportingId(employee.id);
    try {
      const bytes = await createPayrollEmployeeReport({
        employee,
        from,
        to,
        dollarsPerMile: org.dollarsPerMile,
      });
      const name = safeFilenamePart(
        employee.state.profile?.driverName ?? employee.id,
      );
      downloadBlob(
        new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
        `${name}-payroll-${from}-${to}.pdf`,
      );
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Could not export PDF.",
      );
    } finally {
      setExportingId(null);
    }
  };

  const markAllVisible = (
    employeeId: string,
    trips: Trip[],
    expenses: Expense[],
    field: "processed" | "paid",
    value: boolean,
  ) => {
    onChange({
      ...org,
      employees: org.employees.map((employee) => {
        if (employee.id !== employeeId) return employee;
        const tripMeta = { ...employee.tripMeta };
        for (const trip of trips) {
          const current = employeeTripMeta(employee, trip.id);
          tripMeta[trip.id] = { ...current, [field]: value };
        }
        const expenseMeta = { ...employee.expenseMeta };
        for (const item of expenses) {
          const current = employeeExpenseMeta(employee, item.id);
          expenseMeta[item.id] = { ...current, [field]: value };
        }
        return { ...employee, tripMeta, expenseMeta };
      }),
    });
  };

  return (
    <div className="payroll-shell">
      <div className="page-heading">
        <div>
          <p className="section-kicker">PAYROLL PREVIEW</p>
          <h1>Payroll review</h1>
          <p>
            Demo view for feedback — mileage and card/cash expenses in one
            place. Mark items processed or paid, adjust the mileage rate, and
            expand rows for line detail.
          </p>
        </div>
        <button type="button" className="secondary" onClick={onResetDemo}>
          Reset demo data
        </button>
      </div>

      {exportError && (
        <p className="error global-message" role="alert">{exportError}</p>
      )}

      <section className="payroll-controls panel">
        <div className="payroll-controls-top">
          <div className="payroll-block">
            <h3 className="payroll-block-title">Mileage reimbursement rate</h3>
            <label>
              Dollars per mile
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={org.dollarsPerMile}
                onChange={(e) => setRate(e.target.value)}
              />
            </label>
          </div>
          <div className="payroll-block payroll-block-dates">
            <h3 className="payroll-block-title">Custom date range</h3>
            <div className="range">
              <label>
                From
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </div>
          </div>
        </div>

        <div className="payroll-block">
          <h3 className="payroll-block-title">Pay period</h3>
          <div className="preset-row preset-row-pay-period">
            <button
              type="button"
              className="preset-chip"
              disabled={selectedPeriodIndex <= 0}
              onClick={() => applyPeriodIndex(selectedPeriodIndex - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="preset-chip preset-chip-payroll"
              onClick={() => applyPeriodIndex(currentPayPeriodIndex)}
            >
              Current ({autoPayPeriod.from} – {autoPayPeriod.to})
            </button>
            <button
              type="button"
              className="preset-chip"
              onClick={() => applyPeriodIndex(selectedPeriodIndex + 1)}
            >
              Next
            </button>
          </div>
        </div>

        <div className="payroll-block">
          <h3 className="payroll-block-title">Quick filters</h3>
          <div className="preset-row">
            {rangePresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="preset-chip"
                onClick={() => {
                  setFrom(preset.from);
                  setTo(preset.to);
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="summary-grid">
        <article>
          <span>Employees</span>
          <strong>{org.employees.length}</strong>
          <small>In this demo</small>
        </article>
        <article>
          <span>Items in range</span>
          <strong>{totals.items}</strong>
          <small>
            {totals.trips} trips · {totals.expenses} expenses
          </small>
        </article>
        <article>
          <span>Business miles</span>
          <strong>{formatMiles(totals.miles)}</strong>
          <small>Selected dates</small>
        </article>
        <article>
          <span>Est. mileage pay</span>
          <strong>
            {formatDollars(Math.round(totals.mileagePay * 100))}
          </strong>
          <small>
            At ${org.dollarsPerMile.toFixed(2)}/mi · parking/tolls separate
          </small>
        </article>
        <article>
          <span>Expense reimburse</span>
          <strong>{formatExpenseAmount(totals.expenseReimburse)}</strong>
          <small>Personal card & cash in range</small>
        </article>
      </section>

      <section className="panel payroll-table-wrap">
        <table className="payroll-table">
          <colgroup>
            <col className="payroll-col-toggle" />
            <col className="payroll-col-employee" />
            <col className="payroll-col-metric" />
            <col className="payroll-col-metric" />
            <col className="payroll-col-metric" />
            <col className="payroll-col-metric" />
            <col className="payroll-col-metric" />
            <col className="payroll-col-count" />
            <col className="payroll-col-count" />
            <col className="payroll-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">Employee</th>
              <th scope="col">Items</th>
              <th scope="col">Miles</th>
              <th scope="col">Mileage $</th>
              <th scope="col">Exp. reimb.</th>
              <th scope="col">Parking/tolls</th>
              <th scope="col">Processed</th>
              <th scope="col">Paid</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const open = expanded === row.employee.id;
              const allProcessed =
                row.itemCount > 0 && row.processed === row.itemCount;
              const allPaid =
                row.itemCount > 0 && row.paid === row.itemCount;
              return (
                <Fragment key={row.employee.id}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className="icon-button"
                        aria-expanded={open}
                        aria-label={`${open ? "Collapse" : "Expand"} ${row.employee.state.profile?.driverName}`}
                        onClick={() =>
                          setExpanded(open ? null : row.employee.id)
                        }
                      >
                        {open ? (
                          <ChevronDown size={16} />
                        ) : (
                          <ChevronRight size={16} />
                        )}
                      </button>
                    </td>
                    <td>
                      <strong>{row.employee.state.profile?.driverName}</strong>
                      <small>{row.employee.state.profile?.vehicleDescription}</small>
                    </td>
                    <td>{row.itemCount}</td>
                    <td>{formatMiles(row.miles)}</td>
                    <td>{formatDollars(Math.round(row.mileagePay * 100))}</td>
                    <td>{formatExpenseAmount(row.expenseReimburse)}</td>
                    <td>{formatDollars(row.parkingTolls)}</td>
                    <td>
                      {row.processed}/{row.itemCount}
                    </td>
                    <td>
                      {row.paid}/{row.itemCount}
                    </td>
                    <td className="payroll-row-actions">
                      <EmployeePayrollActions
                        itemCount={row.itemCount}
                        allProcessed={allProcessed}
                        allPaid={allPaid}
                        pdfBusy={exportingId === row.employee.id}
                        onPdf={() => exportEmployeePdf(row.employee)}
                        onToggleProcessed={() =>
                          markAllVisible(
                            row.employee.id,
                            row.visibleTrips,
                            row.visibleExpenses,
                            "processed",
                            !allProcessed,
                          )
                        }
                        onTogglePaid={() =>
                          markAllVisible(
                            row.employee.id,
                            row.visibleTrips,
                            row.visibleExpenses,
                            "paid",
                            !allPaid,
                          )
                        }
                      />
                    </td>
                  </tr>
                  {open &&
                    row.payrollLines.map((line) => {
                      if (line.kind === "mileage") {
                        const trip = line.trip;
                        const meta = employeeTripMeta(row.employee, trip.id);
                        const miles = trip.end_tenths - trip.start_tenths;
                        return (
                          <tr
                            key={`${row.employee.id}-${trip.id}`}
                            className="payroll-trip-row"
                          >
                            <td />
                            <td className="payroll-line-detail">
                              <strong>{trip.date}</strong>
                              <span className="payroll-line-type">Mileage</span>
                              <span>{trip.destination}</span>
                              <small>{trip.businessPurpose}</small>
                            </td>
                            <td className="payroll-line-metric">—</td>
                            <td className="payroll-line-metric">
                              {formatMiles(miles)}
                            </td>
                            <td className="payroll-line-metric">
                              {formatDollars(
                                Math.round(
                                  tripReimbursement(trip, org.dollarsPerMile) *
                                    100,
                                ),
                              )}
                            </td>
                            <td className="payroll-line-metric">—</td>
                            <td className="payroll-line-metric">
                              {formatDollars(
                                trip.parking_cents + trip.tolls_cents,
                              )}
                            </td>
                            <LinePayrollActionsCells
                              processed={meta.processed}
                              paid={meta.paid}
                              paidNote={meta.paidNote ?? ""}
                              onToggleProcessed={() =>
                                updateTripMeta(row.employee.id, trip.id, {
                                  processed: !meta.processed,
                                })
                              }
                              onTogglePaid={() =>
                                updateTripMeta(row.employee.id, trip.id, {
                                  paid: !meta.paid,
                                })
                              }
                              onPaidNoteChange={(value) =>
                                updateTripMeta(row.employee.id, trip.id, {
                                  paidNote: value,
                                })
                              }
                            />
                          </tr>
                        );
                      }
                      const item = line.expense;
                      const meta = employeeExpenseMeta(row.employee, item.id);
                      const reimb = expenseReimbursableCents(item);
                      return (
                        <tr
                          key={`${row.employee.id}-${item.id}`}
                          className="payroll-trip-row payroll-expense-row"
                        >
                          <td />
                          <td className="payroll-line-detail">
                            <strong>{item.date}</strong>
                            <span className="payroll-line-type">Expense</span>
                            <span>{item.merchant}</span>
                            <small>
                              {categoryLabel(item.category)} ·{" "}
                              {paymentMethodLabel(item.paymentMethod)} ·{" "}
                              {item.businessPurpose}
                            </small>
                            {item.receiptDataUrl && item.receiptFileName && (
                              <ReceiptViewButton
                                receipt={{
                                  receiptFileName: item.receiptFileName,
                                  receiptMimeType: item.receiptMimeType,
                                  receiptDataUrl: item.receiptDataUrl,
                                }}
                                label="Receipt"
                                onOpen={setViewerReceipt}
                              />
                            )}
                          </td>
                          <td className="payroll-line-metric">—</td>
                          <td className="payroll-line-metric">—</td>
                          <td className="payroll-line-metric">—</td>
                          <td className="payroll-line-metric">
                            {reimb > 0
                              ? formatExpenseAmount(reimb)
                              : formatExpenseAmount(item.amount)}
                            {reimb === 0 && (
                              <small>
                                company card
                              </small>
                            )}
                          </td>
                          <td className="payroll-line-metric">—</td>
                          <LinePayrollActionsCells
                            processed={meta.processed}
                            paid={meta.paid}
                            paidNote={meta.paidNote ?? ""}
                            onToggleProcessed={() =>
                              updateExpenseMeta(row.employee.id, item.id, {
                                processed: !meta.processed,
                              })
                            }
                            onTogglePaid={() =>
                              updateExpenseMeta(row.employee.id, item.id, {
                                paid: !meta.paid,
                              })
                            }
                            onPaidNoteChange={(value) =>
                              updateExpenseMeta(row.employee.id, item.id, {
                                paidNote: value,
                              })
                            }
                          />
                        </tr>
                      );
                    })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>

      <ReceiptViewerModal
        receipt={viewerReceipt}
        onClose={() => setViewerReceipt(null)}
      />
    </div>
  );
}
