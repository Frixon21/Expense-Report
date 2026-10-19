import { describe, expect, it } from "vitest";
import {
  annualMileageComplete,
  annualMileageInputSchema,
  dateRangePresets,
  emptyState,
  isFullTaxYearRange,
  lastTripEndTenths,
  mileageStateSchema,
  profileSchema,
  safeFilenamePart,
  tenthsToOdometerInput,
  tripInputSchema,
  type Trip,
} from "./model";

describe("local mileage data", () => {
  it("creates filesystem-safe driver names for report downloads", () => {
    expect(safeFilenamePart(" Alex Morgan ")).toBe("Alex-Morgan");
    expect(safeFilenamePart("José O'Neil / Sales")).toBe("Jose-O-Neil-Sales");
  });

  it("requires the identity and vehicle fields used on reports", () => {
    expect(
      profileSchema.parse({
        driverName: " Alex Morgan ",
        businessName: " Biztech ",
        vehicleDescription: " 2024 Toyota RAV4 ",
        businessUseStartDate: "2026-01-01",
      }),
    ).toEqual({
      driverName: "Alex Morgan",
      businessName: "Biztech",
      vehicleDescription: "2024 Toyota RAV4",
      businessUseStartDate: "2026-01-01",
    });
    expect(profileSchema.safeParse({}).success).toBe(false);
  });

  it("requires IRS mileage-log details and converts money exactly", () => {
    expect(
      tripInputSchema.parse({
        date: "2026-09-30",
        destination: "Sacramento, CA",
        businessPurpose: "Customer installation",
        start: "100.1",
        end: "125.4",
        parking: "12.50",
        tolls: "3",
      }),
    ).toEqual({
      date: "2026-09-30",
      destination: "Sacramento, CA",
      businessPurpose: "Customer installation",
      start_tenths: 1001,
      end_tenths: 1254,
      parking_cents: 1250,
      tolls_cents: 300,
    });
  });

  it.each(["destination", "businessPurpose"])("requires %s", (field) => {
    const value = {
      date: "2026-09-30",
      destination: "Sacramento",
      businessPurpose: "Customer visit",
      start: "10",
      end: "20",
      parking: "",
      tolls: "",
      [field]: " ",
    };
    expect(tripInputSchema.safeParse(value).success).toBe(false);
  });

  it("rejects descending or over-precise readings", () => {
    const base = {
      date: "2026-09-30",
      destination: "Sacramento",
      businessPurpose: "Customer visit",
      parking: "",
      tolls: "",
    };
    expect(
      tripInputSchema.safeParse({ ...base, start: "20", end: "10" }).success,
    ).toBe(false);
    expect(
      tripInputSchema.safeParse({ ...base, start: "1.23", end: "2" }).success,
    ).toBe(false);
  });

  it("accepts incomplete current-year mileage but identifies a completed year", () => {
    expect(
      annualMileageInputSchema.parse({
        year: 2026,
        opening: "1000.0",
        closing: "",
      }),
    ).toEqual({ year: 2026, opening_tenths: 10000, closing_tenths: null });
    expect(
      annualMileageInputSchema.safeParse({
        year: 2026,
        opening: "2000",
        closing: "1000",
      }).success,
    ).toBe(false);
  });

  it("identifies tax-year ranges and the latest trip odometer", () => {
    expect(isFullTaxYearRange("2026-01-01", "2026-12-31")).toBe(true);
    expect(isFullTaxYearRange("2026-01-01", "2026-06-30")).toBe(false);
    const trips = [
      {
        id: "1",
        date: "2026-01-02",
        destination: "A",
        businessPurpose: "B",
        start_tenths: 100,
        end_tenths: 120,
        parking_cents: 0,
        tolls_cents: 0,
        createdAt: "2026-01-02T12:00:00.000Z",
      },
      {
        id: "2",
        date: "2026-01-05",
        destination: "C",
        businessPurpose: "D",
        start_tenths: 120,
        end_tenths: 145,
        parking_cents: 0,
        tolls_cents: 0,
        createdAt: "2026-01-05T12:00:00.000Z",
      },
    ] as Trip[];
    expect(lastTripEndTenths(trips)).toBe(145);
    expect(tenthsToOdometerInput(145)).toBe("14.5");
    expect(
      annualMileageComplete(
        {
          version: 1,
          profile: null,
          annualMileage: [
            { year: 2026, opening_tenths: 1000, closing_tenths: null },
          ],
          trips: [],
        },
        2026,
      ),
    ).toBe(false);
    expect(
      dateRangePresets(new Date("2026-09-15T12:00:00Z")).map((preset) => preset.id),
    ).toEqual(["today", "month", "ytd", "tax-year", "current-pay-period", "previous-pay-period"]);
  });

  it("rejects malformed imported application state", () => {
    expect(mileageStateSchema.parse(emptyState())).toEqual({
      version: 1,
      profile: null,
      annualMileage: [],
      trips: [],
    });
    expect(
      mileageStateSchema.safeParse({
        version: 1,
        trips: [{ note: "old format" }],
      }).success,
    ).toBe(false);
  });
});
