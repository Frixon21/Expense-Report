import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MileageState, Vehicle } from "../model";

type VehicleRow = {
  id: string;
  user_id: string;
  description: string;
  business_use_start_date: string;
  retired: number;
};
const readJson = (value: unknown): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};
const usableName = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, 150) : null;
const validDate = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
export function initializeVehicleSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS vehicles (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), description TEXT NOT NULL,
    business_use_start_date TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(id,user_id));
    CREATE TABLE IF NOT EXISTS vehicle_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id), default_vehicle_id TEXT,
    migration_completed_at TEXT, migration_warning TEXT,
    FOREIGN KEY(default_vehicle_id,user_id) REFERENCES vehicles(id,user_id));
    CREATE TABLE IF NOT EXISTS vehicle_annual_mileage (
    user_id TEXT NOT NULL REFERENCES users(id), vehicle_id TEXT NOT NULL, year INTEGER NOT NULL,
    opening_tenths INTEGER, closing_tenths INTEGER,
    PRIMARY KEY(user_id,vehicle_id,year),FOREIGN KEY(vehicle_id,user_id) REFERENCES vehicles(id,user_id));`);
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(trips)")
      .all()
      .map((r) => String(r.name)),
  );
  for (const [name, type] of Object.entries({
    vehicle_id: "TEXT REFERENCES vehicles(id)",
    vehicle_name: "TEXT",
    vehicle_business_use_start_date: "TEXT",
  }))
    if (!columns.has(name))
      db.exec(`ALTER TABLE trips ADD COLUMN ${name} ${type}`);
  const users = db
    .prepare("SELECT user_id FROM profiles UNION SELECT user_id FROM trips")
    .all();
  for (const row of users) ensureVehicleData(db, String(row.user_id));
}
function createVehicle(
  db: DatabaseSync,
  userId: string,
  name: string,
  start: string,
  retired = false,
) {
  const id = randomUUID(),
    now = new Date().toISOString();
  db.prepare("INSERT INTO vehicles VALUES (?,?,?,?,?,?,?)").run(
    id,
    userId,
    name,
    start,
    retired ? 1 : 0,
    now,
    now,
  );
  return id;
}
function migrateUser(db: DatabaseSync, userId: string) {
  const profileRow = db
    .prepare("SELECT profile_json FROM profiles WHERE user_id=?")
    .get(userId);
  const profile = readJson(profileRow?.profile_json),
    name = usableName(profile.vehicleDescription),
    start = validDate(profile.businessUseStartDate) ?? "";
  let pref = db
    .prepare("SELECT * FROM vehicle_preferences WHERE user_id=?")
    .get(userId);
  if (!pref) {
    db.prepare("INSERT INTO vehicle_preferences(user_id) VALUES (?)").run(
      userId,
    );
    pref = {};
  }
  let defaultId = pref.default_vehicle_id
    ? String(pref.default_vehicle_id)
    : null;
  if (!defaultId && name) {
    const existing = db
      .prepare(
        "SELECT id FROM vehicles WHERE user_id=? AND description=? AND retired=0 ORDER BY created_at LIMIT 1",
      )
      .get(userId, name);
    defaultId = existing
      ? String(existing.id)
      : createVehicle(db, userId, name, start);
    db.prepare(
      "UPDATE vehicle_preferences SET default_vehicle_id=? WHERE user_id=?",
    ).run(defaultId, userId);
  }
  // Old imports/clients may add an unassigned trip later, so backfill is idempotent rather than one-shot.
  const trips = db
    .prepare(
      "SELECT id,created_at FROM trips WHERE user_id=? AND vehicle_id IS NULL",
    )
    .all(userId);
  for (const trip of defaultId ? trips : []) {
    let snapshot: Record<string, unknown> = {};
    const explicit = db
      .prepare(
        "SELECT details_json FROM record_history WHERE owner_id=? AND record_type='trip' AND record_id=? AND action='created' ORDER BY created_at LIMIT 1",
      )
      .get(userId, trip.id);
    const details = readJson(explicit?.details_json);
    if (usableName(details.vehicleName ?? details.vehicleDescription))
      snapshot = {
        vehicleDescription: details.vehicleName ?? details.vehicleDescription,
        businessUseStartDate: details.vehicleBusinessUseStartDate,
      };
    else {
      const historical = db
        .prepare(
          "SELECT details_json FROM record_history WHERE owner_id=? AND record_type='profile' AND action IN ('created','updated') AND created_at<=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(userId, trip.created_at);
      snapshot = readJson(historical?.details_json);
    }
    const historicalName = usableName(snapshot.vehicleDescription),
      tripName = historicalName ?? name;
    if (!tripName || !defaultId) continue;
    const tripStart = validDate(snapshot.businessUseStartDate) ?? start;
    let id = defaultId;
    if (tripName !== name) {
      const prior = db
        .prepare(
          "SELECT id FROM vehicles WHERE user_id=? AND description=? ORDER BY created_at LIMIT 1",
        )
        .get(userId, tripName);
      id = prior
        ? String(prior.id)
        : createVehicle(db, userId, tripName, tripStart, true);
    }
    db.prepare(
      "UPDATE trips SET vehicle_id=?,vehicle_name=?,vehicle_business_use_start_date=? WHERE id=? AND user_id=? AND vehicle_id IS NULL",
    ).run(id, tripName, tripStart, trip.id, userId);
  }
  // Copy, never delete, legacy readings. They belong to the employee's original default car.
  if (defaultId && !pref.migration_completed_at)
    db.prepare(
      "INSERT OR IGNORE INTO vehicle_annual_mileage SELECT user_id,?,year,opening_tenths,closing_tenths FROM annual_mileage WHERE user_id=?",
    ).run(defaultId, userId);
  const missing = Number(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM trips WHERE user_id=? AND vehicle_id IS NULL",
      )
      .get(userId)?.count ?? 0,
  );
  const warning = missing
    ? "Some existing trips have no saved vehicle profile. They were retained; confirm your current vehicle in Settings before reviewing those records."
    : null;
  db.prepare(
    "UPDATE vehicle_preferences SET migration_completed_at=CASE WHEN ? IS NOT NULL THEN COALESCE(migration_completed_at,?) ELSE migration_completed_at END,migration_warning=? WHERE user_id=?",
  ).run(defaultId, new Date().toISOString(), warning, userId);
}
export function ensureVehicleData(db: DatabaseSync, userId: string) {
  if (db.isTransaction) {
    migrateUser(db, userId);
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    migrateUser(db, userId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function vehicleState(db: DatabaseSync, userId: string) {
  ensureVehicleData(db, userId);
  const pref = db
    .prepare(
      "SELECT default_vehicle_id,migration_warning FROM vehicle_preferences WHERE user_id=?",
    )
    .get(userId);
  const rows = db
    .prepare("SELECT * FROM vehicles WHERE user_id=? ORDER BY created_at,id")
    .all(userId) as unknown as VehicleRow[];
  return {
    vehicles: rows.map((r) => ({
      id: r.id,
      description: r.description,
      businessUseStartDate: r.business_use_start_date,
      retired: Boolean(r.retired),
    })),
    ...(pref?.default_vehicle_id
      ? { defaultVehicleId: String(pref.default_vehicle_id) }
      : {}),
    ...(pref?.migration_warning
      ? { vehicleMigrationWarning: String(pref.migration_warning) }
      : {}),
  };
}
function audit(
  db: DatabaseSync,
  userId: string,
  event: string,
  details: unknown,
) {
  db.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?,?)").run(
    randomUUID(),
    userId,
    event,
    userId,
    JSON.stringify(details),
    new Date().toISOString(),
  );
}
export function saveVehicles(
  db: DatabaseSync,
  userId: string,
  state: MileageState,
  fail: (status: number, message: string) => Error,
) {
  ensureVehicleData(db, userId);
  const before = vehicleState(db, userId),
    now = new Date().toISOString();
  const seen = new Set<string>();
  for (const vehicle of state.vehicles ?? []) {
    if (seen.has(vehicle.id))
      throw fail(400, "Each vehicle must have a unique ID.");
    seen.add(vehicle.id);
    const old = db
      .prepare("SELECT * FROM vehicles WHERE id=?")
      .get(vehicle.id) as VehicleRow | undefined;
    if (old && old.user_id !== userId) throw fail(404, "Vehicle not found.");
    if (!old && !validDate(vehicle.businessUseStartDate))
      throw fail(400, "Choose the vehicle business-use start date.");
    if (!old) {
      db.prepare("INSERT INTO vehicles VALUES (?,?,?,?,?,?,?)").run(
        vehicle.id,
        userId,
        vehicle.description,
        vehicle.businessUseStartDate,
        vehicle.retired ? 1 : 0,
        now,
        now,
      );
      audit(db, userId, "vehicle_created", {
        vehicleId: vehicle.id,
        description: vehicle.description,
      });
    } else if (
      old.description !== vehicle.description ||
      old.business_use_start_date !== vehicle.businessUseStartDate ||
      Boolean(old.retired) !== vehicle.retired
    ) {
      db.prepare(
        "UPDATE vehicles SET description=?,business_use_start_date=?,retired=?,updated_at=? WHERE id=? AND user_id=?",
      ).run(
        vehicle.description,
        vehicle.businessUseStartDate,
        vehicle.retired ? 1 : 0,
        now,
        vehicle.id,
        userId,
      );
      audit(
        db,
        userId,
        vehicle.retired && !old.retired ? "vehicle_retired" : "vehicle_updated",
        {
          vehicleId: vehicle.id,
          description: vehicle.description,
          retired: vehicle.retired,
        },
      );
    }
  }
  // Legacy profile edits rename only the default vehicle; existing trip snapshots remain unchanged.
  if (
    state.vehicles === undefined &&
    state.profile &&
    before.defaultVehicleId
  ) {
    db.prepare(
      "UPDATE vehicles SET description=?,business_use_start_date=?,updated_at=? WHERE id=? AND user_id=?",
    ).run(
      state.profile.vehicleDescription,
      state.profile.businessUseStartDate,
      now,
      before.defaultVehicleId,
      userId,
    );
  }
  const defaultId = state.defaultVehicleId ?? before.defaultVehicleId;
  if (defaultId) {
    const selected = db
      .prepare("SELECT * FROM vehicles WHERE id=? AND user_id=?")
      .get(defaultId, userId) as VehicleRow | undefined;
    if (!selected || selected.retired)
      throw fail(
        400,
        "Choose an active default vehicle before retiring the current default.",
      );
    db.prepare(
      "UPDATE vehicle_preferences SET default_vehicle_id=? WHERE user_id=?",
    ).run(defaultId, userId);
    if (defaultId !== before.defaultVehicleId)
      audit(db, userId, "default_vehicle_changed", { vehicleId: defaultId });
    if (state.profile) {
      state.profile = {
        ...state.profile,
        vehicleDescription: selected.description,
        businessUseStartDate: selected.business_use_start_date,
      };
      db.prepare("UPDATE profiles SET profile_json=? WHERE user_id=?").run(
        JSON.stringify(state.profile),
        userId,
      );
    }
  }
  return vehicleState(db, userId);
}
export function vehicleAnnualRows(
  db: DatabaseSync,
  userId: string,
  defaultId?: string,
) {
  return defaultId
    ? db
        .prepare(
          "SELECT vehicle_id AS vehicleId,year,opening_tenths,closing_tenths FROM vehicle_annual_mileage WHERE user_id=? ORDER BY year,vehicle_id",
        )
        .all(userId)
    : db
        .prepare(
          "SELECT year,opening_tenths,closing_tenths FROM annual_mileage WHERE user_id=? ORDER BY year",
        )
        .all(userId);
}
