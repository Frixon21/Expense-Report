import {
  PDFDocument,
  rgb,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { formatExpenseAmount, type Expense } from "./expense";

export const RECEIPT_EXPORT_LIMITS = {
  attachmentBytes: 20 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  pdfPages: 50,
  contentPages: 150,
  imagePixels: 25_000_000,
};
export type PayrollReceipt = {
  bytes?: Uint8Array;
  mimeType?: string;
  fileName?: string;
  error?: string;
  note?: string;
};
export type ReceiptEntry = { expense: Expense; reference: string };
export function hasReceipt(expense: Expense) {
  return Boolean(
    expense.receiptFileName ||
    expense.receiptDataUrl ||
    expense.receiptMimeType,
  );
}

/** Strict inline data only. Never resolves attachment URLs, including the app's own receipt endpoint. */
export function inlineReceipt(
  value: string | undefined,
  declared?: string,
): PayrollReceipt {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]*)$/.exec(value ?? "");
  if (!match)
    return {
      error:
        "Receipt content is missing or is not a stored attachment. Download the original to investigate.",
    };
  const base64 = match[2].replace(/\s/g, "");
  if (base64.length > Math.ceil(RECEIPT_EXPORT_LIMITS.attachmentBytes / 3) * 4)
    return {
      error:
        "Receipt exceeds the 20 MB export limit. Download the original separately.",
    };
  if (!base64 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
    return { error: "Receipt has invalid base64 data." };
  const mimeType = match[1].toLowerCase();
  if (declared && declared.toLowerCase() !== mimeType)
    return { error: "Receipt content type does not match its saved metadata." };
  try {
    const decoded = atob(base64);
    if (btoa(decoded) !== base64) throw new Error("Invalid base64");
    return {
      bytes: Uint8Array.from(decoded, (c) => c.charCodeAt(0)),
      mimeType,
    };
  } catch {
    return { error: "Receipt has invalid base64 data." };
  }
}

type Context = {
  pdf: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  employeeName: string;
  from: string;
  to: string;
  entries: ReceiptEntry[];
  receipts?: Record<string, PayrollReceipt>;
  printable: (value: string, font: PDFFont) => string;
  wrap: (value: string, font: PDFFont, width: number, size: number) => string[];
};

/** A static printed representation: PDF actions/links/attachments are not copied into the export. */
export async function appendReceiptPages(context: Context) {
  const { pdf, font, bold, entries, receipts, printable, wrap } = context;
  const ink = rgb(0.09, 0.14, 0.24),
    muted = rgb(0.32, 0.38, 0.46);
  let contentPages = 0,
    totalBytes = 0;
  const warnings: { entry: ReceiptEntry; reason: string }[] = [];
  const text = (
    page: PDFPage,
    value: string,
    x: number,
    y: number,
    size = 9,
    strong = false,
  ) =>
    page.drawText(printable(value, strong ? bold : font), {
      x,
      y,
      size,
      font: strong ? bold : font,
      color: ink,
    });
  function heading(
    page: PDFPage,
    entry: ReceiptEntry,
    fileName: string,
    section: string,
    note?: string,
  ) {
    const width = page.getWidth() - 72;
    let y = page.getHeight() - 36;
    text(page, `Receipt appendix - ${entry.reference}`, 36, y, 14, true);
    y -= 19;
    for (const value of [
      context.employeeName + ` | ${context.from} through ${context.to}`,
      `${entry.expense.date} | ${formatExpenseAmount(entry.expense.amount)} | ${section}`,
      `Expense: ${entry.expense.merchant.slice(0, 200)}`,
      `File: ${fileName.slice(0, 200)}`,
      ...(note ? [note] : []),
    ]) {
      for (const line of wrap(value, font, width, 9)) {
        text(page, line, 36, y);
        y -= 12;
      }
    }
    y -= 8;
    page.drawLine({
      start: { x: 36, y },
      end: { x: page.getWidth() - 36, y },
      color: rgb(0.83, 0.87, 0.92),
      thickness: 0.6,
    });
    return { x: 36, y: 48, width, height: y - 60 };
  }
  for (const entry of entries) {
    const receipt =
      receipts?.[entry.expense.id] ??
      inlineReceipt(
        entry.expense.receiptDataUrl,
        entry.expense.receiptMimeType,
      );
    const fileName =
      receipt.fileName ?? entry.expense.receiptFileName ?? "unnamed receipt";
    if (receipt.error || !receipt.bytes?.length) {
      warnings.push({
        entry,
        reason: receipt.error ?? "Receipt content is missing.",
      });
      continue;
    }
    if (
      receipt.bytes.length > RECEIPT_EXPORT_LIMITS.attachmentBytes ||
      totalBytes + receipt.bytes.length > RECEIPT_EXPORT_LIMITS.totalBytes
    ) {
      warnings.push({
        entry,
        reason:
          "Receipt exceeds the 20 MB attachment or 50 MB export content limit. Download the original separately.",
      });
      continue;
    }
    totalBytes += receipt.bytes.length;
    const before = pdf.getPageCount();
    try {
      if (receipt.mimeType === "application/pdf") {
        const source = await PDFDocument.load(receipt.bytes, {
          updateMetadata: false,
        });
        const pages = source.getPages();
        if (!pages.length) throw new Error("Empty PDF");
        if (
          pages.length > RECEIPT_EXPORT_LIMITS.pdfPages ||
          contentPages + pages.length > RECEIPT_EXPORT_LIMITS.contentPages
        ) {
          warnings.push({
            entry,
            reason:
              "PDF exceeds the 50 pages per receipt or 150 receipt-content pages per export limit. No pages from this attachment were included; download the original separately.",
          });
          continue;
        }
        // Use existing widget appearances without changing original receipt bytes.
        source.getForm().flatten({ updateFieldAppearances: false });
        // Validate decoding/embedding in a disposable document first: failed lazy
        // embedded objects must never poison the report's later pdf.save().
        const probe = await PDFDocument.create();
        for (const original of pages) {
          if (!original.node.Contents())
            original.drawRectangle({ x: 0, y: 0, width: 0, height: 0 });
          const embedded = await probe.embedPage(original);
          await embedded.embed();
        }
        await probe.save();
        for (let index = 0; index < pages.length; index++) {
          const original = pages[index];
          const rotation = ((original.getRotation().angle % 360) + 360) % 360;
          const crop = original.getCropBox();
          if (
            ![0, 90, 180, 270].includes(rotation) ||
            !Number.isFinite(crop.width * crop.height) ||
            crop.width <= 0 ||
            crop.height <= 0
          )
            throw new Error("Invalid PDF dimensions");
          if (!original.node.Contents())
            original.drawRectangle({ x: 0, y: 0, width: 0, height: 0 });
          const embedded = await pdf.embedPage(original, {
            left: crop.x,
            bottom: crop.y,
            right: crop.x + crop.width,
            top: crop.y + crop.height,
          });
          await embedded.embed();
          const turn = rotation === 90 || rotation === 270;
          const width = turn ? embedded.height : embedded.width,
            height = turn ? embedded.width : embedded.height;
          const page = pdf.addPage(width > height ? [792, 612] : [612, 792]);
          const box = heading(
            page,
            entry,
            fileName,
            `PDF page ${index + 1} of ${pages.length}`,
          );
          const scale = Math.min(box.width / width, box.height / height);
          const left = box.x + (box.width - width * scale) / 2,
            bottom = box.y + (box.height - height * scale) / 2;
          const x =
            left +
            (rotation === 180
              ? embedded.width * scale
              : rotation === 270
                ? embedded.height * scale
                : 0);
          const y =
            bottom +
            (rotation === 90
              ? embedded.width * scale
              : rotation === 180
                ? embedded.height * scale
                : 0);
          page.drawPage(embedded, {
            x,
            y,
            xScale: scale,
            yScale: scale,
            rotate: degrees(-rotation),
          });
        }
      } else if (
        receipt.mimeType === "image/png" ||
        receipt.mimeType === "image/jpeg"
      ) {
        if (receipt.mimeType === "image/png" && receipt.bytes.length >= 24) {
          const view = new DataView(
            receipt.bytes.buffer,
            receipt.bytes.byteOffset,
            receipt.bytes.byteLength,
          );
          if (
            view.getUint32(16) * view.getUint32(20) >
            RECEIPT_EXPORT_LIMITS.imagePixels
          )
            throw new Error("Image pixels exceed limit");
        }
        const image =
          receipt.mimeType === "image/png"
            ? await pdf.embedPng(receipt.bytes)
            : await pdf.embedJpg(receipt.bytes);
        await image.embed();
        if (image.width * image.height > RECEIPT_EXPORT_LIMITS.imagePixels) {
          warnings.push({
            entry,
            reason:
              "Image exceeds the 25 megapixel export limit. Download the original separately.",
          });
          continue;
        }
        const wide = image.width > image.height,
          extreme =
            Math.max(image.width / image.height, image.height / image.width) >
            2.5;
        // Measure the repeated label before laying out content.
        const measure = pdf.addPage(wide ? [792, 612] : [612, 792]);
        const box = heading(
          measure,
          entry,
          fileName,
          "Image section 999 of 999",
          [
            receipt.note,
            "Continued image; adjacent sections overlap slightly. All sections are included.",
          ]
            .filter(Boolean)
            .join(" "),
        );
        pdf.removePage(pdf.getPageCount() - 1);
        const scale = extreme
          ? wide
            ? box.height / image.height
            : box.width / image.width
          : Math.min(box.width / image.width, box.height / image.height);
        const renderedWidth = image.width * scale,
          renderedHeight = image.height * scale,
          overlap = 12;
        const columns = Math.max(
            1,
            Math.ceil((renderedWidth - overlap) / (box.width - overlap)),
          ),
          rows = Math.max(
            1,
            Math.ceil((renderedHeight - overlap) / (box.height - overlap)),
          );
        const count = columns * rows;
        if (
          count > 50 ||
          contentPages + count > RECEIPT_EXPORT_LIMITS.contentPages
        ) {
          warnings.push({
            entry,
            reason:
              "Image requires more than 50 sections or would exceed 150 receipt-content pages. Download the original separately.",
          });
          continue;
        }
        for (let row = 0; row < rows; row++)
          for (let col = 0; col < columns; col++) {
            const page = pdf.addPage(wide ? [792, 612] : [612, 792]);
            const area = heading(
              page,
              entry,
              fileName,
              `Image section ${row * columns + col + 1} of ${count}`,
              [
                receipt.note,
                count > 1
                  ? "Continued image; adjacent sections overlap slightly. All sections are included."
                  : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined,
            );
            // Reserve the continuation line equally in measuring and actual pages.
            const height = Math.min(area.height, box.height);
            const x =
              area.x +
              (columns === 1
                ? (area.width - renderedWidth) / 2
                : -col * (box.width - overlap));
            const y =
              area.y + height - renderedHeight + row * (box.height - overlap);
            page.pushOperators(
              pushGraphicsState(),
              rectangle(area.x, area.y, area.width, height),
              clip(),
              endPath(),
            );
            page.drawImage(image, {
              x,
              y,
              width: renderedWidth,
              height: renderedHeight,
            });
            page.pushOperators(popGraphicsState());
          }
      } else {
        warnings.push({
          entry,
          reason: `Unsupported receipt type (${receipt.mimeType ?? "unknown"}). Download the original separately.`,
        });
        continue;
      }
      contentPages += pdf.getPageCount() - before;
    } catch {
      while (pdf.getPageCount() > before)
        pdf.removePage(pdf.getPageCount() - 1);
      warnings.push({
        entry,
        reason:
          "Receipt could not be rendered (corrupt, unsupported, empty or password-protected). Download the original separately.",
      });
    }
  }
  let page: PDFPage | undefined,
    y = 0;
  for (const { entry, reason } of warnings) {
    const value = `${entry.reference} | ${entry.expense.date} | ${entry.expense.merchant.slice(0, 200)} | ${formatExpenseAmount(entry.expense.amount)} | File: ${(receipts?.[entry.expense.id]?.fileName ?? entry.expense.receiptFileName ?? "unnamed receipt").slice(0, 200)}. WARNING: ${reason}`;
    const lines = wrap(value, font, 540, 9);
    if (!page || y - lines.length * 13 < 55) {
      page = pdf.addPage([612, 792]);
      y = 756;
      text(page, "Receipt appendix - attachment warnings", 36, y, 14, true);
      y -= 22;
      for (const line of wrap(
        context.employeeName + ` | ${context.from} through ${context.to}`,
        font,
        540,
        9,
      )) {
        text(page, line, 36, y);
        y -= 13;
      }
      y -= 14;
    }
    for (const line of lines) {
      page.drawText(printable(line, font), {
        x: 36,
        y,
        size: 9,
        font,
        color: muted,
      });
      y -= 13;
    }
    y -= 15;
  }
}
