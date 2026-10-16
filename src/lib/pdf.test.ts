import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createReport } from "./pdf";
import type { MileageState, Trip } from "./model";

const trip = (index: number): Trip => ({
  id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
  date: "2026-09-30",
  destination: `Sacramento client ${index}`,
  businessPurpose: "Install and test customer network equipment ".repeat(4),
  start_tenths: 10000 + index * 100,
  end_tenths: 10050 + index * 100,
  parking_cents: 1250,
  tolls_cents: 300,
  createdAt: "2026-09-30T12:00:00.000Z",
});

const state = (count: number): MileageState => ({
  version: 1,
  profile: {
    driverName: "Alex Morgan",
    businessName: "Biztech",
    vehicleDescription: "2024 Toyota RAV4",
    businessUseStartDate: "2026-01-01",
  },
  annualMileage: [{ year: 2026, opening_tenths: 10000, closing_tenths: 25000 }],
  trips: Array.from({ length: count }, (_, index) => trip(index)),
});

describe("mileage PDF", () => {
  it.each([0, 1, 60])(
    "creates a readable report for %s trips",
    async (count) => {
      const bytes = await createReport({
        state: state(count),
        from: "2026-09-01",
        to: "2026-09-30",
      });
      const document = await PDFDocument.load(bytes);
      expect(document.getPageCount()).toBeGreaterThanOrEqual(
        count === 60 ? 3 : 1,
      );
      expect(bytes.length).toBeGreaterThan(500);
    },
  );

  it("requires saved driver and vehicle information", async () => {
    await expect(
      createReport({
        state: { ...state(0), profile: null },
        from: "2026-01-01",
        to: "2026-12-31",
      }),
    ).rejects.toThrow(/profile/i);
  });

  it("requires total annual mileage only for a final full-year report", async () => {
    const incomplete = { ...state(1), annualMileage: [] };
    await expect(
      createReport({ state: incomplete, from: "2026-01-01", to: "2026-12-31" }),
    ).rejects.toThrow(/opening and closing/i);
    await expect(
      createReport({ state: incomplete, from: "2026-09-01", to: "2026-09-30" }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});
