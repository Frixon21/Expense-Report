import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PDFDocument, PDFPage, StandardFonts, degrees, PDFName } from "pdf-lib";
import sharp from "sharp";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTestDatabase, setTestDatabase, getUser } from "./db";
import { createAppSession } from "./auth";
import { POST } from "@/app/api/reports/payroll/route";
import { loadPayrollReceiptAttachments } from "./payroll-receipts";
import { createPayrollEmployeeReport } from "../payroll-pdf";
import { RECEIPT_EXPORT_LIMITS, inlineReceipt } from "../receipt-pdf";
import { loadEmployeeSnapshot } from "./records";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
const now = "2026-10-29T12:00:00.000Z",
  from = "2026-10-01",
  to = "2026-10-31";
beforeEach(() => {
  db = createTestDatabase();
  setTestDatabase(db);
  for (const id of ["payroll", "alice", "bob"]) {
    db.prepare(
      "INSERT INTO users VALUES (?, 'synthetic', ?, ?, NULL, 'active',?,?)",
    ).run(id, id, `Synthetic ${id}`, now, now);
    db.prepare(
      "INSERT INTO roles(user_id,role,granted_at) VALUES (?,'employee',?)",
    ).run(id, now);
    db.prepare("INSERT INTO profiles VALUES (?,?,?)").run(
      id,
      JSON.stringify({
        driverName: `Synthetic ${id}`,
        businessName: "Synthetic Company",
        vehicleDescription: "Test car",
        businessUseStartDate: "2026-01-01",
      }),
      now,
    );
  }
  db.prepare(
    "INSERT INTO roles(user_id,role,granted_at) VALUES ('payroll','payroll',?)",
  ).run(now);
  vi.stubEnv("RESEND_DELIVERY_ENABLED", "false");
  vi.stubEnv("RESEND_API_KEY", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setTestDatabase(null);
  db.close();
});
function expense(
  id: string,
  bytes?: Uint8Array,
  mime = "image/png",
  owner = "alice",
  date = "2026-10-15",
  fileName = id + ".png",
) {
  db.prepare(
    "INSERT INTO expenses(id,user_id,date,category,amount,payment_method,merchant,business_purpose,receipt_file_name,receipt_mime_type,receipt_data_url,created_at,updated_at) VALUES (?,?,?,'supplies',12345,'cash',?,'Synthetic export test',?,?,?,?,?)",
  ).run(
    id,
    owner,
    date,
    `Vendor ${id}`,
    fileName,
    mime,
    bytes
      ? `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
      : null,
    now,
    now,
  );
}
async function image(width = 800, height = 1000, label = "SYNTHETIC RECEIPT") {
  const rows = Array.from(
    { length: Math.floor((height - 100) / 55) },
    (_, i) =>
      `<text x="30" y="${100 + i * 55}" font-size="22">${i + 1}. Synthetic item - $12.34</text>`,
  ).join("");
  return sharp(
    Buffer.from(
      `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><rect x="3" y="3" width="${width - 6}" height="${height - 6}" fill="none" stroke="black" stroke-width="4"/><text x="30" y="50" font-size="26">${label} TOP LEFT</text>${rows}<text x="30" y="${height - 24}" font-size="22">BOTTOM END OF RECEIPT</text></svg>`,
    ),
  )
    .png()
    .toBuffer();
}
async function pdfReceipt(pages = 3) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage(i === 1 ? [792, 612] : [612, 792]);
    if (i === 2) {
      page.setRotation(degrees(90));
      page.setCropBox(20, 30, 570, 720);
      page.drawText(`PDF RECEIPT PAGE ${i + 1} - ROTATED UPRIGHT`, {
        x: 80,
        y: 80,
        size: 18,
        font,
        rotate: degrees(90),
      });
    } else {
      page.drawText(`PDF RECEIPT PAGE ${i + 1}`, {
        x: 40,
        y: page.getHeight() - 60,
        size: 20,
        font,
      });
      page.drawText("BOTTOM OF ORIGINAL PDF PAGE", {
        x: 40,
        y: 40,
        size: 16,
        font,
      });
    }
  }
  // This must not become an active action in the exported PDF.
  pdf.catalog.set(
    PDFName.of("OpenAction"),
    pdf.context.obj({ S: "JavaScript", JS: "app.alert('synthetic')" }),
  );
  return pdf.save();
}
async function report(name?: string) {
  const snapshot = loadEmployeeSnapshot(db, "alice");
  const included = snapshot.expenses.filter(
    (e) => e.date >= from && e.date <= to,
  );
  const receipts = await loadPayrollReceiptAttachments(
    getUser(db, "payroll")!,
    "alice",
    included,
  );
  const draw = vi.spyOn(PDFPage.prototype, "drawText");
  const bytes = await createPayrollEmployeeReport({
    employee: {
      id: "alice",
      state: snapshot.state,
      expenses: snapshot.expenses,
      tripMeta: {},
      expenseMeta: {},
    },
    from,
    to,
    dollarsPerMile: 0.7,
    receipts,
  });
  const texts = draw.mock.calls.map(([text]) => text);
  draw.mockRestore();
  if (name && process.env.RECEIPT_PDF_FIXTURE_DIR) {
    mkdirSync(process.env.RECEIPT_PDF_FIXTURE_DIR, { recursive: true });
    writeFileSync(
      join(process.env.RECEIPT_PDF_FIXTURE_DIR, name + ".pdf"),
      bytes,
    );
  }
  return { bytes, pdf: await PDFDocument.load(bytes), texts, receipts };
}
it("retains the table-only report when there are no receipt attachments", async () => {
  expense("no-receipt");
  db.prepare(
    "UPDATE expenses SET receipt_file_name=NULL,receipt_mime_type=NULL",
  ).run();
  const result = await report("no-receipts");
  expect(result.pdf.getPageCount()).toBe(1);
  expect(result.texts.join(" ")).not.toContain("Receipt appendix");
});
it("adds a reference and labeled normal image after the table", async () => {
  expense("normal", await image());
  const result = await report("one-image");
  expect(result.pdf.getPageCount()).toBe(2);
  expect(result.texts.join(" ")).toContain("[Receipt R1]");
  for (const value of [
    "Receipt appendix - R1",
    "Vendor normal",
    "normal.png",
    "$123.45",
    "Synthetic alice",
  ])
    expect(result.texts.join(" ")).toContain(value);
});
it("splits tall/wide images into full overlapping sections and honors EXIF rotation", async () => {
  expense("tall", await image(600, 3000, "TALL"));
  expense("wide", await image(2400, 400, "WIDE"));
  const rotated = await sharp(await image(600, 800, "EXIF UPRIGHT"))
    .rotate(90)
    .withMetadata({ orientation: 8 })
    .jpeg()
    .toBuffer();
  expense("rotated", rotated, "image/jpeg");
  const result = await report("image-shapes");
  const meta = await sharp(result.receipts.rotated.bytes).metadata();
  expect(meta.width).toBe(600);
  expect(meta.height).toBe(800);
  expect(result.pdf.getPageCount()).toBeGreaterThan(5);
  expect(result.texts.join(" ")).toContain("Continued image");
});
it.each(["webp", "gif", "avif", "tiff"] as const)(
  "normalizes supported %s receipts locally",
  async (format) => {
    const bytes = await sharp(await image())
      .toFormat(format)
      .toBuffer();
    expense(format, bytes, `image/${format}`);
    const result = await report();
    expect(result.receipts[format].mimeType).toBe("image/png");
    expect(result.pdf.getPageCount()).toBe(2);
  },
);
it("includes all pages of a multipage PDF with page rotation and crop box, without document actions", async () => {
  expense(
    "pdf",
    await pdfReceipt(),
    "application/pdf",
    "alice",
    "2026-10-15",
    "three-page.pdf",
  );
  const result = await report("multipage-pdf");
  expect(result.pdf.getPageCount()).toBe(4);
  for (let i = 1; i <= 3; i++)
    expect(result.texts.join(" ")).toContain(`PDF page ${i} of 3`);
  expect(result.pdf.catalog.has(PDFName.of("OpenAction"))).toBe(false);
});
it("keeps mixed attachments labeled and prints explicit missing/corrupt/unsupported warnings without fetching URLs", async () => {
  expense("good", await image());
  expense("badpng", Buffer.from("not a PNG"));
  expense("badpdf", Buffer.from("not a PDF"), "application/pdf");
  expense("missing");
  expense("unsupported", Buffer.from("<svg/>"), "image/svg+xml");
  expense("external");
  db.prepare(
    "UPDATE expenses SET receipt_data_url='https://untrusted.invalid/receipt' WHERE id='external'",
  ).run();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No fetch allowed"));
  const result = await report("mixed-warnings");
  expect(fetch).not.toHaveBeenCalled();
  expect(result.texts.join(" ")).toContain("WARNING:");
  for (const id of ["badpng", "badpdf", "missing", "unsupported", "external"])
    expect(result.texts.join(" ")).toContain(id);
  expect(result.pdf.getPageCount()).toBeGreaterThanOrEqual(3);
});
it("reports page/byte/pixel limits instead of partially or silently omitting attachments", async () => {
  expense(
    "too-many-pages",
    await pdfReceipt(RECEIPT_EXPORT_LIMITS.pdfPages + 1),
    "application/pdf",
  );
  expense(
    "large-header",
    Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 127, 255,
      255, 255, 127, 255, 255, 255,
    ]),
  );
  const result = await report("limits");
  expect(result.texts.join(" ")).toContain("50 pages per receipt");
  expect(result.texts.join(" ")).toContain("25 megapixel");
  expect(result.pdf.getPageCount()).toBe(2);
  expect(inlineReceipt("https://untrusted.invalid/file").error).toBeTruthy();
  expect(
    inlineReceipt("data:image/png;base64,AAAA", "image/jpeg").error,
  ).toContain("does not match");
  const saved = RECEIPT_EXPORT_LIMITS.attachmentBytes;
  try {
    RECEIPT_EXPORT_LIMITS.attachmentBytes = 2;
    expect(
      inlineReceipt(
        "data:image/png;base64," +
          Buffer.from("synthetic bytes").toString("base64"),
      ).error,
    ).toContain("20 MB");
  } finally {
    RECEIPT_EXPORT_LIMITS.attachmentBytes = saved;
  }
});
it("applies target employee and inclusive dates to the actual authorized export, with no cross-user receipts", async () => {
  expense("alice-in", await image());
  expense("alice-before", await image(), "image/png", "alice", "2026-09-30");
  expense("alice-after", await image(), "image/png", "alice", "2026-11-01");
  expense("bob-in", await image(), "image/png", "bob");
  const session = await createAppSession("payroll");
  const draw = vi.spyOn(PDFPage.prototype, "drawText");
  const request = (cookie: string) =>
    new Request("http://localhost/api/reports/payroll", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ employeeId: "alice", from, to }),
    });
  const response = await POST(
    request("expense_report_session=" + encodeURIComponent(session.token)),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const text = draw.mock.calls.map(([s]) => s).join(" ");
  expect(text).toContain("alice-in");
  for (const excluded of ["bob-in", "alice-before", "alice-after"])
    expect(text).not.toContain(excluded);
  expect(
    (await PDFDocument.load(await response.arrayBuffer())).getPageCount(),
  ).toBe(2);
  expect((await POST(request(""))).status).toBe(401);
  const employee = await createAppSession("bob");
  expect(
    (
      await POST(
        request("expense_report_session=" + encodeURIComponent(employee.token)),
      )
    ).status,
  ).toBe(403);
  const wrong = await loadPayrollReceiptAttachments(
    getUser(db, "payroll")!,
    "alice",
    loadEmployeeSnapshot(db, "bob").expenses,
  );
  expect(wrong["bob-in"].bytes).toBeUndefined();
});
it("includes stored attachment bytes even if legacy filename/MIME metadata is missing", async () => {
  expense("legacy", await image());
  db.prepare(
    "UPDATE expenses SET receipt_file_name=NULL,receipt_mime_type=NULL WHERE id='legacy'",
  ).run();
  const result = await report();
  expect(result.pdf.getPageCount()).toBe(2);
  expect(result.texts.join(" ")).toContain("Receipt R1");
});
it("creates a combined synthetic visual preview with image/PDF receipts and explicit warnings", async () => {
  expense("01-normal", await image());
  expense("02-tall", await image(600, 2400, "TALL"));
  expense("03-wide", await image(2000, 400, "WIDE"));
  expense(
    "04-rotated",
    await sharp(await image(600, 800, "EXIF UPRIGHT"))
      .rotate(90)
      .withMetadata({ orientation: 8 })
      .jpeg()
      .toBuffer(),
    "image/jpeg",
  );
  expense(
    "05-pdf",
    await pdfReceipt(),
    "application/pdf",
    "alice",
    "2026-10-15",
    "three-pages.pdf",
  );
  expense("06-missing");
  expense("07-broken", Buffer.from("broken"), "application/pdf");
  const result = await report("receipt-appendix-preview");
  expect(result.pdf.getPageCount()).toBeGreaterThan(10);
});
it("isolates a PDF whose content stream fails during lazy embedding", async () => {
  const { PDFRawStream } = await import("pdf-lib");
  const source = await PDFDocument.create();
  const page = source.addPage();
  page.node.set(
    PDFName.of("Contents"),
    source.context.register(
      PDFRawStream.of(
        source.context.obj({ Filter: "FlateDecode" }),
        new Uint8Array([1, 2, 3, 4]),
      ),
    ),
  );
  expense("bad-stream", await source.save(), "application/pdf");
  expense("still-good", await image());
  const result = await report("bad-stream");
  expect(result.pdf.getPageCount()).toBeGreaterThanOrEqual(3);
  expect(result.texts.join(" ")).toContain("could not be rendered");
});
