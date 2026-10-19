import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PAY_PERIOD_ANCHOR, addCalendarDays, anchorPayPeriod, biweeklyPayPeriod,
  nextPayPeriod, paydayForRange, payPeriodAtIndex, payPeriodDatePresets, payPeriodIndexForDate,
} from "./pay-period";

const localDate = (iso: string) => new Date(iso + "T12:00:00");

describe("provisional biweekly payroll schedule", () => {
  it("uses Sep 26-Oct 9 inclusive, paid Oct 16, as the working anchor", () => {
    expect(PAY_PERIOD_ANCHOR.periodLengthDays).toBe(14);
    expect(PAY_PERIOD_ANCHOR.paydayLagDays).toBe(7);
    expect(anchorPayPeriod()).toEqual({ from: "2026-09-26", to: "2026-10-09", payrollDate: "2026-10-16" });
    expect(nextPayPeriod(anchorPayPeriod())).toEqual({ from: "2026-10-10", to: "2026-10-23", payrollDate: "2026-10-30" });
  });

  it("keeps the current earning period through payday, then advances the next day", () => {
    for (const day of ["2026-10-03", "2026-10-09", "2026-10-10", "2026-10-16"]) {
      expect(payPeriodIndexForDate(localDate(day))).toBe(0);
      expect(biweeklyPayPeriod(localDate(day))).toEqual({ from: "2026-09-26", to: "2026-10-09" });
    }
    for (const day of ["2026-10-17", "2026-10-19", "2026-10-23", "2026-10-24", "2026-10-30"]) {
      expect(payPeriodAtIndex(payPeriodIndexForDate(localDate(day)))).toEqual({ from: "2026-10-10", to: "2026-10-23", payrollDate: "2026-10-30" });
    }
    for (const day of ["2026-10-31", "2026-11-13"]) expect(payPeriodIndexForDate(localDate(day))).toBe(2);
    expect(payPeriodIndexForDate(localDate("2026-11-14"))).toBe(3);
  });

  it("handles dates before the anchor instead of clamping them to the demo period", () => {
    expect(payPeriodAtIndex(-1)).toEqual({ from: "2026-09-12", to: "2026-09-25", payrollDate: "2026-10-02" });
    expect(payPeriodIndexForDate(localDate("2026-09-25"))).toBe(-1);
    expect(payPeriodIndexForDate(localDate("2026-09-26"))).toBe(-1);
    expect(payPeriodIndexForDate(localDate("2026-10-02"))).toBe(-1);
    expect(payPeriodIndexForDate(localDate("2026-09-18"))).toBe(-2);
    expect(payPeriodIndexForDate(localDate("2026-09-19"))).toBe(-1);
  });

  it("has exactly 14 inclusive dates per period and no overlap or gaps", () => {
    for (let index = -30; index <= 30; index += 1) {
      const period = payPeriodAtIndex(index);
      const next = payPeriodAtIndex(index + 1);
      expect(addCalendarDays(period.from, 13)).toBe(period.to);
      expect(addCalendarDays(period.to, 1)).toBe(next.from);
      expect(addCalendarDays(period.to, 7)).toBe(period.payrollDate);
      expect(addCalendarDays(period.payrollDate, 14)).toBe(next.payrollDate);
      expect(nextPayPeriod(period)).toEqual(next);
      expect(new Date(period.payrollDate + "T12:00:00Z").getUTCDay()).toBe(5);
    }
  });

  it("crosses month, year, leap-day and DST dates using calendar-day math", () => {
    expect(payPeriodAtIndex(6)).toEqual({ from: "2026-12-19", to: "2027-01-01", payrollDate: "2027-01-08" });
    expect(payPeriodIndexForDate(localDate("2027-01-08"))).toBe(6);
    expect(payPeriodIndexForDate(localDate("2027-01-09"))).toBe(7);
    expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addCalendarDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addCalendarDays("2026-10-31", 2)).toBe("2026-11-02");
    expect(addCalendarDays("2026-03-07", 2)).toBe("2026-03-09");
  });

  it("uses the browser's local calendar date across timezones and DST transitions", () => {
    const moduleUrl = pathToFileURL(resolve("src/lib/pay-period.ts")).href;
    const samples = ["2026-10-17T06:59:59Z", "2026-10-17T07:00:00Z", "2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z", "2026-03-08T09:30:00Z", "2026-03-08T10:30:00Z"];
    const code = "import { payPeriodIndexForDate, addCalendarDays } from " + JSON.stringify(moduleUrl) + "; console.log(JSON.stringify({indexes:" + JSON.stringify(samples) + ".map(s => payPeriodIndexForDate(new Date(s))),spring:addCalendarDays('2026-03-07',2),fall:addCalendarDays('2026-10-31',2)}));";
    const run = (timezone: string) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, TZ: timezone }, encoding: "utf8" }));
    expect(run("America/Los_Angeles")).toEqual({ indexes: [0, 1, 2, 2, -15, -15], spring: "2026-03-09", fall: "2026-11-02" });
    expect(run("UTC").indexes.slice(0, 2)).toEqual([1, 1]);
    expect(run("Asia/Tokyo").indexes.slice(0, 2)).toEqual([1, 1]);
  });

  it("shares current/previous ranges and only shows paydays for complete aligned periods", () => {
    expect(payPeriodDatePresets(localDate("2026-10-19"))).toEqual([
      { id: "current-pay-period", label: "Current pay period", from: "2026-10-10", to: "2026-10-23", payrollDate: "2026-10-30" },
      { id: "previous-pay-period", label: "Previous pay period", from: "2026-09-26", to: "2026-10-09", payrollDate: "2026-10-16" },
    ]);
    expect(paydayForRange("2026-10-10", "2026-10-23")).toBe("2026-10-30");
    expect(paydayForRange("2026-09-12", "2026-09-25")).toBe("2026-10-02");
    expect(paydayForRange("2026-10-01", "2026-10-31")).toBeNull();
    expect(paydayForRange("2026-10-10", "2026-10-24")).toBeNull();
    expect(paydayForRange("", "invalid")).toBeNull();
  });
});
