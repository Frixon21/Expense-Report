/** First biweekly accrual period (Biztech payroll demo / config). */
export const PAY_PERIOD_ANCHOR = {
  periodStart: "2026-09-13",
  periodEnd: "2026-09-27",
  /** Days added to period start to get period end (Sep 13 → Sep 27). */
  periodSpanDays: 14,
  /** Payroll runs this many calendar days after period end (Sep 27 → Oct 2). */
  paydayLagDays: 5,
} as const;

export type PayPeriodRange = {
  from: string;
  to: string;
  payrollDate: string;
};

export function addCalendarDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildPayPeriod(from: string, to: string): PayPeriodRange {
  return {
    from,
    to,
    payrollDate: addCalendarDays(to, PAY_PERIOD_ANCHOR.paydayLagDays),
  };
}

export function anchorPayPeriod(): PayPeriodRange {
  return buildPayPeriod(
    PAY_PERIOD_ANCHOR.periodStart,
    PAY_PERIOD_ANCHOR.periodEnd,
  );
}

export function nextPayPeriod(
  period: Pick<PayPeriodRange, "from" | "to">,
): PayPeriodRange {
  const from = addCalendarDays(period.to, 1);
  const to = addCalendarDays(from, PAY_PERIOD_ANCHOR.periodSpanDays);
  return buildPayPeriod(from, to);
}

/**
 * Stays on a period through its payroll date. Sep 28–Oct 2 (inclusive) still
 * use Sep 13–27; advances after Oct 2.
 */
export function payPeriodIndexForDate(reference = new Date()): number {
  const today = reference.toLocaleDateString("en-CA");
  let index = 0;
  let period = anchorPayPeriod();
  while (today > period.payrollDate) {
    index += 1;
    period = nextPayPeriod(period);
  }
  return index;
}

export function payPeriodAtIndex(index: number): PayPeriodRange {
  const safeIndex = Math.max(0, index);
  let period = anchorPayPeriod();
  for (let i = 0; i < safeIndex; i++) {
    period = nextPayPeriod(period);
  }
  return period;
}

export function biweeklyPayPeriod(reference = new Date()) {
  const period = payPeriodAtIndex(payPeriodIndexForDate(reference));
  return { from: period.from, to: period.to };
}
