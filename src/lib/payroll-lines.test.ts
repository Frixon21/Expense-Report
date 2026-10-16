import { describe, expect, it } from "vitest";
import { payrollLinesForEmployee } from "./payroll-lines";
import type { Trip } from "./model";
import type { Expense } from "./expense";

const trip = (id: string, date: string, createdAt: string): Trip => ({
  id,
  date,
  createdAt,
  destination: "A",
  businessPurpose: "B",
  start_tenths: 100,
  end_tenths: 110,
  parking_cents: 0,
  tolls_cents: 0,
});

const expense = (id: string, date: string, createdAt: string): Expense => ({
  id,
  date,
  createdAt,
  category: "supplies",
  amount: 500,
  paymentMethod: "cash",
  merchant: "Shop",
  businessPurpose: "Test",
});

describe("payrollLinesForEmployee", () => {
  it("merges mileage and expenses oldest to newest", () => {
    const lines = payrollLinesForEmployee(
      [
        trip("t2", "2026-09-30", "2026-09-30T18:00:00.000Z"),
        trip("t1", "2026-09-28", "2026-09-28T12:00:00.000Z"),
      ],
      [
        expense("e1", "2026-09-29", "2026-09-29T12:00:00.000Z"),
        expense("e2", "2026-10-02", "2026-10-02T12:00:00.000Z"),
      ],
      "2026-09-01",
      "2026-10-31",
    );
    expect(lines.map((line) => line.date)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-02",
    ]);
  });
});
