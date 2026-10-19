import type { Expense } from "./expense";
import type { MileageState, Trip } from "./model";

export type TripPayrollMeta = {
  processed: boolean;
  paid: boolean;
  paidNote?: string;
  processedRateCentsPerMile?: number | null;
};

export type DemoEmployee = {
  id: string;
  state: MileageState;
  expenses: Expense[];
  tripMeta: Record<string, TripPayrollMeta>;
  expenseMeta: Record<string, TripPayrollMeta>;
};

export type DemoOrg = {
  version: 2;
  /** Reimbursement dollars per business mile (e.g. 0.7 for $0.70/mi). */
  dollarsPerMile: number;
  employees: DemoEmployee[];
};

export const defaultTripMeta = (): TripPayrollMeta => ({
  processed: false,
  paid: false,
});

export const isPayrollLocked = (meta: TripPayrollMeta) =>
  meta.processed || meta.paid;

export const payrollLockLabel = (meta: TripPayrollMeta) => {
  if (meta.paid) return "Paid — locked";
  if (meta.processed) return "Processed — locked";
  return "";
};

export const tripMiles = (trip: Trip) =>
  (trip.end_tenths - trip.start_tenths) / 10;

export const tripReimbursement = (trip: Trip, dollarsPerMile: number) =>
  tripMiles(trip) * dollarsPerMile;

export const employeeTripMeta = (
  employee: DemoEmployee,
  tripId: string,
): TripPayrollMeta =>
  employee.tripMeta[tripId] ?? defaultTripMeta();

export const employeeExpenseMeta = (
  employee: DemoEmployee,
  expenseId: string,
): TripPayrollMeta =>
  employee.expenseMeta[expenseId] ?? defaultTripMeta();
