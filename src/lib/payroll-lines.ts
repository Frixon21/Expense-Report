import type { Expense } from "./expense";
import type { Trip } from "./model";

export type PayrollMileageLine = {
  kind: "mileage";
  date: string;
  sortKey: string;
  trip: Trip;
};

export type PayrollExpenseLine = {
  kind: "expense";
  date: string;
  sortKey: string;
  expense: Expense;
};

export type PayrollLine = PayrollMileageLine | PayrollExpenseLine;

/** PDF inclusion is date-only and inclusive, for every status (including unpaid and voided). */
export function isPayrollRecordInRange(date: string, from: string, to: string) {
  return date >= from && date <= to;
}

const sortKey = (date: string, createdAt: string, suffix: string) =>
  `${date}T${createdAt}${suffix}`;

export function tripsInPayrollRange(trips: Trip[], from: string, to: string) {
  return trips
    .filter((trip) => isPayrollRecordInRange(trip.date, from, to))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt),
    );
}

export function expensesInPayrollRange(
  expenses: Expense[],
  from: string,
  to: string,
) {
  return expenses
    .filter((item) => isPayrollRecordInRange(item.date, from, to))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt),
    );
}

export function payrollLinesForEmployee(
  trips: Trip[],
  expenses: Expense[],
  from: string,
  to: string,
): PayrollLine[] {
  const lines: PayrollLine[] = [
    ...tripsInPayrollRange(trips, from, to).map((trip) => ({
      kind: "mileage" as const,
      date: trip.date,
      sortKey: sortKey(trip.date, trip.createdAt, "M"),
      trip,
    })),
    ...expensesInPayrollRange(expenses, from, to).map((expense) => ({
      kind: "expense" as const,
      date: expense.date,
      sortKey: sortKey(expense.date, expense.createdAt, "E"),
      expense,
    })),
  ];
  return lines.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}
