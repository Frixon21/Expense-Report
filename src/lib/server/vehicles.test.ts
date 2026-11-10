import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTestDatabase, setTestDatabase, getUser } from "./db";
import { ensureVehicleData, vehicleState } from "./vehicle-store";
import {
  loadEmployeeSnapshot,
  saveEmployeeSnapshot,
  payrollSnapshot,
} from "./records";
import { annualMileageComplete, type MileageState } from "../model";
import { createReport } from "../pdf";
import { PDFDocument, PDFPage } from "pdf-lib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPayrollEmployeeReport } from "../payroll-pdf";
let db: DatabaseSync;
const now = "2026-10-29T12:00:00.000Z";
const profile = {
  driverName: "Synthetic Alice",
  businessName: "Synthetic",
  vehicleDescription: "Original car",
  businessUseStartDate: "2026-01-01",
};
beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("RESEND_DELIVERY_ENABLED", "false");
  db = createTestDatabase();
  setTestDatabase(db);
  for (const id of ["alice", "bob"]) {
    db.prepare("INSERT INTO users VALUES (?,'test',?,?,NULL,'active',?,?)").run(
      id,
      id,
      id,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO roles(user_id,role,granted_at) VALUES (?,'employee',?)",
    ).run(id, now);
    db.prepare("INSERT INTO profiles VALUES (?,?,?)").run(
      id,
      JSON.stringify({
        ...profile,
        driverName: id,
        vehicleDescription: id === "alice" ? "Original car" : "Bobs car",
      }),
      now,
    );
  }
});
afterEach(() => {
  setTestDatabase(null);
  db.close();
  vi.unstubAllEnvs();
});
const snapshot = () => loadEmployeeSnapshot(db, "alice");
const save = (state: MileageState) =>
  saveEmployeeSnapshot(getUser(db, "alice")!, { state, expenses: [] });
const trip = (vehicleId?: string) => ({
  id: randomUUID(),
  date: "2026-10-20",
  destination: "Test office",
  businessPurpose: "Test visit",
  start_tenths: 100,
  end_tenths: 200,
  parking_cents: 0,
  tolls_cents: 0,
  createdAt: now,
  ...(vehicleId ? { vehicleId } : {}),
});
it("maps existing trips and readings to that employee's current car exactly once", () => {
  const t = trip();
  db.prepare(
    "INSERT INTO trips(id,user_id,date,destination,business_purpose,start_tenths,end_tenths,created_at,updated_at) VALUES (?,'alice',?,'Office','Test',100,200,?,?)",
  ).run(t.id, t.date, now, now);
  db.prepare("INSERT INTO annual_mileage VALUES ('alice',2026,10,1000)").run();
  const a = snapshot().state;
  expect(a.vehicles).toHaveLength(1);
  expect(a.trips[0]).toMatchObject({
    vehicleId: a.defaultVehicleId,
    vehicleName: "Original car",
  });
  expect(a.annualMileage[0]).toMatchObject({
    vehicleId: a.defaultVehicleId,
    opening_tenths: 10,
  });
  ensureVehicleData(db, "alice");
  expect(snapshot().state.vehicles).toHaveLength(1);
  expect(vehicleState(db, "bob").defaultVehicleId).not.toBe(a.defaultVehicleId);
});
it("retains trips with missing legacy profile and warns instead of guessing", () => {
  db.prepare("DELETE FROM profiles WHERE user_id='alice'").run();
  const t = trip();
  db.prepare(
    "INSERT INTO trips(id,user_id,date,destination,business_purpose,start_tenths,end_tenths,created_at,updated_at) VALUES (?,'alice',?,'Office','Test',100,200,?,?)",
  ).run(t.id, t.date, now, now);
  const a = snapshot().state;
  expect(a.trips).toHaveLength(1);
  expect(a.trips[0].vehicleId).toBeUndefined();
  expect(a.vehicles).toHaveLength(0);
  expect(a.vehicleMigrationWarning).toContain("retained");
});
it("supports more than three cars, explicit default, separate readings and payroll labels", () => {
  let a: MileageState = snapshot().state;
  const more = Array.from({ length: 4 }, (_, i) => ({
    id: randomUUID(),
    description: `Car ${i + 2}`,
    businessUseStartDate: "2026-01-01",
    retired: false,
  }));
  a = {
    ...a,
    vehicles: [...a.vehicles!, ...more],
    defaultVehicleId: more[0].id,
    annualMileage: [
      {
        vehicleId: a.defaultVehicleId,
        year: 2026,
        opening_tenths: 0,
        closing_tenths: 200,
      },
      {
        vehicleId: more[0].id,
        year: 2026,
        opening_tenths: 10000,
        closing_tenths: 11000,
      },
    ],
    trips: [
      trip(a.defaultVehicleId),
      { ...trip(more[0].id), start_tenths: 10000, end_tenths: 10100 },
    ],
  };
  save(a);
  const b = snapshot().state;
  expect(b.vehicles).toHaveLength(5);
  expect(b.defaultVehicleId).toBe(more[0].id);
  expect(b.annualMileage.map((a) => a.opening_tenths)).toEqual(
    expect.arrayContaining([0, 10000]),
  );
  expect(b.trips.map((t) => t.vehicleName)).toEqual(
    expect.arrayContaining(["Original car", "Car 2"]),
  );
  db.prepare(
    "INSERT INTO roles(user_id,role,granted_at) VALUES ('alice','payroll',?)",
  ).run(now);
  expect(
    payrollSnapshot(getUser(db, "alice")!).trips.map((t) => t.vehicleName),
  ).toContain("Car 2");
});
it("rejects another employee's vehicle and annual reading without partial saves", () => {
  const a = snapshot().state,
    b = vehicleState(db, "bob");
  expect(() => save({ ...a, trips: [trip(b.defaultVehicleId)] })).toThrow(
    "Vehicle not found",
  );
  expect(() =>
    save({
      ...a,
      annualMileage: [
        {
          vehicleId: b.defaultVehicleId,
          year: 2026,
          opening_tenths: 1,
          closing_tenths: 2,
        },
      ],
    }),
  ).toThrow("Vehicle not found");
  expect(() =>
    save({ ...a, vehicles: [...a.vehicles!, b.vehicles[0]] }),
  ).toThrow("Vehicle not found");
  expect(snapshot().state.trips).toHaveLength(0);
});
it("preserves trip name through profile rename and rejects forged snapshots", () => {
  let a: MileageState = snapshot().state;
  save({
    ...a,
    trips: [{ ...trip(a.defaultVehicleId), vehicleName: "Forged name" }],
  });
  a = snapshot().state;
  expect(a.trips[0].vehicleName).toBe("Original car");
  save({
    ...a,
    profile: { ...a.profile!, vehicleDescription: "Renamed car" },
    vehicles: a.vehicles!.map((v) => ({ ...v, description: "Renamed car" })),
  });
  expect(snapshot().state.trips[0].vehicleName).toBe("Original car");
  expect(snapshot().state.vehicles![0].description).toBe("Renamed car");
});
it("keeps historical retired vehicle while preventing new trips and preserving processed locks", () => {
  let a: MileageState = snapshot().state;
  save({ ...a, trips: [trip(a.defaultVehicleId)] });
  a = snapshot().state;
  const v = {
    id: randomUUID(),
    description: "New car",
    businessUseStartDate: "2026-01-01",
    retired: false,
  };
  save({
    ...a,
    vehicles: [...a.vehicles!.map((v) => ({ ...v, retired: true })), v],
    defaultVehicleId: v.id,
  });
  a = snapshot().state;
  expect(() =>
    save({ ...a, trips: [...a.trips, trip(a.trips[0].vehicleId)] }),
  ).toThrow("active vehicle");
  save({
    ...a,
    trips: a.trips.map((t) => ({ ...t, businessPurpose: "Edited purpose" })),
  });
  a = snapshot().state;
  db.prepare(
    "UPDATE trips SET status='Processed',ever_processed=1 WHERE id=?",
  ).run(a.trips[0].id);
  expect(() =>
    save({ ...a, trips: a.trips.map((t) => ({ ...t, vehicleId: v.id })) }),
  ).toThrow("Processed mileage");
});
it("rolls vehicle and trip changes back when audit fails", () => {
  const a = snapshot().state;
  db.exec(
    "CREATE TRIGGER fail_vehicle BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
  );
  expect(() =>
    save({
      ...a,
      vehicles: [
        ...a.vehicles!,
        {
          id: randomUUID(),
          description: "Test",
          businessUseStartDate: "2026-01-01",
          retired: false,
        },
      ],
    }),
  ).toThrow("audit unavailable");
  expect(snapshot().state.vehicles).toHaveLength(1);
});
it("requires each used vehicle's annual readings and produces separate PDF pages", async () => {
  let a: MileageState = snapshot().state;
  const v = {
    id: randomUUID(),
    description: "Second car",
    businessUseStartDate: "2026-02-01",
    retired: false,
  };
  a = {
    ...a,
    vehicles: [...a.vehicles!, v],
    trips: [trip(a.defaultVehicleId), trip(v.id)],
    annualMileage: [
      {
        vehicleId: a.defaultVehicleId,
        year: 2026,
        opening_tenths: 0,
        closing_tenths: 1000,
      },
    ],
  };
  expect(annualMileageComplete(a, 2026)).toBe(false);
  await expect(
    createReport({ state: a, from: "2026-01-01", to: "2026-12-31" }),
  ).rejects.toThrow("odometer");
  a.annualMileage.push({
    vehicleId: v.id,
    year: 2026,
    opening_tenths: 0,
    closing_tenths: 2000,
  });
  expect(annualMileageComplete(a, 2026)).toBe(true);
  const pdf = await PDFDocument.load(
    await createReport({ state: a, from: "2026-01-01", to: "2026-12-31" }),
  );
  expect(pdf.getPageCount()).toBe(2);
});

it("renders matching vehicle labels in payroll PDF and writes an optional synthetic preview", async () => {
  let a: MileageState = snapshot().state;
  const v = {
    id: randomUUID(),
    description: "Second car",
    businessUseStartDate: "2026-02-01",
    retired: false,
  };
  a = {
    ...a,
    vehicles: [...a.vehicles!, v],
    trips: [
      { ...trip(a.defaultVehicleId), vehicleName: "Original car" },
      {
        ...trip(v.id),
        vehicleName: "Second car",
        start_tenths: 90000,
        end_tenths: 90100,
      },
    ],
  };
  const draw = vi.spyOn(PDFPage.prototype, "drawText");
  const bytes = await createPayrollEmployeeReport({
    employee: {
      id: "alice",
      state: a,
      expenses: [],
      tripMeta: {},
      expenseMeta: {},
    },
    from: "2026-10-01",
    to: "2026-10-31",
    dollarsPerMile: 0.7,
  });
  const texts = draw.mock.calls.map((c) => c[0]).join(" ");
  draw.mockRestore();
  expect(texts).toContain("Vehicle: Original car");
  expect(texts).toContain("Vehicle: Second car");
  if (process.env.VEHICLE_PREVIEW_DIR) {
    mkdirSync(process.env.VEHICLE_PREVIEW_DIR, { recursive: true });
    writeFileSync(
      join(process.env.VEHICLE_PREVIEW_DIR, "vehicle-payroll-preview.pdf"),
      bytes,
    );
    writeFileSync(
      join(process.env.VEHICLE_PREVIEW_DIR, "vehicle-mileage-preview.pdf"),
      await createReport({ state: a, from: "2026-10-01", to: "2026-10-31" }),
    );
  }
});

it("uses only the owner's historical profile snapshot and preserves paid status", () => {
  const t = trip();
  db.prepare(
    "INSERT INTO trips(id,user_id,date,destination,business_purpose,start_tenths,end_tenths,status,ever_processed,created_at,updated_at) VALUES (?,'alice',?,'Office','Test',100,200,'Paid',1,?,?)",
  ).run(t.id, t.date, now, now);
  for (const [owner, name] of [
    ["alice", "Alice previous car"],
    ["bob", "Bobs unrelated car"],
  ])
    db.prepare(
      "INSERT INTO record_history(id,record_type,record_id,owner_id,actor_id,action,details_json,created_at) VALUES (?,'profile',?,?,?,'updated',?,?)",
    ).run(
      randomUUID(),
      owner,
      owner,
      owner,
      JSON.stringify({ ...profile, vehicleDescription: name }),
      "2026-10-01T00:00:00.000Z",
    );
  const a = snapshot().state;
  expect(a.trips[0]).toMatchObject({
    vehicleName: "Alice previous car",
    status: "Paid",
    everProcessed: true,
  });
  expect(a.vehicles?.find((v) => v.id === a.trips[0].vehicleId)?.retired).toBe(
    true,
  );
  expect(a.vehicles?.some((v) => v.description === "Bobs unrelated car")).toBe(
    false,
  );
  expect(
    a.vehicles?.find((v) => v.id === a.defaultVehicleId)?.description,
  ).toBe("Original car");
});
