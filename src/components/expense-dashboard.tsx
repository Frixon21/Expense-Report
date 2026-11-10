"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Copy, Pencil, Trash2, X } from "lucide-react";
import {
  ReceiptViewerModal,
  ReceiptViewButton,
  type ReceiptAttachment,
} from "@/components/receipt-viewer";
import {
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  categoryLabel,
  expenseInputSchema,
  formatExpenseAmount,
  paymentMethodLabel,
  readReceiptFile,
  rotateReceiptImage,
  type Expense,
} from "@/lib/expense";
import { dateRangePresets } from "@/lib/model";
import { newId } from "@/lib/new-id";
import { useFormMemory } from "@/components/form-memory";
import PayPeriodNote from "@/components/pay-period-note";
import { today, monthStart, monthEnd } from "@/lib/date-defaults";
import {
  defaultTripMeta,
  isPayrollLocked,
  payrollLockLabel,
  type TripPayrollMeta,
} from "@/lib/demo-types";

type ExpenseForm = {
  date: string;
  category: string;
  amount: string;
  paymentMethod: string;
  merchant: string;
  businessPurpose: string;
  projectOrClient: string;
  notes: string;
};

const emptyForm = (): ExpenseForm => ({
  date: today(),
  category: "supplies",
  amount: "",
  paymentMethod: "personal_card",
  merchant: "",
  businessPurpose: "",
  projectOrClient: "",
  notes: "",
});

export default function ExpenseDashboard({
  expenses,
  onChange,
  storageError = "",
  payrollMeta = {},
  storageLabel = "Saved in this browser",
  historyContent,
  memoryUserId,
}: {
  memoryUserId?: string;
  expenses: Expense[];
  onChange: (expenses: Expense[]) => void | Promise<void>;
  storageError?: string;
  payrollMeta?: Record<string, TripPayrollMeta>;
  storageLabel?: string;
  historyContent?: ReactNode;
}) {
  const itemMeta = (expenseId: string) =>
    payrollMeta[expenseId] ?? defaultTripMeta();
  const [form, setForm] = useState<ExpenseForm>(emptyForm);
  const [duplicating, setDuplicating] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const saving = useRef(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(monthEnd);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [receiptFileName, setReceiptFileName] = useState<string | undefined>();
  const [receiptMimeType, setReceiptMimeType] = useState<string | undefined>();
  const [receiptDataUrl, setReceiptDataUrl] = useState<string | undefined>();
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [viewerReceipt, setViewerReceipt] = useState<ReceiptAttachment | null>(
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const receiptVersion = useRef(0);
  const receiptInputRef = useRef<HTMLInputElement>(null);
  const memory = useFormMemory(
    memoryUserId,
    "expense",
    form,
    setForm,
    ["category", "paymentMethod"],
    { editing, duplicating },
    (mode) => {
      if (mode.editing) {
        const saved = expenses.find((item) => item.id === mode.editing);
        if (!saved || isPayrollLocked(itemMeta(saved.id))) return false;
        setReceiptFileName(saved.receiptFileName);
        setReceiptMimeType(saved.receiptMimeType);
        setReceiptDataUrl(saved.receiptDataUrl);
      } else clearReceipt();
      setEditing(mode.editing);
      setDuplicating(mode.duplicating);
      setConfirmed(false);
      return true;
    },
  );
  const rangePresets = useMemo(() => dateRangePresets(), []);

  const visible = useMemo(
    () =>
      expenses
        .filter((item) => item.date >= from && item.date <= to)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [expenses, from, to],
  );

  const totalCents = visible.reduce((sum, item) => sum + item.amount, 0);

  const setField = (field: keyof ExpenseForm, value: string) => {
    memory.touch();
    setConfirmed(false);
    setForm((current) => ({ ...current, [field]: value }));
  };

  const clearReceipt = () => {
    receiptVersion.current++;
    setReceiptFileName(undefined);
    setReceiptMimeType(undefined);
    setReceiptDataUrl(undefined);
    if (receiptInputRef.current) receiptInputRef.current.value = "";
  };

  const reset = () => {
    memory.clear();
    setDuplicating(false);
    setConfirmed(false);
    setForm({
      ...emptyForm(),
      category: form.category,
      paymentMethod: form.paymentMethod,
    });
    setEditing(null);
    setError("");
    clearReceipt();
  };

  useEffect(() => {
    if (editing && isPayrollLocked(itemMeta(editing))) {
      reset();
      setMessage(
        "This expense was locked by payroll and can no longer be edited.",
      );
    }
  }, [editing, payrollMeta]);

  const saveExpense = async (event: FormEvent) => {
    event.preventDefault();
    if (saving.current || receiptBusy) return;
    if (duplicating && !confirmed) {
      setError("Confirm the new date and amount before saving the duplicate.");
      return;
    }
    saving.current = true;
    setSaveBusy(true);
    setError("");
    setMessage("");
    try {
      const parsed = expenseInputSchema.safeParse(form);
      if (!parsed.success) {
        setError(
          parsed.error.issues[0]?.message ?? "Check the expense details.",
        );
        return;
      }
      if (editing && isPayrollLocked(itemMeta(editing))) {
        setError(
          "This expense was locked by payroll and can no longer be edited.",
        );
        return;
      }
      const old = editing
        ? expenses.find((item) => item.id === editing)
        : undefined;
      const record: Expense = {
        id: editing ?? newId(),
        ...parsed.data,
        createdAt: old?.createdAt ?? new Date().toISOString(),
        ...(receiptDataUrl
          ? {
              receiptFileName,
              receiptMimeType,
              receiptDataUrl,
            }
          : {}),
      };
      const saveResult = onChange([
        ...expenses.filter((item) => item.id !== record.id),
        record,
      ]);
      if (saveResult && typeof saveResult.then === "function") await saveResult;
      memory.remember();
      setMessage(editing ? "Expense updated." : "Expense saved.");
      reset();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save this expense.",
      );
    } finally {
      saving.current = false;
      setSaveBusy(false);
    }
  };

  const editExpense = (expense: Expense) => {
    if (isPayrollLocked(itemMeta(expense.id))) return;
    memory.touch();
    setDuplicating(false);
    setConfirmed(false);
    setForm({
      date: expense.date,
      category: expense.category,
      amount: (expense.amount / 100).toFixed(2),
      paymentMethod: expense.paymentMethod,
      merchant: expense.merchant,
      businessPurpose: expense.businessPurpose,
      projectOrClient: expense.projectOrClient ?? "",
      notes: expense.notes ?? "",
    });
    setEditing(expense.id);
    setReceiptFileName(expense.receiptFileName);
    setReceiptMimeType(expense.receiptMimeType);
    setReceiptDataUrl(expense.receiptDataUrl);
    if (receiptInputRef.current) receiptInputRef.current.value = "";
    formRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const duplicateExpense = (expense: Expense) => {
    memory.touch();
    setEditing(null);
    setDuplicating(true);
    setConfirmed(false);
    clearReceipt();
    setError("");
    setForm({
      date: today(),
      category: expense.category,
      amount: "",
      paymentMethod: expense.paymentMethod,
      merchant: expense.merchant,
      businessPurpose: expense.businessPurpose,
      projectOrClient: expense.projectOrClient ?? "",
      notes: expense.notes ?? "",
    });
    formRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const onReceiptSelected = async (file: File | undefined) => {
    if (!file) return;
    const version = ++receiptVersion.current;
    setReceiptBusy(true);
    setError("");
    try {
      const receipt = await readReceiptFile(file);
      if (version !== receiptVersion.current) return;
      setReceiptFileName(receipt.fileName);
      setReceiptMimeType(receipt.mimeType);
      setReceiptDataUrl(receipt.dataUrl);
    } catch (err) {
      if (version !== receiptVersion.current) return;
      if (receiptInputRef.current) receiptInputRef.current.value = "";
      setError(
        err instanceof Error ? err.message : "Could not attach receipt.",
      );
    } finally {
      setReceiptBusy(false);
    }
  };

  return (
    <main className="workspace">
      <div className="page-heading">
        <div>
          <p className="section-kicker">BUSINESS EXPENSE RECORD</p>
          <h1>Expenses</h1>
          <p>Card, cash, and other reimbursable business purchases.</p>
        </div>
        <div className="storage-pill">{storageLabel}</div>
      </div>

      <section className="summary-grid expense-summary">
        <article>
          <span>Items</span>
          <strong>{visible.length}</strong>
          <small>Selected date range</small>
        </article>
        <article>
          <span>Total amount</span>
          <strong>{formatExpenseAmount(totalCents)}</strong>
          <small>Selected date range</small>
        </article>
      </section>

      {storageError && (
        <p className="error global-message" role="alert">
          {storageError}
        </p>
      )}
      {message && (
        <p className="success" role="status">
          {message}
          <button aria-label="Dismiss message" onClick={() => setMessage("")}>
            <X size={15} />
          </button>
        </p>
      )}

      <div className="dashboard-grid">
        <section className="panel trip-panel">
          <div className="section-heading">
            <span className="step">1</span>
            <div>
              <h2>{editing ? "Edit expense" : "Add an expense"}</h2>
              <p>
                Date, category, amount, payment method, and business purpose.
              </p>
            </div>
          </div>
          {memory.notice}
          <form ref={formRef} onSubmit={saveExpense}>
            <label>
              Date
              <input
                type="date"
                required
                value={form.date}
                onChange={(e) => setField("date", e.target.value)}
              />
            </label>
            <label>
              Category
              <select
                required
                value={form.category}
                onChange={(e) => setField("category", e.target.value)}
              >
                {EXPENSE_CATEGORIES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="split">
              <label>
                Amount
                <input
                  inputMode="decimal"
                  required
                  placeholder="0.00"
                  value={form.amount}
                  onChange={(e) => setField("amount", e.target.value)}
                />
              </label>
              <label>
                Paid with
                <select
                  required
                  value={form.paymentMethod}
                  onChange={(e) => setField("paymentMethod", e.target.value)}
                >
                  {PAYMENT_METHODS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Merchant or description
              <input
                required
                maxLength={200}
                value={form.merchant}
                onChange={(e) => setField("merchant", e.target.value)}
              />
            </label>
            <label>
              Business purpose
              <textarea
                required
                rows={3}
                maxLength={500}
                value={form.businessPurpose}
                onChange={(e) => setField("businessPurpose", e.target.value)}
              />
            </label>
            <label>
              Client / project / cost center <small>(optional)</small>
              <input
                maxLength={150}
                value={form.projectOrClient}
                onChange={(e) => setField("projectOrClient", e.target.value)}
              />
            </label>
            <label>
              Notes <small>(optional)</small>
              <textarea
                rows={2}
                maxLength={500}
                placeholder="Receipt #, attendees for meals, etc."
                value={form.notes}
                onChange={(e) => setField("notes", e.target.value)}
              />
            </label>
            <div className="receipt-field">
              <span className="field-label">
                Receipt attachment <small>(optional)</small>
              </span>
              <input
                ref={receiptInputRef}
                type="file"
                accept="image/*,application/pdf"
                disabled={receiptBusy}
                onChange={(e) => onReceiptSelected(e.target.files?.[0])}
              />
              {receiptDataUrl && receiptFileName && (
                <div className="receipt-attachment">
                  <span className="receipt-file-name">{receiptFileName}</span>
                  <ReceiptViewButton
                    receipt={{
                      receiptFileName,
                      receiptMimeType,
                      receiptDataUrl,
                    }}
                    label="View"
                    onOpen={setViewerReceipt}
                  />
                  {receiptMimeType?.startsWith("image/") && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={receiptBusy || saveBusy}
                      onClick={async () => {
                        const version = ++receiptVersion.current;
                        setReceiptBusy(true);
                        setError("");
                        try {
                          const rotated =
                            await rotateReceiptImage(receiptDataUrl);
                          if (version !== receiptVersion.current) return;
                          setReceiptDataUrl(rotated);
                          setReceiptMimeType("image/png");
                          setReceiptFileName(
                            receiptFileName
                              .replace(/\.[^.]+$/, "")
                              .slice(0, 196) + ".png",
                          );
                        } catch (reason) {
                          setError(
                            reason instanceof Error
                              ? reason.message
                              : "Could not rotate receipt.",
                          );
                        } finally {
                          setReceiptBusy(false);
                        }
                      }}
                    >
                      Rotate attachment
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary receipt-remove"
                    onClick={clearReceipt}
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              {duplicating && (
                <label className="duplicate-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I confirm the new date and amount for this duplicate. Attach
                  its own receipt if needed.
                </label>
              )}
              <button
                className="primary"
                type="submit"
                disabled={saveBusy || receiptBusy}
              >
                {editing ? "Update expense" : "Save expense"}
              </button>
              {(editing || duplicating) && (
                <button
                  type="button"
                  className="secondary"
                  disabled={saveBusy || receiptBusy}
                  onClick={reset}
                >
                  {duplicating ? "Cancel duplicate" : "Cancel editing"}
                </button>
              )}
            </div>
          </form>
        </section>

        <section className="panel history-panel">
          <div className="history-heading">
            <div>
              <span className="step">2</span>
              <div>
                <h2>Expense history</h2>
                <p>Filter by date and review submitted items.</p>
              </div>
            </div>
          </div>
          <div className="range-toolbar">
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
            <div className="range-presets">
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
          <PayPeriodNote from={from} to={to} />
          {from > to ? (
            <p className="empty-line">
              Choose an end date on or after the start date.
            </p>
          ) : visible.length ? (
            <div className="trip-list">
              {visible.map((expense) => {
                const locked = isPayrollLocked(itemMeta(expense.id));
                const lockLabel = payrollLockLabel(itemMeta(expense.id));
                return (
                  <article
                    className={
                      locked
                        ? "trip-row expense-row payroll-locked-row"
                        : "trip-row expense-row"
                    }
                    key={expense.id}
                  >
                    <div className="trip-date">
                      {new Date(`${expense.date}T12:00:00`).toLocaleDateString(
                        "en-US",
                        { month: "short", day: "numeric", year: "numeric" },
                      )}
                    </div>
                    <div className="trip-detail">
                      <strong>{expense.merchant}</strong>
                      <span>{categoryLabel(expense.category)}</span>
                      <small>
                        {paymentMethodLabel(expense.paymentMethod)}
                        {expense.projectOrClient
                          ? ` · ${expense.projectOrClient}`
                          : ""}
                        {expense.receiptDataUrl && expense.receiptFileName
                          ? " · Receipt"
                          : ""}
                        {lockLabel ? ` · ${lockLabel}` : ""}
                      </small>
                      {expense.receiptDataUrl && expense.receiptFileName && (
                        <ReceiptViewButton
                          receipt={{
                            receiptFileName: expense.receiptFileName,
                            receiptMimeType: expense.receiptMimeType,
                            receiptDataUrl: expense.receiptDataUrl,
                          }}
                          label="View"
                          onOpen={setViewerReceipt}
                        />
                      )}
                    </div>
                    <strong className="trip-miles">
                      {formatExpenseAmount(expense.amount)}
                    </strong>
                    <div className="row-actions">
                      <button
                        type="button"
                        aria-label={`Duplicate ${expense.merchant}`}
                        disabled={saveBusy || receiptBusy}
                        onClick={() => duplicateExpense(expense)}
                      >
                        <Copy size={15} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Edit ${expense.merchant}`}
                        disabled={locked || saveBusy || receiptBusy}
                        title={
                          locked
                            ? "Locked after payroll marked this expense processed or paid"
                            : undefined
                        }
                        onClick={() => editExpense(expense)}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${expense.merchant}`}
                        disabled={locked || saveBusy || receiptBusy}
                        title={
                          locked
                            ? "Locked after payroll marked this expense processed or paid"
                            : undefined
                        }
                        onClick={() => setDeleting(expense)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="empty">
              <h3>No expenses in this date range</h3>
              <p>Add an expense or change the dates above.</p>
            </div>
          )}
        </section>
      </div>

      {historyContent}

      <footer className="workspace-footer">
        <span>Biztech Expense Report</span>
        <span>Supports recordkeeping, not tax advice</span>
      </footer>

      <ReceiptViewerModal
        receipt={viewerReceipt}
        onClose={() => setViewerReceipt(null)}
      />

      {deleting && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
            <h2>Delete this expense?</h2>
            <p>This deletes the submitted expense and its receipt.</p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setDeleting(null)}>
                Keep expense
              </button>
              <button
                className="danger-button"
                onClick={async () => {
                  if (isPayrollLocked(itemMeta(deleting.id))) {
                    setDeleting(null);
                    return;
                  }
                  try {
                    const saveResult = onChange(
                      expenses.filter((item) => item.id !== deleting.id),
                    );
                    if (saveResult && typeof saveResult.then === "function")
                      await saveResult;
                    setDeleting(null);
                    if (editing === deleting.id) reset();
                  } catch (reason) {
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : "Could not delete this expense.",
                    );
                  }
                }}
              >
                Delete expense
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
