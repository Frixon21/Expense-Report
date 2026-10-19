import { timingSafeEqual, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { expenseRecordSchema, MAX_RECEIPT_BYTES, type Expense } from "@/lib/expense";
import { mileageStateSchema, tripRecordSchema, type MileageState, type Trip } from "@/lib/model";
import { database, getUser, hasRole, recordAudit, recordHistory, withTransaction, type AppUser, type Role } from "./db";

const employeeSubmissionSchema = z.object({
  state: mileageStateSchema,
  expenses: z.array(expenseRecordSchema).max(1000),
  removeReceiptIds: z.array(z.string().uuid()).optional().default([]),
});

type DbExpense = {
  id: string;
  user_id: string;
  date: string;
  category: Expense["category"];
  amount: number;
  payment_method: Expense["paymentMethod"];
  merchant: string;
  business_purpose: string;
  project_or_client: string | null;
  notes: string | null;
  receipt_file_name: string | null;
  receipt_mime_type: string | null;
  receipt_data_url: string | null;
  status: RecordStatus;
  ever_processed: number;
  processed_by: string | null;
  paid_by: string | null;
  created_at: string;
  updated_at: string;
};

type DbTrip = {
  id: string;
  user_id: string;
  date: string;
  destination: string;
  business_purpose: string;
  start_tenths: number;
  end_tenths: number;
  parking_cents: number;
  tolls_cents: number;
  status: RecordStatus;
  ever_processed: number;
  processed_rate_cents_per_mile: number | null;
  processed_by: string | null;
  paid_by: string | null;
  created_at: string;
  updated_at: string;
};

export type RecordStatus = "Submitted" | "Processed" | "Paid" | "Voided";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function nonEmptyChange<T>(oldValue: T, newValue: T) {
  return JSON.stringify(oldValue) !== JSON.stringify(newValue);
}

function assertReceiptDataUrl(value: string, mimeType: string | undefined) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]*)$/s.exec(value);
  if (!match) throw new HttpError(400, "Receipt must be a base64 encoded image or PDF.");
  const mediaType = (mimeType || match[1]).toLowerCase();
  if (!(mediaType.startsWith("image/") || mediaType === "application/pdf" || mediaType === "application/octet-stream")) {
    throw new HttpError(400, "Use a photo (JPG, PNG, etc.) or PDF.");
  }
  const base64 = match[2].replace(/\s/g, "");
  const bytes = Math.max(0, Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0));
  if (bytes > MAX_RECEIPT_BYTES) throw new HttpError(413, "Receipt must be 50 MB or smaller.");
  return { dataUrl: value, mimeType: mediaType };
}

function tripValue(trip: Trip) {
  return {
    date: trip.date,
    destination: trip.destination,
    business_purpose: trip.businessPurpose,
    start_tenths: trip.start_tenths,
    end_tenths: trip.end_tenths,
    parking_cents: trip.parking_cents,
    tolls_cents: trip.tolls_cents,
    created_at: trip.createdAt,
  };
}

function expenseValue(expense: Expense) {
  return {
    date: expense.date,
    category: expense.category,
    amount: expense.amount,
    payment_method: expense.paymentMethod,
    merchant: expense.merchant,
    business_purpose: expense.businessPurpose,
    project_or_client: expense.projectOrClient ?? null,
    notes: expense.notes ?? null,
    receipt_file_name: expense.receiptFileName ?? null,
    receipt_mime_type: expense.receiptMimeType ?? null,
  };
}

function readJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapExpense(row: DbExpense, includeData = false) {
  return {
    id: row.id,
    createdAt: row.created_at,
    date: row.date,
    category: row.category,
    amount: row.amount,
    paymentMethod: row.payment_method,
    merchant: row.merchant,
    businessPurpose: row.business_purpose,
    ...(row.project_or_client ? { projectOrClient: row.project_or_client } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    ...(row.receipt_file_name ? { receiptFileName: row.receipt_file_name } : {}),
    ...(row.receipt_mime_type ? { receiptMimeType: row.receipt_mime_type } : {}),
    ...(row.receipt_file_name ? { receiptDataUrl: `/api/expenses/${encodeURIComponent(row.id)}/receipt` } : {}),
    status: row.status,
    everProcessed: Boolean(row.ever_processed),
    processedBy: row.processed_by,
    paidBy: row.paid_by,
    ...(includeData && row.receipt_data_url ? { _receiptDataUrl: row.receipt_data_url } : {}),
  };
}

function mapTrip(row: DbTrip) {
  return {
    id: row.id,
    createdAt: row.created_at,
    date: row.date,
    destination: row.destination,
    businessPurpose: row.business_purpose,
    start_tenths: row.start_tenths,
    end_tenths: row.end_tenths,
    parking_cents: row.parking_cents,
    tolls_cents: row.tolls_cents,
    status: row.status,
    everProcessed: Boolean(row.ever_processed),
    processedRateCentsPerMile: row.processed_rate_cents_per_mile,
    processedBy: row.processed_by,
    paidBy: row.paid_by,
  };
}

function ownHistory(db: DatabaseSync, userId: string) {
  return (db.prepare(`SELECT h.id, h.record_type, h.record_id, h.action, h.from_status, h.to_status,
      h.reason, h.details_json, h.created_at, actor.display_name AS actor_name
    FROM record_history h JOIN users actor ON actor.id = h.actor_id
    WHERE h.owner_id = ? ORDER BY h.created_at DESC LIMIT 1000`).all(userId) as Array<Record<string, string | null>>)
    .map((row) => ({
      id: row.id,
      recordType: row.record_type,
      recordId: row.record_id,
      action: row.action,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      details: readJson(row.details_json),
      createdAt: row.created_at,
      actorName: row.actor_name,
    }));
}

export function loadEmployeeSnapshot(db: DatabaseSync, userId: string) {
  const profileRow = db.prepare("SELECT profile_json FROM profiles WHERE user_id = ?").get(userId) as { profile_json: string } | undefined;
  const annualMileage = db.prepare("SELECT year, opening_tenths, closing_tenths FROM annual_mileage WHERE user_id = ? ORDER BY year").all(userId) as Array<{
    year: number;
    opening_tenths: number | null;
    closing_tenths: number | null;
  }>;
  const trips = db.prepare("SELECT * FROM trips WHERE user_id = ? ORDER BY date DESC, created_at DESC").all(userId) as unknown as DbTrip[];
  const expenses = db.prepare("SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC, created_at DESC").all(userId) as unknown as DbExpense[];
  return {
    state: {
      version: 1 as const,
      profile: (readJson(profileRow?.profile_json ?? null) as MileageState["profile"]) ?? null,
      annualMileage,
      trips: trips.map((row) => mapTrip(row)),
    },
    expenses: expenses.map((row) => mapExpense(row)),
    history: ownHistory(db, userId),
  };
}

export function saveEmployeeSnapshot(user: AppUser, body: unknown) {
  if (!hasRole(user, "employee")) throw new HttpError(403, "Employee access is required.");
  const parsed = employeeSubmissionSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Check the submitted expense data.");
  const db = database();
  const now = new Date().toISOString();
  withTransaction(db, () => {
    const profileJson = parsed.data.state.profile ? JSON.stringify(parsed.data.state.profile) : null;
    const priorProfile = db.prepare("SELECT profile_json FROM profiles WHERE user_id = ?").get(user.id) as { profile_json: string } | undefined;
    if (profileJson !== null) {
      if (!priorProfile || priorProfile.profile_json !== profileJson) {
        db.prepare(`INSERT INTO profiles (user_id, profile_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at`)
          .run(user.id, profileJson, now);
        recordHistory(db, { recordType: "profile", recordId: user.id, ownerId: user.id, actorId: user.id, action: priorProfile ? "updated" : "created", details: parsed.data.state.profile });
      }
    } else if (priorProfile) {
      db.prepare("DELETE FROM profiles WHERE user_id = ?").run(user.id);
      recordHistory(db, {
        recordType: "profile",
        recordId: user.id,
        ownerId: user.id,
        actorId: user.id,
        action: "deleted",
        details: readJson(priorProfile.profile_json),
      });
    }

    const incomingYears = new Set<number>();
    for (const annual of parsed.data.state.annualMileage) {
      incomingYears.add(annual.year);
      const old = db.prepare("SELECT opening_tenths, closing_tenths FROM annual_mileage WHERE user_id = ? AND year = ?")
        .get(user.id, annual.year) as { opening_tenths: number | null; closing_tenths: number | null } | undefined;
      if (!old || old.opening_tenths !== annual.opening_tenths || old.closing_tenths !== annual.closing_tenths) {
        db.prepare(`INSERT INTO annual_mileage (user_id, year, opening_tenths, closing_tenths) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, year) DO UPDATE SET opening_tenths = excluded.opening_tenths, closing_tenths = excluded.closing_tenths`)
          .run(user.id, annual.year, annual.opening_tenths, annual.closing_tenths);
        recordHistory(db, { recordType: "annual_mileage", recordId: `${user.id}:${annual.year}`, ownerId: user.id, actorId: user.id, action: old ? "updated" : "created", details: annual });
      }
    }
    for (const row of db.prepare("SELECT year FROM annual_mileage WHERE user_id = ?").all(user.id) as { year: number }[]) {
      if (!incomingYears.has(row.year)) {
        db.prepare("DELETE FROM annual_mileage WHERE user_id = ? AND year = ?").run(user.id, row.year);
        recordHistory(db, { recordType: "annual_mileage", recordId: `${user.id}:${row.year}`, ownerId: user.id, actorId: user.id, action: "deleted", details: { year: row.year } });
      }
    }

    const currentTrips = db.prepare("SELECT * FROM trips WHERE user_id = ?").all(user.id) as unknown as DbTrip[];
    const oldTrips = new Map(currentTrips.map((trip) => [trip.id, trip]));
    const incomingTripIds = new Set<string>();
    for (const trip of parsed.data.state.trips) {
      incomingTripIds.add(trip.id);
      const old = oldTrips.get(trip.id);
      if (!old) {
        const other = db.prepare("SELECT user_id FROM trips WHERE id = ?").get(trip.id) as { user_id: string } | undefined;
        if (other) throw new HttpError(404, "Trip not found.");
        const value = tripValue(trip);
        db.prepare(`INSERT INTO trips (id, user_id, date, destination, business_purpose, start_tenths, end_tenths,
          parking_cents, tolls_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(trip.id, user.id, value.date, value.destination, value.business_purpose, value.start_tenths, value.end_tenths, value.parking_cents, value.tolls_cents, trip.createdAt, now);
        recordHistory(db, { recordType: "trip", recordId: trip.id, ownerId: user.id, actorId: user.id, action: "created", toStatus: "Submitted", details: tripValue(trip) });
        continue;
      }
      const value = tripValue(trip);
      const oldValue = {
        date: old.date,
        destination: old.destination,
        business_purpose: old.business_purpose,
        start_tenths: old.start_tenths,
        end_tenths: old.end_tenths,
        parking_cents: old.parking_cents,
        tolls_cents: old.tolls_cents,
        created_at: old.created_at,
      };
      if (nonEmptyChange(oldValue, value)) {
        if (old.status !== "Submitted") throw new HttpError(409, "Processed mileage records cannot be edited.");
        db.prepare(`UPDATE trips SET date = ?, destination = ?, business_purpose = ?, start_tenths = ?, end_tenths = ?,
          parking_cents = ?, tolls_cents = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
          .run(value.date, value.destination, value.business_purpose, value.start_tenths, value.end_tenths, value.parking_cents, value.tolls_cents, now, trip.id, user.id);
        recordHistory(db, { recordType: "trip", recordId: trip.id, ownerId: user.id, actorId: user.id, action: "updated", fromStatus: old.status, toStatus: old.status, details: value });
      }
    }
    for (const old of currentTrips) {
      if (!incomingTripIds.has(old.id)) {
        if (old.status !== "Submitted" || old.ever_processed) throw new HttpError(409, "Mileage records with processing history cannot be deleted.");
        db.prepare("DELETE FROM trips WHERE id = ? AND user_id = ?").run(old.id, user.id);
      }
    }

    const currentExpenses = db.prepare("SELECT * FROM expenses WHERE user_id = ?").all(user.id) as unknown as DbExpense[];
    const oldExpenses = new Map(currentExpenses.map((expense) => [expense.id, expense]));
    const incomingExpenseIds = new Set<string>();
    const removeReceipts = new Set(parsed.data.removeReceiptIds);
    for (const expense of parsed.data.expenses) {
      incomingExpenseIds.add(expense.id);
      const old = oldExpenses.get(expense.id);
      if (!old) {
        const other = db.prepare("SELECT user_id FROM expenses WHERE id = ?").get(expense.id) as { user_id: string } | undefined;
        if (other) throw new HttpError(404, "Expense not found.");
        let receipt = { dataUrl: null as string | null, mimeType: expense.receiptMimeType ?? null };
        if (expense.receiptDataUrl?.startsWith("data:")) receipt = assertReceiptDataUrl(expense.receiptDataUrl, expense.receiptMimeType);
        const value = expenseValue(expense);
        db.prepare(`INSERT INTO expenses (id, user_id, date, category, amount, payment_method, merchant, business_purpose,
          project_or_client, notes, receipt_file_name, receipt_mime_type, receipt_data_url, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(expense.id, user.id, value.date, value.category, value.amount, value.payment_method, value.merchant, value.business_purpose,
            value.project_or_client, value.notes, expense.receiptFileName ?? null, receipt.mimeType, receipt.dataUrl, expense.createdAt, now);
        recordHistory(db, { recordType: "expense", recordId: expense.id, ownerId: user.id, actorId: user.id, action: "created", toStatus: "Submitted", details: value });
        continue;
      }
      const value = expenseValue(expense);
      const oldValue = {
        date: old.date,
        category: old.category,
        amount: old.amount,
        payment_method: old.payment_method,
        merchant: old.merchant,
        business_purpose: old.business_purpose,
        project_or_client: old.project_or_client,
        notes: old.notes,
        receipt_file_name: old.receipt_file_name,
        receipt_mime_type: old.receipt_mime_type,
      };
      const deleteReceipt = removeReceipts.has(expense.id);
      const inputHasReceipt = expense.receiptDataUrl?.startsWith("data:") ?? false;
      const receiptChanged = deleteReceipt || inputHasReceipt;
      if (nonEmptyChange(oldValue, value) || receiptChanged) {
        if (old.status !== "Submitted") throw new HttpError(409, "Processed expenses cannot be edited.");
        const receipt = inputHasReceipt ? assertReceiptDataUrl(expense.receiptDataUrl!, expense.receiptMimeType) : null;
        db.prepare(`UPDATE expenses SET date = ?, category = ?, amount = ?, payment_method = ?, merchant = ?, business_purpose = ?,
          project_or_client = ?, notes = ?, receipt_file_name = ?, receipt_mime_type = ?, receipt_data_url = ?, updated_at = ?
          WHERE id = ? AND user_id = ?`)
          .run(value.date, value.category, value.amount, value.payment_method, value.merchant, value.business_purpose,
            value.project_or_client, value.notes,
            deleteReceipt ? null : expense.receiptFileName ?? old.receipt_file_name,
            deleteReceipt ? null : receipt?.mimeType ?? expense.receiptMimeType ?? old.receipt_mime_type,
            deleteReceipt ? null : receipt?.dataUrl ?? old.receipt_data_url,
            now, expense.id, user.id);
        recordHistory(db, { recordType: "expense", recordId: expense.id, ownerId: user.id, actorId: user.id, action: "updated", fromStatus: old.status, toStatus: old.status, details: { ...value, receiptChanged } });
      }
    }
    for (const old of currentExpenses) {
      if (!incomingExpenseIds.has(old.id)) {
        if (old.status !== "Submitted" || old.ever_processed) throw new HttpError(409, "Expenses with processing history cannot be deleted.");
        db.prepare("DELETE FROM expenses WHERE id = ? AND user_id = ?").run(old.id, user.id);
      }
    }
  });
  return loadEmployeeSnapshot(db, user.id);
}

function activePayrollCheck(user: AppUser) {
  if (user.accessStatus !== "active" || !hasRole(user, "payroll")) throw new HttpError(403, "Payroll access is required.");
}

function currentRate(db: DatabaseSync, date: string) {
  return db.prepare("SELECT cents_per_mile FROM mileage_rates WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1")
    .get(date) as { cents_per_mile: number } | undefined;
}

export function payrollSnapshot(user: AppUser) {
  activePayrollCheck(user);
  const db = database();
  const employees = db.prepare(`SELECT u.id, u.display_name, u.email, u.access_status, p.profile_json
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.access_status = 'active' ORDER BY u.display_name`).all() as Array<{
      id: string; display_name: string; email: string | null; access_status: string; profile_json: string | null;
    }>;
  const rates = db.prepare("SELECT id, effective_from, cents_per_mile, created_at FROM mileage_rates ORDER BY effective_from DESC").all();
  const trips = db.prepare(`SELECT t.*, u.display_name AS owner_name FROM trips t JOIN users u ON u.id = t.user_id
    ORDER BY t.date DESC, t.created_at DESC`).all() as unknown as Array<DbTrip & { owner_name: string }>;
  const expenses = db.prepare(`SELECT e.*, u.display_name AS owner_name FROM expenses e JOIN users u ON u.id = e.user_id
    ORDER BY e.date DESC, e.created_at DESC`).all() as unknown as Array<DbExpense & { owner_name: string }>;
  const history = db.prepare(`SELECT h.id, h.record_type, h.record_id, h.owner_id, h.actor_id, h.action, h.from_status,
      h.to_status, h.reason, h.details_json, h.created_at, owner.display_name AS owner_name, actor.display_name AS actor_name
    FROM record_history h JOIN users owner ON owner.id = h.owner_id JOIN users actor ON actor.id = h.actor_id
    ORDER BY h.created_at DESC LIMIT 2000`).all() as Array<Record<string, string | null>>;
  return {
    employees: employees.map((row) => ({ id: row.id, displayName: row.display_name, email: row.email, profile: readJson(row.profile_json) })),
    rates,
    trips: trips.map((row) => {
      const storedRate = row.processed_rate_cents_per_mile;
      const rate = storedRate ?? currentRate(db, row.date)?.cents_per_mile ?? null;
      const miles = row.end_tenths - row.start_tenths;
      const mileageCents = rate === null ? null : Math.round((miles * rate) / 10);
      return {
        ...mapTrip(row),
        ownerId: row.user_id,
        ownerName: row.owner_name,
        reimbursementCents: mileageCents === null ? null : mileageCents + row.parking_cents + row.tolls_cents,
        rateCentsPerMile: rate,
      };
    }),
    expenses: expenses.map((row) => ({
      ...mapExpense(row),
      ownerId: row.user_id,
      ownerName: row.owner_name,
      reimbursableCents: row.payment_method === "company_card" ? 0 : row.amount,
    })),
    history: history.map((row) => ({
      id: row.id,
      recordType: row.record_type,
      recordId: row.record_id,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      details: readJson(row.details_json),
      createdAt: row.created_at,
    })),
  };
}

export function transitionPayrollRecord(user: AppUser, input: unknown) {
  activePayrollCheck(user);
  const schema = z.object({
    type: z.enum(["expense", "trip"]),
    id: z.string().uuid(),
    action: z.enum(["process", "mark_paid", "undo_paid", "undo_processed", "void", "correct_rate"]),
    reason: z.string().trim().max(500).optional(),
    correctedRateCentsPerMile: z.number().int().min(1).max(1000).optional(),
  });
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid payroll action.");
  const { type, id, action } = parsed.data;
  const reason = parsed.data.reason?.trim() ?? "";
  if (["undo_paid", "undo_processed", "void", "correct_rate"].includes(action) && !reason) {
    throw new HttpError(400, "A reason is required for this action.");
  }
  if (action === "correct_rate" && (type !== "trip" || parsed.data.correctedRateCentsPerMile === undefined)) {
    throw new HttpError(400, "A corrected mileage rate is required.");
  }
  const db = database();
  const now = new Date().toISOString();
  return withTransaction(db, () => {
    const table = type === "trip" ? "trips" : "expenses";
    const rateSelection = type === "trip" ? "processed_rate_cents_per_mile" : "NULL AS processed_rate_cents_per_mile";
    const row = db.prepare(`SELECT id, user_id, status, ever_processed, date, ${rateSelection} FROM ${table} WHERE id = ?`)
      .get(id) as { id: string; user_id: string; status: RecordStatus; ever_processed: number; date: string; processed_rate_cents_per_mile: number | null } | undefined;
    if (!row) throw new HttpError(404, "Record not found.");
    if (action === "correct_rate") {
      if (type !== "trip" || !row.ever_processed || !["Submitted", "Processed", "Paid"].includes(row.status)) {
        throw new HttpError(409, "Only previously processed mileage records can have their rate corrected.");
      }
      const oldRate = row.processed_rate_cents_per_mile;
      db.prepare("UPDATE trips SET processed_rate_cents_per_mile = ?, updated_at = ? WHERE id = ?")
        .run(parsed.data.correctedRateCentsPerMile!, now, id);
      recordHistory(db, { recordType: "trip", recordId: id, ownerId: row.user_id, actorId: user.id, action: "rate_corrected", fromStatus: row.status, toStatus: row.status, reason, details: { previousRateCentsPerMile: oldRate, correctedRateCentsPerMile: parsed.data.correctedRateCentsPerMile } });
      recordAudit(db, user.id, "mileage_rate_correction", row.user_id, { recordId: id, oldRate, correctedRate: parsed.data.correctedRateCentsPerMile, reason });
      return { ok: true };
    }

    let next: RecordStatus;
    if (action === "process" && row.status === "Submitted") next = "Processed";
    else if (action === "mark_paid" && row.status === "Processed") next = "Paid";
    else if (action === "undo_paid" && row.status === "Paid") next = "Processed";
    else if (action === "undo_processed" && row.status === "Processed") next = "Submitted";
    else if (action === "void" && ["Processed", "Paid"].includes(row.status)) next = "Voided";
    else throw new HttpError(409, "That payroll transition is not allowed for this record.");

    let processedRate = row.processed_rate_cents_per_mile;
    if (action === "process" && type === "trip") {
      if (!row.ever_processed || processedRate === null) {
        const effective = currentRate(db, row.date);
        if (!effective) throw new HttpError(409, "Add a dated mileage rate before processing this trip.");
        processedRate = effective.cents_per_mile;
      }
    }
    if (type === "trip") {
      db.prepare(`UPDATE trips SET status = ?, ever_processed = CASE WHEN ? = 'Processed' THEN 1 ELSE ever_processed END,
        processed_rate_cents_per_mile = ?, processed_by = CASE WHEN ? = 'Processed' AND ? = 'process' THEN ? ELSE processed_by END,
        processed_at = CASE WHEN ? = 'Processed' AND ? = 'process' THEN ? ELSE processed_at END,
        paid_by = CASE WHEN ? = 'Paid' THEN ? WHEN ? = 'Processed' THEN NULL ELSE paid_by END,
        paid_at = CASE WHEN ? = 'Paid' THEN ? WHEN ? = 'Processed' THEN NULL ELSE paid_at END,
        voided_by = CASE WHEN ? = 'Voided' THEN ? ELSE voided_by END,
        voided_at = CASE WHEN ? = 'Voided' THEN ? ELSE voided_at END,
        updated_at = ? WHERE id = ?`)
        .run(next, next, processedRate, next, action, user.id, next, action, now, next, user.id, next, next, now, next, next, user.id, next, now, now, id);
    } else {
      db.prepare(`UPDATE expenses SET status = ?, ever_processed = CASE WHEN ? = 'Processed' THEN 1 ELSE ever_processed END,
        processed_by = CASE WHEN ? = 'Processed' AND ? = 'process' THEN ? ELSE processed_by END,
        processed_at = CASE WHEN ? = 'Processed' AND ? = 'process' THEN ? ELSE processed_at END,
        paid_by = CASE WHEN ? = 'Paid' THEN ? WHEN ? = 'Processed' THEN NULL ELSE paid_by END,
        paid_at = CASE WHEN ? = 'Paid' THEN ? WHEN ? = 'Processed' THEN NULL ELSE paid_at END,
        voided_by = CASE WHEN ? = 'Voided' THEN ? ELSE voided_by END,
        voided_at = CASE WHEN ? = 'Voided' THEN ? ELSE voided_at END,
        updated_at = ? WHERE id = ?`)
        .run(next, next, next, action, user.id, next, action, now, next, user.id, next, next, now, next, next, user.id, next, now, now, id);
    }
    recordHistory(db, { recordType: type, recordId: id, ownerId: row.user_id, actorId: user.id, action, fromStatus: row.status, toStatus: next, reason: reason || null, details: type === "trip" && action === "process" ? { processedRateCentsPerMile: processedRate } : undefined });
    recordAudit(db, user.id, `payroll_${action}`, row.user_id, { recordType: type, recordId: id, fromStatus: row.status, toStatus: next, reason: reason || null });
    return { ok: true, status: next };
  });
}

export function createMileageRate(user: AppUser, input: unknown) {
  activePayrollCheck(user);
  const parsed = z.object({ effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), centsPerMile: z.number().int().min(1).max(1000) }).safeParse(input);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid mileage rate.");
  const db = database();
  const now = new Date().toISOString();
  try {
    withTransaction(db, () => {
      db.prepare("INSERT INTO mileage_rates (id, effective_from, cents_per_mile, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(randomUUID(), parsed.data.effectiveFrom, parsed.data.centsPerMile, user.id, now);
      recordAudit(db, user.id, "mileage_rate_created", undefined, parsed.data);
    });
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) throw new HttpError(409, "A mileage rate already exists for that date.");
    throw error;
  }
  return payrollSnapshot(user).rates;
}

function requireAdmin(user: AppUser) {
  if (user.accessStatus !== "active" || !user.roles.includes("super_admin")) throw new HttpError(403, "Super admin access is required.");
}

export function pendingAccessRequests(user: AppUser) {
  requireAdmin(user);
  return database().prepare(`SELECT r.id AS request_id, r.requested_at, u.id AS user_id, u.display_name, u.email
    FROM access_requests r JOIN users u ON u.id = r.user_id WHERE r.status = 'pending' AND u.access_status = 'pending'
    ORDER BY r.requested_at`).all();
}

export function managedUsers(user: AppUser) {
  requireAdmin(user);
  const rows = database().prepare(`SELECT u.id, u.display_name, u.email, u.access_status
    FROM users u ORDER BY u.display_name`).all() as Array<{ id: string; display_name: string; email: string | null; access_status: string }>;
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    accessStatus: row.access_status,
    roles: (database().prepare("SELECT role FROM roles WHERE user_id = ? ORDER BY role").all(row.id) as { role: Role }[]).map((item) => item.role),
  }));
}

export function reviewAccessRequest(user: AppUser, input: unknown) {
  requireAdmin(user);
  const parsed = z.object({ requestId: z.string().uuid(), decision: z.enum(["approve", "deny"]), grantPayroll: z.boolean().default(false), grantAdmin: z.boolean().default(false) }).safeParse(input);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid access decision.");
  const db = database();
  const now = new Date().toISOString();
  return withTransaction(db, () => {
    const request = db.prepare("SELECT id, user_id FROM access_requests WHERE id = ? AND status = 'pending'").get(parsed.data.requestId) as { id: string; user_id: string } | undefined;
    if (!request) throw new HttpError(404, "Pending access request not found.");
    const target = getUser(db, request.user_id);
    if (!target || target.accessStatus !== "pending") throw new HttpError(409, "This account no longer has pending access.");
    if (parsed.data.decision === "deny") {
      db.prepare("UPDATE access_requests SET status = 'denied', reviewed_by = ?, reviewed_at = ? WHERE id = ?")
        .run(user.id, now, request.id);
      recordAudit(db, user.id, "access_request_denied", request.user_id, { requestId: request.id });
      return { ok: true };
    }
    const roles: Role[] = ["employee"];
    if (parsed.data.grantPayroll || parsed.data.grantAdmin) roles.push("payroll");
    if (parsed.data.grantAdmin) roles.push("super_admin");
    db.prepare("UPDATE users SET access_status = 'active', updated_at = ? WHERE id = ?").run(now, request.user_id);
    for (const role of roles) {
      db.prepare("INSERT OR IGNORE INTO roles (user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?)")
        .run(request.user_id, role, user.id, now);
    }
    db.prepare("UPDATE access_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?")
      .run(user.id, now, request.id);
    recordAudit(db, user.id, "access_request_approved", request.user_id, { requestId: request.id, grantedRoles: roles });
    return { ok: true, roles };
  });
}

export function bootstrapFirstAdmin(user: AppUser, suppliedToken: string) {
  if (user.accessStatus !== "pending") throw new HttpError(409, "Bootstrap is only available to a pending verified account.");
  const expected = process.env.FIRST_ADMIN_BOOTSTRAP_TOKEN;
  if (!expected) throw new HttpError(404, "First admin bootstrap is disabled.");
  const supplied = Buffer.from(suppliedToken, "utf8");
  const configured = Buffer.from(expected, "utf8");
  if (supplied.length !== configured.length || !timingSafeEqual(supplied, configured)) throw new HttpError(403, "Invalid bootstrap token.");
  const db = database();
  const now = new Date().toISOString();
  return withTransaction(db, () => {
    const used = db.prepare("SELECT singleton FROM bootstrap_state WHERE singleton = 1").get();
    const existingAdmin = db.prepare("SELECT 1 FROM roles r JOIN users u ON u.id = r.user_id WHERE r.role = 'super_admin' AND u.access_status = 'active' LIMIT 1").get();
    if (used || existingAdmin) throw new HttpError(409, "First admin bootstrap has already been used.");
    const open = db.prepare("SELECT id FROM access_requests WHERE user_id = ? AND status = 'pending'").get(user.id) as { id: string } | undefined;
    db.prepare("UPDATE users SET access_status = 'active', updated_at = ? WHERE id = ?").run(now, user.id);
    for (const role of ["employee", "payroll", "super_admin"] as Role[]) {
      db.prepare("INSERT INTO roles (user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?)").run(user.id, role, user.id, now);
    }
    if (open) db.prepare("UPDATE access_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(user.id, now, open.id);
    db.prepare("INSERT INTO bootstrap_state (singleton, used_at, used_by) VALUES (1, ?, ?)").run(now, user.id);
    recordAudit(db, user.id, "first_admin_bootstrap", user.id, { grantedRoles: ["employee", "payroll", "super_admin"] });
    return { ok: true };
  });
}

export function firstAdminBootstrapAvailable(user: AppUser) {
  if (user.accessStatus !== "pending" || !process.env.FIRST_ADMIN_BOOTSTRAP_TOKEN?.trim()) return false;
  const db = database();
  const used = db.prepare("SELECT singleton FROM bootstrap_state WHERE singleton = 1").get();
  const existingAdmin = db.prepare("SELECT 1 FROM roles r JOIN users u ON u.id = r.user_id WHERE r.role = 'super_admin' AND u.access_status = 'active' LIMIT 1").get();
  return !used && !existingAdmin;
}

export function manageUserAccess(user: AppUser, targetId: string, input: unknown) {
  requireAdmin(user);
  const parsed = z.object({ accessStatus: z.enum(["active", "disabled"]).optional(), roles: z.array(z.enum(["employee", "payroll", "super_admin"])).optional() }).safeParse(input);
  if (!parsed.success || (!parsed.data?.accessStatus && !parsed.data?.roles)) throw new HttpError(400, "Choose a role or access status to update.");
  const db = database();
  const now = new Date().toISOString();
  return withTransaction(db, () => {
    const target = getUser(db, targetId);
    if (!target) throw new HttpError(404, "User not found.");
    const nextStatus = parsed.data.accessStatus ?? target.accessStatus;
    const nextRoles = parsed.data.roles ? [...new Set(parsed.data.roles)] : target.roles;
    if (nextRoles.includes("super_admin") && !nextRoles.includes("payroll")) nextRoles.push("payroll");
    const wasAdmin = target.accessStatus === "active" && target.roles.includes("super_admin");
    const willBeAdmin = nextStatus === "active" && nextRoles.includes("super_admin");
    if (wasAdmin && !willBeAdmin) {
      const count = (db.prepare("SELECT COUNT(*) AS count FROM users u JOIN roles r ON r.user_id = u.id WHERE u.access_status = 'active' AND r.role = 'super_admin'").get() as { count: number }).count;
      if (count <= 1) throw new HttpError(409, "The last active super admin cannot be removed or disabled.");
    }
    if (parsed.data.roles) {
      db.prepare("DELETE FROM roles WHERE user_id = ?").run(targetId);
      for (const role of nextRoles) db.prepare("INSERT INTO roles (user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?)").run(targetId, role, user.id, now);
    }
    db.prepare("UPDATE users SET access_status = ?, updated_at = ? WHERE id = ?").run(nextStatus, now, targetId);
    recordAudit(db, user.id, "user_access_updated", targetId, { accessStatus: nextStatus, roles: nextRoles });
    return getUser(db, targetId);
  });
}

export const SECURITY_AUDIT_PAGE_SIZE = 25;

export type SecurityAuditFilters = {
  query?: string;
  event?: string;
  actor?: string;
  account?: string;
  from?: string;
  to?: string;
  page?: number;
};

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function auditTextFilter(value: string | undefined) {
  return value?.trim().slice(0, 160) ?? "";
}

export function securityAudit(user: AppUser, filters: SecurityAuditFilters = {}) {
  requireAdmin(user);
  const requestedPage = filters.page ?? 1;
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 1_000_000) {
    throw new HttpError(400, "Choose a valid security history page.");
  }

  const from = filters.from?.trim() ?? "";
  const to = filters.to?.trim() ?? "";
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
    throw new HttpError(400, "Choose valid security history dates.");
  }
  if (from && to && from > to) throw new HttpError(400, "The start date must be on or before the end date.");

  const conditions: string[] = [];
  const values: string[] = [];
  const query = auditTextFilter(filters.query);
  const event = auditTextFilter(filters.event);
  const actor = auditTextFilter(filters.actor);
  const account = auditTextFilter(filters.account);
  if (from) { conditions.push("a.created_at >= ?"); values.push(`${from}T00:00:00.000Z`); }
  if (to) { conditions.push("a.created_at <= ?"); values.push(`${to}T23:59:59.999Z`); }
  if (event) { conditions.push("instr(lower(a.event_type), lower(?)) > 0"); values.push(event); }
  if (actor) {
    conditions.push("instr(lower(coalesce(actor.display_name, '') || ' ' || coalesce(actor.email, '')), lower(?)) > 0");
    values.push(actor);
  }
  if (account) {
    conditions.push("instr(lower(coalesce(subject.display_name, '') || ' ' || coalesce(subject.email, '') || ' ' || coalesce(a.subject_user_id, '')), lower(?)) > 0");
    values.push(account);
  }
  if (query) {
    conditions.push(`instr(lower(coalesce(a.event_type, '') || ' ' || coalesce(actor.display_name, '') || ' ' ||
      coalesce(actor.email, '') || ' ' || coalesce(subject.display_name, '') || ' ' || coalesce(subject.email, '') || ' ' ||
      coalesce(a.subject_user_id, '') || ' ' || coalesce(a.details_json, '')), lower(?)) > 0`);
    values.push(query);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const db = database();
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM audit_events a
    JOIN users actor ON actor.id = a.actor_id
    LEFT JOIN users subject ON subject.id = a.subject_user_id ${where}`).get(...values) as { count: number }).count;
  const totalPages = Math.max(1, Math.ceil(total / SECURITY_AUDIT_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const rows = db.prepare(`SELECT a.id, a.event_type, a.subject_user_id, a.details_json, a.created_at,
      actor.display_name AS actor_name, actor.email AS actor_email,
      subject.display_name AS subject_name, subject.email AS subject_email
    FROM audit_events a JOIN users actor ON actor.id = a.actor_id
    LEFT JOIN users subject ON subject.id = a.subject_user_id ${where}
    ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`)
    .all(...values, SECURITY_AUDIT_PAGE_SIZE, (page - 1) * SECURITY_AUDIT_PAGE_SIZE) as Array<{
      id: string; event_type: string; subject_user_id: string | null; details_json: string | null; created_at: string;
      actor_name: string; actor_email: string | null; subject_name: string | null; subject_email: string | null;
    }>;

  return {
    events: rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      subjectUserId: row.subject_user_id,
      subjectName: row.subject_name,
      subjectEmail: row.subject_email,
      details: readJson(row.details_json),
      createdAt: row.created_at,
      actorName: row.actor_name,
      actorEmail: row.actor_email,
    })),
    page,
    pageSize: SECURITY_AUDIT_PAGE_SIZE,
    total,
    totalPages,
  };
}

export function receiptForUser(user: AppUser, expenseId: string) {
  const db = database();
  const row = db.prepare("SELECT user_id, receipt_file_name, receipt_mime_type, receipt_data_url FROM expenses WHERE id = ?")
    .get(expenseId) as { user_id: string; receipt_file_name: string | null; receipt_mime_type: string | null; receipt_data_url: string | null } | undefined;
  if (!row) throw new HttpError(404, "Receipt not found.");
  if (row.user_id !== user.id && !hasRole(user, "payroll")) throw new HttpError(404, "Receipt not found.");
  if (!row.receipt_data_url) throw new HttpError(404, "Receipt not found.");
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]*)$/s.exec(row.receipt_data_url);
  if (!match) throw new HttpError(500, "Receipt data is invalid.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new HttpError(500, "Receipt data exceeds the allowed size.");
  return { bytes, mimeType: row.receipt_mime_type ?? match[1], fileName: row.receipt_file_name ?? "receipt" };
}

export function directOwnerExpense(user: AppUser, expenseId: string) {
  const row = database().prepare("SELECT * FROM expenses WHERE id = ? AND user_id = ?").get(expenseId, user.id) as unknown as DbExpense | undefined;
  if (!row) throw new HttpError(404, "Expense not found.");
  return mapExpense(row);
}

export function ensureEmployee(user: AppUser) {
  if (user.accessStatus !== "active" || !hasRole(user, "employee")) throw new HttpError(403, "Employee access is required.");
}

export function authorizedEmployeeTarget(user: AppUser, targetId = user.id) {
  if (targetId === user.id) ensureEmployee(user);
  else activePayrollCheck(user);
  const target = getUser(database(), targetId);
  if (!target) throw new HttpError(404, "Employee not found.");
  return target;
}

export function authorizedEmployeeSnapshot(user: AppUser, targetId = user.id) {
  const target = authorizedEmployeeTarget(user, targetId);
  return { target, snapshot: loadEmployeeSnapshot(database(), targetId) };
}

export function adminRepairRecord(user: AppUser, input: unknown) {
  requireAdmin(user);
  const parsed = z.object({
    type: z.enum(["expense", "trip"]),
    id: z.string().uuid(),
    reason: z.string().trim().min(1).max(500),
    patch: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0, "Provide at least one corrected field."),
  }).safeParse(input);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid repair request.");
  const db = database();
  const { type, id, reason } = parsed.data;
  const allowedExpense = z.object({
    date: z.string().optional(),
    category: z.enum(["travel", "meals", "client_project", "marketing", "shipping", "communications", "supplies", "other"]).optional(),
    amount: z.number().int().nonnegative().optional(),
    paymentMethod: z.enum(["company_card", "personal_card", "cash"]).optional(),
    merchant: z.string().trim().min(1).max(200).optional(),
    businessPurpose: z.string().trim().min(1).max(500).optional(),
    projectOrClient: z.string().trim().max(150).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  }).strict();
  const allowedTrip = z.object({
    date: z.string().optional(),
    destination: z.string().trim().min(1).max(200).optional(),
    businessPurpose: z.string().trim().min(1).max(500).optional(),
    start_tenths: z.number().int().nonnegative().optional(),
    end_tenths: z.number().int().nonnegative().optional(),
    parking_cents: z.number().int().nonnegative().optional(),
    tolls_cents: z.number().int().nonnegative().optional(),
  }).strict();
  const patch = (type === "expense" ? allowedExpense : allowedTrip).safeParse(parsed.data.patch);
  if (!patch.success) throw new HttpError(400, patch.error.issues[0]?.message ?? "The repair contains an unsupported field.");
  if (Object.keys(patch.data).length === 0) throw new HttpError(400, "Provide at least one corrected field.");
  return withTransaction(db, () => {
    const table = type === "expense" ? "expenses" : "trips";
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, string | number | null> | undefined;
    if (!row) throw new HttpError(404, "Record not found.");
    const financialFields = type === "trip" ? ["start_tenths", "end_tenths", "parking_cents", "tolls_cents"] : ["amount", "paymentMethod"];
    if (row.status === "Paid" && financialFields.some((field) => Object.hasOwn(patch.data, field))) {
      throw new HttpError(409, "Undo Paid before changing mileage or payment amounts.");
    }
    const repairedAt = new Date().toISOString();
    let changed: Record<string, unknown>;
    if (type === "expense") {
      const before = {
        id,
        createdAt: String(row.created_at),
        date: String(row.date),
        category: String(row.category),
        amount: Number(row.amount),
        paymentMethod: String(row.payment_method),
        merchant: String(row.merchant),
        businessPurpose: String(row.business_purpose),
        ...(typeof row.project_or_client === "string" ? { projectOrClient: row.project_or_client } : {}),
        ...(typeof row.notes === "string" ? { notes: row.notes } : {}),
        ...(row.receipt_file_name ? { receiptFileName: String(row.receipt_file_name) } : {}),
        ...(row.receipt_mime_type ? { receiptMimeType: String(row.receipt_mime_type) } : {}),
      };
      const candidate: Record<string, unknown> = { ...before, ...patch.data };
      if (candidate.projectOrClient === null) candidate.projectOrClient = undefined;
      if (candidate.notes === null) candidate.notes = undefined;
      const next = expenseRecordSchema.safeParse(candidate);
      if (!next.success) throw new HttpError(400, next.error.issues[0]?.message ?? "The corrected expense is invalid.");
      changed = {};
      const columnMap: Record<string, string> = { date: "date", category: "category", amount: "amount", paymentMethod: "payment_method", merchant: "merchant", businessPurpose: "business_purpose", projectOrClient: "project_or_client", notes: "notes" };
      for (const [key, value] of Object.entries(patch.data)) {
        const normalized = value === null || value === "" ? null : value;
        const column = columnMap[key];
        changed[key] = normalized;
        db.prepare(`UPDATE expenses SET ${column} = ?, updated_at = ? WHERE id = ?`).run(normalized, new Date().toISOString(), id);
      }
    } else {
      const before = {
        id,
        createdAt: String(row.created_at),
        date: String(row.date),
        destination: String(row.destination),
        businessPurpose: String(row.business_purpose),
        start_tenths: Number(row.start_tenths),
        end_tenths: Number(row.end_tenths),
        parking_cents: Number(row.parking_cents),
        tolls_cents: Number(row.tolls_cents),
      };
      const next = tripRecordSchema.safeParse({ ...before, ...patch.data });
      if (!next.success) throw new HttpError(400, next.error.issues[0]?.message ?? "The corrected mileage record is invalid.");
      changed = {};
      const columnMap: Record<string, string> = { date: "date", destination: "destination", businessPurpose: "business_purpose", start_tenths: "start_tenths", end_tenths: "end_tenths", parking_cents: "parking_cents", tolls_cents: "tolls_cents" };
      for (const [key, value] of Object.entries(patch.data)) {
        const column = columnMap[key];
        changed[key] = value;
      }
      const fields = Object.entries(changed);
      db.prepare(`UPDATE trips SET ${fields.map(([key]) => columnMap[key] + " = ?").join(", ")}, updated_at = ? WHERE id = ?`)
        .run(...fields.map(([, value]) => value as string | number | null), repairedAt, id);
    }
    const oldStatus = String(row.status);
    const after = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    const snapshot = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "receipt_data_url"));
    const details = { changes: changed, before: snapshot(row), after: snapshot(after as Record<string, unknown>), repairedAt };
    recordHistory(db, { recordType: type, recordId: id, ownerId: String(row.user_id), actorId: user.id, action: "admin_repair", fromStatus: oldStatus, toStatus: oldStatus, reason, details });
    recordAudit(db, user.id, "record_repaired", String(row.user_id), { recordType: type, recordId: id, reason, ...details });
    return { ok: true };
  });
}
