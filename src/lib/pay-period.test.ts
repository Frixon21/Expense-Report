import { describe, expect, it } from "vitest";
import {
  biweeklyPayPeriod,
  payPeriodAtIndex,
  payPeriodIndexForDate,
} from "./pay-period";

describe("biweeklyPayPeriod", () => {
  it("keeps Sep 13–27 through period end and the payroll window", () => {
    for (const day of ["2026-09-20", "2026-09-27", "2026-09-28", "2026-10-01", "2026-10-02"]) {
      expect(biweeklyPayPeriod(new Date(`${day}T12:00:00Z`))).toEqual({
        from: "2026-09-13",
        to: "2026-09-27",
      });
    }
  });

  it("advances after payroll date", () => {
    expect(biweeklyPayPeriod(new Date("2026-10-03T12:00:00Z"))).toEqual({
      from: "2026-09-28",
      to: "2026-10-12",
    });
  });

  it("steps previous and next by index", () => {
    expect(payPeriodIndexForDate(new Date("2026-10-02T12:00:00Z"))).toBe(0);
    expect(payPeriodAtIndex(1)).toEqual({
      from: "2026-09-28",
      to: "2026-10-12",
      payrollDate: "2026-10-17",
    });
  });
});
