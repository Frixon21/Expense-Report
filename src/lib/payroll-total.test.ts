import { it, expect, vi, afterEach } from "vitest";
import { PDFDocument, PDFPage } from "pdf-lib";
import { createDemoOrg } from "./demo-seed";
import { createPayrollEmployeeReport } from "./payroll-pdf";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
afterEach(() => vi.restoreAllMocks());
it("totals filtered reimbursable rows in cents and places Total beneath the breakdown before receipts", async () => {
  const employee = createDemoOrg().employees[0],
    base = employee.state.trips[0];
  employee.state.trips = [
    {
      ...base,
      id: "fraction-one",
      date: "2026-10-10",
      start_tenths: 1000,
      end_tenths: 1001,
      parking_cents: 125,
      tolls_cents: 75,
      vehicleName: "Synthetic first car",
    },
    {
      ...base,
      id: "fraction-two",
      date: "2026-10-11",
      start_tenths: 9000,
      end_tenths: 9001,
      parking_cents: 0,
      tolls_cents: 0,
      vehicleName: "Synthetic second car",
    },
    {
      ...base,
      id: "excluded-trip",
      date: "2026-11-01",
      start_tenths: 0,
      end_tenths: 100000,
      parking_cents: 99999,
      tolls_cents: 99999,
    },
  ];
  const receipt = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="white"/><text x="40" y="70" font-size="30">SYNTHETIC RECEIPT</text><text x="40" y="120" font-size="24">Supplies $12.34</text></svg>',
    ),
  )
    .png()
    .toBuffer();
  const item = {
    id: "synthetic-personal",
    date: "2026-10-12",
    createdAt: "2026-10-12T12:00:00Z",
    category: "supplies" as const,
    amount: 1234,
    paymentMethod: "personal_card" as const,
    merchant: "Synthetic Shop",
    businessPurpose: "Synthetic total check",
    receiptFileName: "synthetic-total.png",
    receiptMimeType: "image/png",
    receiptDataUrl: "data:image/png;base64," + receipt.toString("base64"),
  };
  employee.expenses = [
    item,
    {
      ...item,
      id: "cash",
      amount: 200,
      paymentMethod: "cash",
      receiptFileName: undefined,
      receiptMimeType: undefined,
      receiptDataUrl: undefined,
    },
    {
      ...item,
      id: "company",
      amount: 9999,
      paymentMethod: "company_card",
      receiptFileName: undefined,
      receiptMimeType: undefined,
      receiptDataUrl: undefined,
    },
    {
      ...item,
      id: "outside",
      date: "2026-11-01",
      amount: 100000,
      receiptFileName: undefined,
      receiptMimeType: undefined,
      receiptDataUrl: undefined,
    },
  ];
  const draw = vi.spyOn(PDFPage.prototype, "drawText");
  const bytes = await createPayrollEmployeeReport({
    employee,
    from: "2026-10-01",
    to: "2026-10-31",
    dollarsPerMile: 0.7,
    tripRatesCentsPerMile: { "fraction-one": 65, "fraction-two": 75 },
  });
  const texts = draw.mock.calls.map((c) => c[0]);
  expect(texts).toContain("Business miles: 0.2   Est. mileage pay: $0.15");
  expect(texts).toContain("Parking/tolls: $2.00   Expense reimburse: $14.34");
  expect(texts.filter((t) => t.startsWith("Total:"))).toEqual([
    "Total: $16.49",
  ]);
  const total = draw.mock.calls.find((c) => c[0] === "Total: $16.49")!,
    breakdown = draw.mock.calls.find((c) => c[0].startsWith("Parking/tolls:"))!,
    table = draw.mock.calls.find((c) => c[0] === "Date")!;
  expect(total[1]!.y).toBeLessThan(breakdown[1]!.y!);
  expect(total[1]!.y).toBeGreaterThan(table[1]!.y!);
  expect(total[1]!.size).toBe(10);
  expect(texts).toContain("Receipt appendix - R1");
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
  if (process.env.PAYROLL_TOTAL_PREVIEW_DIR) {
    mkdirSync(process.env.PAYROLL_TOTAL_PREVIEW_DIR, { recursive: true });
    writeFileSync(
      join(process.env.PAYROLL_TOTAL_PREVIEW_DIR, "payroll-total-preview.pdf"),
      bytes,
    );
  }
});
it("formats an empty report total as zero without changing pagination headers", async () => {
  const employee = createDemoOrg().employees[0];
  employee.state.trips = [];
  employee.expenses = [];
  const draw = vi.spyOn(PDFPage.prototype, "drawText");
  const bytes = await createPayrollEmployeeReport({
    employee,
    from: "2026-10-01",
    to: "2026-10-31",
    dollarsPerMile: 0.7,
  });
  expect(draw.mock.calls.map((c) => c[0])).toContain("Total: $0.00");
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
});
