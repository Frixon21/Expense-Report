/** User-approved working assumption; exact payroll boundaries are not payroll-verified. */
export const PAY_PERIOD_ANCHOR = {
  periodStart: "2026-09-26",
  periodEnd: "2026-10-09",
  /** Number of calendar dates included in each earning period. */
  periodLengthDays: 14,
  /** Payday is seven calendar days after the inclusive earning-period end. */
  paydayLagDays: 7,
} as const;

export type PayPeriodRange = {
  from: string;
  to: string;
  payrollDate: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function calendarDay(isoDate: string) {
  return Math.floor(new Date(isoDate + "T12:00:00Z").getTime() / DAY_MS);
}

function localCalendarDate(reference: Date) {
  return [reference.getFullYear(), String(reference.getMonth() + 1).padStart(2, "0"), String(reference.getDate()).padStart(2, "0")].join("-");
}

export function addCalendarDays(isoDate: string, days: number): string {
  const date = new Date(isoDate + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildPayPeriod(from: string, to: string): PayPeriodRange {
  return { from, to, payrollDate: addCalendarDays(to, PAY_PERIOD_ANCHOR.paydayLagDays) };
}

export function anchorPayPeriod(): PayPeriodRange {
  return buildPayPeriod(PAY_PERIOD_ANCHOR.periodStart, PAY_PERIOD_ANCHOR.periodEnd);
}

export function nextPayPeriod(period: Pick<PayPeriodRange, "from" | "to">): PayPeriodRange {
  const from = addCalendarDays(period.to, 1);
  return buildPayPeriod(from, addCalendarDays(from, PAY_PERIOD_ANCHOR.periodLengthDays - 1));
}

/**
 * Select the earning period for the next payday, including payday itself.
 * Oct 16 selects Sep 26-Oct 9; Oct 17-30 selects Oct 10-23.
 * Compare local calendar dates via UTC day numbers so DST cannot shift a cycle.
 */
export function payPeriodIndexForDate(reference = new Date()): number {
  const daysFromAnchorPayday = calendarDay(localCalendarDate(reference)) - calendarDay(anchorPayPeriod().payrollDate);
  const index = Math.ceil(daysFromAnchorPayday / PAY_PERIOD_ANCHOR.periodLengthDays);
  return index === 0 ? 0 : index;
}

export function payPeriodAtIndex(index: number): PayPeriodRange {
  if (!Number.isSafeInteger(index)) throw new RangeError("Choose an integer pay-period index.");
  const from = addCalendarDays(PAY_PERIOD_ANCHOR.periodStart, index * PAY_PERIOD_ANCHOR.periodLengthDays);
  return buildPayPeriod(from, addCalendarDays(from, PAY_PERIOD_ANCHOR.periodLengthDays - 1));
}

export function biweeklyPayPeriod(reference = new Date()) {
  const period = payPeriodAtIndex(payPeriodIndexForDate(reference));
  return { from: period.from, to: period.to };
}

export function payPeriodDatePresets(reference = new Date()) {
  const index = payPeriodIndexForDate(reference);
  return [
    { id: "current-pay-period", label: "Current pay period", ...payPeriodAtIndex(index) },
    { id: "previous-pay-period", label: "Previous pay period", ...payPeriodAtIndex(index - 1) },
  ];
}

/** Return a payday only when the selected inclusive range matches a full configured earning period. */
export function paydayForRange(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const offset = calendarDay(from) - calendarDay(PAY_PERIOD_ANCHOR.periodStart);
  if (!Number.isFinite(offset) || offset % PAY_PERIOD_ANCHOR.periodLengthDays !== 0) return null;
  const period = payPeriodAtIndex(offset / PAY_PERIOD_ANCHOR.periodLengthDays);
  return period.from === from && period.to === to ? period.payrollDate : null;
}
