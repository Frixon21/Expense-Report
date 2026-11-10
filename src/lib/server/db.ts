import { initializeVehicleSchema } from "./vehicle-store.ts";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Role = "employee" | "payroll" | "super_admin";
export type AccessStatus = "pending" | "active" | "disabled";

export type AppUser = {
  id: string;
  issuer: string;
  subject: string;
  displayName: string;
  email: string | null;
  accessStatus: AccessStatus;
  roles: Role[];
};

type GlobalDb = typeof globalThis & {
  __expenseReportDb?: DatabaseSync;
  __expenseReportTestDb?: DatabaseSync | null;
};

const globalDb = globalThis as GlobalDb;

function createDatabase(path: string) {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      display_name TEXT NOT NULL,
      email TEXT,
      access_status TEXT NOT NULL CHECK (access_status IN ('pending','active','disabled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (issuer, subject)
    );
    CREATE TABLE IF NOT EXISTS roles (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('employee','payroll','super_admin')),
      granted_by TEXT REFERENCES users(id),
      granted_at TEXT NOT NULL,
      PRIMARY KEY (user_id, role)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','denied')),
      requested_at TEXT NOT NULL,
      reviewed_by TEXT REFERENCES users(id),
      reviewed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS access_requests_pending_idx ON access_requests(status, requested_at);
    CREATE TABLE IF NOT EXISTS bootstrap_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      used_at TEXT NOT NULL,
      used_by TEXT NOT NULL REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      profile_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS annual_mileage (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      opening_tenths INTEGER,
      closing_tenths INTEGER,
      PRIMARY KEY (user_id, year)
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount >= 0),
      payment_method TEXT NOT NULL,
      merchant TEXT NOT NULL,
      business_purpose TEXT NOT NULL,
      project_or_client TEXT,
      notes TEXT,
      receipt_file_name TEXT,
      receipt_mime_type TEXT,
      receipt_data_url TEXT,
      status TEXT NOT NULL CHECK (status IN ('Submitted','Processed','Paid','Voided')) DEFAULT 'Submitted',
      ever_processed INTEGER NOT NULL DEFAULT 0,
      processed_by TEXT REFERENCES users(id),
      processed_at TEXT,
      paid_by TEXT REFERENCES users(id),
      paid_at TEXT,
      voided_by TEXT REFERENCES users(id),
      voided_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS expenses_owner_date_idx ON expenses(user_id, date);
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      destination TEXT NOT NULL,
      business_purpose TEXT NOT NULL,
      start_tenths INTEGER NOT NULL CHECK (start_tenths >= 0),
      end_tenths INTEGER NOT NULL CHECK (end_tenths >= start_tenths),
      parking_cents INTEGER NOT NULL DEFAULT 0 CHECK (parking_cents >= 0),
      tolls_cents INTEGER NOT NULL DEFAULT 0 CHECK (tolls_cents >= 0),
      status TEXT NOT NULL CHECK (status IN ('Submitted','Processed','Paid','Voided')) DEFAULT 'Submitted',
      ever_processed INTEGER NOT NULL DEFAULT 0,
      processed_rate_cents_per_mile INTEGER,
      processed_by TEXT REFERENCES users(id),
      processed_at TEXT,
      paid_by TEXT REFERENCES users(id),
      paid_at TEXT,
      voided_by TEXT REFERENCES users(id),
      voided_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trips_owner_date_idx ON trips(user_id, date);
    CREATE TABLE IF NOT EXISTS mileage_rates (
      id TEXT PRIMARY KEY,
      effective_from TEXT NOT NULL UNIQUE,
      cents_per_mile INTEGER NOT NULL CHECK (cents_per_mile BETWEEN 1 AND 1000),
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS record_history (
      id TEXT PRIMARY KEY,
      record_type TEXT NOT NULL CHECK (record_type IN ('expense','trip','profile','annual_mileage')),
      record_id TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      actor_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      reason TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS record_history_owner_idx ON record_history(owner_id, created_at);
    CREATE TABLE IF NOT EXISTS notification_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), settings_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','review')),
      attempts INTEGER NOT NULL DEFAULT 0, first_at INTEGER, next_at INTEGER NOT NULL, lease TEXT, provider_id TEXT, error_code TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL REFERENCES users(id),
      event_type TEXT NOT NULL,
      subject_user_id TEXT REFERENCES users(id),
      details_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at);
  `);
  // Additive migration: older sessions have no provider proof and must sign in again.
  const sessionColumns = new Set(
    db
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .map((row) => String(row.name)),
  );
  for (const [name, type] of Object.entries({
    provider_expires_at: "INTEGER",
    provider_key_id: "TEXT",
    provider_key_thumbprint: "TEXT",
    provider_issuer: "TEXT",
    provider_subject: "TEXT",
  })) {
    if (!sessionColumns.has(name))
      db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
  }
  initializeVehicleSchema(db);
  return db;
}

export function database() {
  if (process.env.NODE_ENV === "test" && globalDb.__expenseReportTestDb) {
    return globalDb.__expenseReportTestDb;
  }
  if (!globalDb.__expenseReportDb) {
    const path =
      process.env.EXPENSE_REPORT_DB_PATH ??
      resolve(process.cwd(), ".data", "expense-report.sqlite");
    globalDb.__expenseReportDb = createDatabase(path);
  }
  return globalDb.__expenseReportDb;
}

export function setTestDatabase(db: DatabaseSync | null) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("A test database can only be selected in test mode.");
  }
  globalDb.__expenseReportTestDb = db ?? undefined;
}

export function createTestDatabase() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "An in-memory test database can only be created in test mode.",
    );
  }
  return createDatabase(":memory:");
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getUser(db: DatabaseSync, id: string): AppUser | null {
  const row = db
    .prepare(
      `SELECT id, issuer, subject, display_name, email, access_status FROM users WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        issuer: string;
        subject: string;
        display_name: string;
        email: string | null;
        access_status: AccessStatus;
      }
    | undefined;
  if (!row) return null;
  const roles = db
    .prepare("SELECT role FROM roles WHERE user_id = ? ORDER BY role")
    .all(id) as { role: Role }[];
  return {
    id: row.id,
    issuer: row.issuer,
    subject: row.subject,
    displayName: row.display_name,
    email: row.email,
    accessStatus: row.access_status,
    roles: roles.map((item) => item.role),
  };
}

export function hasRole(user: AppUser, role: Role) {
  return (
    user.roles.includes(role) ||
    (role === "payroll" && user.roles.includes("super_admin"))
  );
}

export function recordAudit(
  db: DatabaseSync,
  actorId: string,
  eventType: string,
  subjectUserId?: string,
  details?: unknown,
) {
  db.prepare(
    `INSERT INTO audit_events (id, actor_id, event_type, subject_user_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    actorId,
    eventType,
    subjectUserId ?? null,
    details ? JSON.stringify(details) : null,
    new Date().toISOString(),
  );
}

export function recordHistory(
  db: DatabaseSync,
  input: {
    recordType: "expense" | "trip" | "profile" | "annual_mileage";
    recordId: string;
    ownerId: string;
    actorId: string;
    action: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    reason?: string | null;
    details?: unknown;
  },
) {
  db.prepare(
    `INSERT INTO record_history
    (id, record_type, record_id, owner_id, actor_id, action, from_status, to_status, reason, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    input.recordType,
    input.recordId,
    input.ownerId,
    input.actorId,
    input.action,
    input.fromStatus ?? null,
    input.toStatus ?? null,
    input.reason ?? null,
    input.details ? JSON.stringify(input.details) : null,
    new Date().toISOString(),
  );
}
