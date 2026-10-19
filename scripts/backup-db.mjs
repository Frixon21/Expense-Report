import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { backup, DatabaseSync } from "node:sqlite";

const applicationTables = [
  "users",
  "roles",
  "sessions",
  "access_requests",
  "bootstrap_state",
  "profiles",
  "annual_mileage",
  "expenses",
  "trips",
  "mileage_rates",
  "record_history",
  "audit_events",
];

function assertIntegrity(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA quick_check").all();
    const results = rows.map((row) => String(Object.values(row)[0] ?? ""));
    if (results.length !== 1 || results[0] !== "ok") {
      throw new Error(`SQLite integrity check failed for ${path}.`);
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Backup contains broken foreign-key relationships.");
  } finally {
    db.close();
  }
}

function inspectApplicationDatabase(path) {
  assertIntegrity(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const names = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)),
    );
    const missing = applicationTables.filter((table) => !names.has(table));
    if (missing.length) {
      throw new Error(`Database is missing Expense Report tables: ${missing.join(", ")}.`);
    }
    return Object.fromEntries(
      applicationTables.map((table) => [
        table,
        Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count),
      ]),
    );
  } finally {
    db.close();
  }
}

function copyFileExclusively(source, destination) {
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
}

function contentFingerprint(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const hash = createHash("sha256");
    for (const table of applicationTables) {
      hash.update(table);
      for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).iterate()) hash.update(JSON.stringify(row));
    }
    const receipts = db.prepare("SELECT id, receipt_mime_type, receipt_data_url FROM expenses WHERE receipt_data_url IS NOT NULL ORDER BY id").all();
    const receiptHash = createHash("sha256");
    let receiptBytes = 0;
    for (const row of receipts) {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(String(row.receipt_data_url));
      if (!match || match[1] !== row.receipt_mime_type) throw new Error("Backup contains invalid receipt metadata or encoding.");
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.toString("base64") !== match[2]) throw new Error("Backup contains a malformed receipt payload.");
      receiptHash.update(String(row.id)); receiptHash.update(bytes); receiptBytes += bytes.length;
    }
    return { content: hash.digest("hex"), receipts: receiptHash.digest("hex"), receiptCount: receipts.length, receiptBytes };
  } finally { db.close(); }
}

function verifyRestoreCopy(backupPath) {
  const originalCounts = inspectApplicationDatabase(backupPath);
  const originalContent = contentFingerprint(backupPath);
  const directory = mkdtempSync(join(tmpdir(), "expense-report-restore-check-"));
  const restoredPath = join(directory, "restored.sqlite");
  try {
    copyFileExclusively(backupPath, restoredPath);
    const restoredCounts = inspectApplicationDatabase(restoredPath);
    if (JSON.stringify(restoredCounts) !== JSON.stringify(originalCounts)) {
      throw new Error("Restored database counts do not match the backup.");
    }
    if (JSON.stringify(contentFingerprint(restoredPath)) !== JSON.stringify(originalContent)) throw new Error("Restored content or receipt bytes do not match the backup.");
    return restoredCounts;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function createApplicationBackup(destinationArgument) {
  if (!destinationArgument) {
    throw new Error("Choose a backup file path. Usage: node scripts/backup-db.mjs <backup.sqlite>");
  }
  const sourcePath = resolve(process.env.EXPENSE_REPORT_DB_PATH ?? ".data/expense-report.sqlite");
  const destinationPath = resolve(destinationArgument);
  if (!existsSync(sourcePath)) throw new Error(`Expense Report database does not exist: ${sourcePath}`);
  if (sourcePath === destinationPath) throw new Error("The backup path must differ from the live database path.");
  if (existsSync(destinationPath)) throw new Error(`Backup already exists and will not be overwritten: ${destinationPath}`);

  mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(destinationPath), `.${basename(destinationPath)}.${randomUUID()}.tmp`);
  let source;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    await backup(source, temporaryPath);
    source.close();
    source = undefined;
    inspectApplicationDatabase(temporaryPath);
    copyFileExclusively(temporaryPath, destinationPath);
    const counts = verifyRestoreCopy(destinationPath);
    console.log(`Backup and temporary restore check passed: ${destinationPath}`);
    console.log(`Included ${counts.users} users, ${counts.expenses} expenses, and ${counts.trips} trips.`);
  } finally {
    source?.close();
    rmSync(temporaryPath, { force: true });
  }
}

function verifyExistingBackup(pathArgument) {
  if (!pathArgument) throw new Error("Choose a backup file path. Usage: node scripts/backup-db.mjs --verify <backup.sqlite>");
  const backupPath = resolve(pathArgument);
  if (!existsSync(backupPath)) throw new Error(`Backup file does not exist: ${backupPath}`);
  const counts = verifyRestoreCopy(backupPath);
  console.log(`Restore copy passed integrity, relationships, schema, content, and receipt-byte checks: ${backupPath}`);
  console.log(`Included ${counts.users} users, ${counts.expenses} expenses, and ${counts.trips} trips.`);
}

async function runSyntheticSelfTest() {
  const directory = mkdtempSync(join(tmpdir(), "expense-report-backup-self-test-"));
  const backupPath = join(directory, "backup.sqlite");
  const restoredPath = join(directory, "restored.sqlite");
  let source;
  const previousEnvironment = process.env.NODE_ENV;
  const previousDatabasePath = process.env.EXPENSE_REPORT_DB_PATH;
  try {
    process.env.NODE_ENV = "test";
    const { createTestDatabase } = await import("../src/lib/server/db.ts");
    source = createTestDatabase();
    const now = "2026-10-19T12:00:00.000Z";
    source.prepare("INSERT INTO users (id,issuer,subject,display_name,access_status,created_at,updated_at) VALUES ('synthetic','synthetic','synthetic','Synthetic Employee','active',?,?)").run(now, now);
    source.prepare("INSERT INTO roles (user_id,role,granted_at) VALUES ('synthetic','employee',?)").run(now);
    source.prepare("INSERT INTO profiles(user_id,profile_json,updated_at) VALUES ('synthetic',?,?)").run(JSON.stringify({ driverName: "Synthetic Employee", businessName: "Synthetic Business", vehicleDescription: "Synthetic vehicle", businessUseStartDate: "2026-01-01" }), now);
    source.prepare("INSERT INTO annual_mileage VALUES ('synthetic',2026,100,1000)").run();
    const payloads = [
      { id: "11111111-1111-4111-8111-111111111111", mime: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=", "base64") },
      { id: "22222222-2222-4222-8222-222222222222", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4\nSynthetic receipt bytes\n%%EOF\n") },
    ];
    for (const receipt of payloads) source.prepare("INSERT INTO expenses(id,user_id,date,category,amount,payment_method,merchant,business_purpose,receipt_file_name,receipt_mime_type,receipt_data_url,created_at,updated_at) VALUES (?,'synthetic','2026-10-19','supplies',4250,'personal_card','Synthetic merchant','Synthetic purpose',?,?,?,?,?)").run(receipt.id, receipt.id, receipt.mime, "data:" + receipt.mime + ";base64," + receipt.bytes.toString("base64"), now, now);
    source.prepare("INSERT INTO trips(id,user_id,date,destination,business_purpose,start_tenths,end_tenths,created_at,updated_at) VALUES ('33333333-3333-4333-8333-333333333333','synthetic','2026-10-19','Synthetic office','Synthetic purpose',100,200,?,?)").run(now, now);
    source.prepare("INSERT INTO mileage_rates(id,effective_from,cents_per_mile,created_by,created_at) VALUES ('rate','2026-01-01',70,'synthetic',?)").run(now);
    source.prepare("INSERT INTO record_history(id,record_type,record_id,owner_id,actor_id,action,details_json,created_at) VALUES ('history','expense',?,'synthetic','synthetic','created','{}',?)").run(payloads[0].id, now);
    source.prepare("INSERT INTO audit_events(id,actor_id,event_type,subject_user_id,details_json,created_at) VALUES ('audit','synthetic','synthetic_test','synthetic','{}',?)").run(now);
    await backup(source, backupPath);
    source.close();
    source = undefined;
    const backupCounts = inspectApplicationDatabase(backupPath);
    copyFileExclusively(backupPath, restoredPath);
    const restoredCounts = inspectApplicationDatabase(restoredPath);
    if (JSON.stringify(backupCounts) !== JSON.stringify(restoredCounts) || backupCounts.users !== 1 || backupCounts.expenses !== 2 || backupCounts.trips !== 1) {
      throw new Error("Synthetic rows did not survive the backup restore check.");
    }
    verifyRestoreCopy(backupPath);
    const receiptRows = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      for (const receipt of payloads) {
        const row = receiptRows.prepare("SELECT receipt_data_url FROM expenses WHERE id=?").get(receipt.id);
        if (row.receipt_data_url !== "data:" + receipt.mime + ";base64," + receipt.bytes.toString("base64")) throw new Error("Synthetic receipt bytes changed during restore.");
      }
    } finally { receiptRows.close(); }
    process.env.EXPENSE_REPORT_DB_PATH = backupPath;
    const scheduledOutput = join(directory, "daily", "expense-report-synthetic.sqlite");
    await createApplicationBackup(scheduledOutput);
    let overwriteRefused = false;
    try { await createApplicationBackup(scheduledOutput); } catch { overwriteRefused = true; }
    if (!overwriteRefused) throw new Error("Existing backup overwrite was not refused.");
    console.log("Synthetic real-schema backup/restore passed: accounts, roles, profiles, annual readings, trips, expenses, history, audit, PNG and PDF receipt bytes.");
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment;
    if (previousDatabasePath === undefined) delete process.env.EXPENSE_REPORT_DB_PATH; else process.env.EXPENSE_REPORT_DB_PATH = previousDatabasePath;
    source?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  const [mode, path] = process.argv.slice(2);
  if (mode === "--self-test") await runSyntheticSelfTest();
  else if (mode === "--daily-dir") {
    if (!path) throw new Error("Choose the approved backup directory.");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await createApplicationBackup(join(resolve(path), "expense-report-" + stamp + ".sqlite"));
  }
  else if (mode === "--verify") verifyExistingBackup(path);
  else await createApplicationBackup(mode);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Database backup failed.");
  process.exitCode = 1;
}
