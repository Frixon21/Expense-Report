import { describe, expect, it } from "vitest";
import type { Expense } from "./expense";
import type { Trip } from "./model";
import { mergeExpensesWithPayrollLocks, mergeTripsWithPayrollLocks } from "./payroll-lock";

const trip = (id: string, date: string): Trip => ({
  id,
  date,
  destination: "Test",
  businessPurpose: "Test",
  start_tenths: 100,
  end_tenths: 110,
  parking_cents: 0,
  tolls_cents: 0,
  createdAt: `${date}T12:00:00.000Z`,
});

const expense = (id: string, date: string): Expense => ({
  id,
  date,
  category: "supplies",
  amount: 1000,
  paymentMethod: "cash",
  merchant: "Shop",
  businessPurpose: "Test",
  createdAt: `${date}T12:00:00.000Z`,
});

describe("payroll locks", () => {
  it("restores locked trips when an employee tries to edit or delete", () => {
    const previous = [trip("a1000001-0001-4001-8001-000000000001", "2026-09-01")];
    const edited = [
      {
        ...previous[0],
        destination: "Changed",
      },
    ];
    const meta = {
      "a1000001-0001-4001-8001-000000000001": {
        processed: true,
        paid: false,
      },
    };
    expect(mergeTripsWithPayrollLocks(previous, edited, meta)[0].destination).toBe(
      "Test",
    );
    expect(
      mergeTripsWithPayrollLocks(previous, [], meta),
    ).toHaveLength(1);
  });

  it("restores locked expenses when an employee tries to edit or delete", () => {
    const previous = [
      expense("a1000001-0001-4001-8001-000000000101", "2026-09-01"),
    ];
    const edited = [{ ...previous[0], merchant: "Changed" }];
    const meta = {
      "a1000001-0001-4001-8001-000000000101": {
        processed: false,
        paid: true,
      },
    };
    expect(
      mergeExpensesWithPayrollLocks(previous, edited, meta)[0].merchant,
    ).toBe("Shop");
  });
});
