import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFPage, StandardFonts } from "pdf-lib";
import { createDemoOrg } from "./demo-seed";
import { createPayrollEmployeeReport } from "./payroll-pdf";

describe("createPayrollEmployeeReport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits fractional odometers and miles only for mileage, preserving totals", async () => {
    const employee = createDemoOrg().employees[0];
    employee.state.trips = [
      {
        ...employee.state.trips[0],
        start_tenths: 123456,
        end_tenths: 123579,
        parking_cents: 125,
        tolls_cents: 75,
      },
    ];
    employee.expenses = [
      {
        id: "synthetic-expense",
        date: "2026-09-29",
        createdAt: "2026-09-29T12:00:00Z",
        category: "supplies",
        amount: 1234,
        paymentMethod: "cash",
        merchant: "Synthetic shop",
        businessPurpose: "Test supplies",
      },
    ];
    employee.tripMeta[employee.state.trips[0].id] = {
      processed: true,
      paid: true,
    };
    const draw = vi.spyOn(PDFPage.prototype, "drawText");
    const bytes = await createPayrollEmployeeReport({
      employee,
      from: "2026-09-01",
      to: "2026-10-31",
      dollarsPerMile: 0.7,
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    const texts = draw.mock.calls.map(([text]) => text);
    for (const value of [
      "Odo start",
      "Odo end",
      "Trip miles",
      "12345.6",
      "12357.9",
      "12.3",
      "$8.61",
      "$2.00",
      "$12.34",
      "Cash (reimburse)",
      "Processed / Paid",
      "Business miles: 12.3   Est. mileage pay: $8.61",
      "Parking/tolls: $2.00   Expense reimburse: $12.34",
    ]) {
      expect(texts).toContain(value);
    }
    for (const value of ["12345.6", "12357.9", "12.3"]) {
      expect(texts.filter((text) => text === value)).toHaveLength(1);
    }
    const mileageColumns = draw.mock.calls
      .filter(([text]) => ["12345.6", "12357.9", "12.3"].includes(text))
      .map(([, options]) => options!.x);
    const expenseY = draw.mock.calls.find(([text]) => text === "Expense")![1]!
      .y;
    expect(
      draw.mock.calls
        .filter(
          ([, options]) =>
            options?.y === expenseY && mileageColumns.includes(options?.x),
        )
        .map(([text]) => text),
    ).toEqual(["—", "—", "—"]);
  });

  it("paginates long synthetic rows with repeated headings and bounded text", async () => {
    const employee = createDemoOrg().employees[0];
    employee.expenses = [];
    employee.state.trips = Array.from({ length: 45 }, (_, index) => ({
      ...employee.state.trips[0],
      id: `synthetic-${index}`,
      destination: `Synthetic destination ${index}`,
      businessPurpose:
        "Long description ".repeat(index === 0 ? 240 : 18) + "X".repeat(100),
    }));
    const draw = vi.spyOn(PDFPage.prototype, "drawText");
    const bytes = await createPayrollEmployeeReport({
      employee,
      from: "2026-09-01",
      to: "2026-10-31",
      dollarsPerMile: 0.7,
    });
    const pdf = await PDFDocument.load(bytes);
    if (process.env.PAYROLL_PDF_FIXTURE_PATH) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(process.env.PAYROLL_PDF_FIXTURE_PATH, bytes);
    }
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect(
      draw.mock.calls.filter(([text]) => text === "Odo start"),
    ).toHaveLength(pdf.getPageCount());
    expect(draw.mock.calls.filter(([text]) => text === "Mileage")).toHaveLength(
      45,
    );
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const [text, options] of draw.mock.calls) {
      expect(
        options!.x! + font.widthOfTextAtSize(text, options!.size!),
      ).toBeLessThanOrEqual(762);
      expect(options!.y).toBeGreaterThanOrEqual(23);
    }
  });
  it("leaves mileage fields empty on expense-only company-card reports", async () => {
    const employee = createDemoOrg().employees[0];
    employee.state.trips = [];
    employee.expenses = [
      {
        id: "company",
        date: "2026-09-29",
        createdAt: "2026-09-29T12:00:00Z",
        category: "supplies",
        amount: 1234,
        paymentMethod: "company_card",
        merchant: "Synthetic shop",
        businessPurpose: "Supplies",
      },
    ];
    const draw = vi.spyOn(PDFPage.prototype, "drawText");
    await createPayrollEmployeeReport({
      employee,
      from: "2026-09-01",
      to: "2026-10-31",
      dollarsPerMile: 0.7,
    });
    const texts = draw.mock.calls.map(([text]) => text);
    expect(texts).toContain("Business miles: 0.0   Est. mileage pay: $0.00");
    expect(texts).toContain("Parking/tolls: $0.00   Expense reimburse: $0.00");
    expect(texts).toContain("Company card");
    expect(texts).toContain("$12.34");
    expect(texts.filter((text) => text === "—")).toHaveLength(3);
  });
  it("builds a pdf for an employee and date range", async () => {
    const org = createDemoOrg();
    const employee = org.employees[0];
    const bytes = await createPayrollEmployeeReport({
      employee,
      from: "2026-09-01",
      to: "2026-10-31",
      dollarsPerMile: org.dollarsPerMile,
    });
    expect(bytes.byteLength).toBeGreaterThan(500);
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe(
      "%PDF",
    );
  });
});
