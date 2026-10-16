import {
  defaultTripMeta,
  isPayrollLocked,
  type TripPayrollMeta,
} from "./demo-types";
import type { Expense } from "./expense";
import type { Trip } from "./model";

const metaFor = (
  meta: Record<string, TripPayrollMeta>,
  id: string,
): TripPayrollMeta => meta[id] ?? defaultTripMeta();

/** Keep payroll-locked rows unchanged and prevent deletion. */
export function mergeTripsWithPayrollLocks(
  previous: Trip[],
  next: Trip[],
  tripMeta: Record<string, TripPayrollMeta>,
): Trip[] {
  const prevById = new Map(previous.map((trip) => [trip.id, trip]));
  const locked = new Set(
    [...previous, ...next]
      .map((trip) => trip.id)
      .filter((id) => isPayrollLocked(metaFor(tripMeta, id))),
  );
  const merged = next.map((trip) =>
    locked.has(trip.id) ? (prevById.get(trip.id) ?? trip) : trip,
  );
  for (const trip of previous) {
    if (locked.has(trip.id) && !merged.some((item) => item.id === trip.id)) {
      merged.push(trip);
    }
  }
  return merged;
}

export function mergeExpensesWithPayrollLocks(
  previous: Expense[],
  next: Expense[],
  expenseMeta: Record<string, TripPayrollMeta>,
): Expense[] {
  const prevById = new Map(previous.map((item) => [item.id, item]));
  const locked = new Set(
    [...previous, ...next]
      .map((item) => item.id)
      .filter((id) => isPayrollLocked(metaFor(expenseMeta, id))),
  );
  const merged = next.map((item) =>
    locked.has(item.id) ? (prevById.get(item.id) ?? item) : item,
  );
  for (const item of previous) {
    if (locked.has(item.id) && !merged.some((row) => row.id === item.id)) {
      merged.push(item);
    }
  }
  return merged;
}
