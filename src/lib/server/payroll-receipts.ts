import sharp from "sharp";
import { database, type AppUser } from "./db";
import { authorizedEmployeeTarget } from "./records";
import {
  inlineReceipt,
  RECEIPT_EXPORT_LIMITS,
  type PayrollReceipt,
} from "../receipt-pdf";
import type { Expense } from "../expense";

/** Load only selected user/date expense IDs. No receipt HTTP requests or remote URLs. */
export async function loadPayrollReceiptAttachments(
  user: AppUser,
  targetId: string,
  expenses: Expense[],
) {
  authorizedEmployeeTarget(user, targetId);
  const result: Record<string, PayrollReceipt> = {};
  let inputBytes = 0,
    outputBytes = 0;
  const maxEncoded =
    Math.ceil(RECEIPT_EXPORT_LIMITS.attachmentBytes / 3) * 4 + 256;
  const statement = database()
    .prepare(`SELECT receipt_file_name AS fileName, receipt_mime_type AS mimeType,
    CASE WHEN length(receipt_data_url) <= ? THEN receipt_data_url ELSE NULL END AS content,
    length(receipt_data_url) AS encodedLength FROM expenses WHERE id=? AND user_id=? AND date=?`);
  for (const expense of expenses) {
    const row = statement.get(
      maxEncoded,
      expense.id,
      targetId,
      expense.date,
    ) as
      | {
          fileName: string | null;
          mimeType: string | null;
          content: string | null;
          encodedLength: number | null;
        }
      | undefined;
    if (!row) {
      result[expense.id] = {
        error:
          "Receipt record is missing or no longer belongs to this exported employee/date.",
      };
      continue;
    }
    if (!row.fileName && !row.mimeType && !row.encodedLength) continue;
    const attachment = inlineReceipt(
      row.content ?? undefined,
      row.mimeType ?? undefined,
    );
    attachment.fileName = row.fileName ?? expense.receiptFileName;
    result[expense.id] = attachment;
    if ((row.encodedLength ?? 0) > maxEncoded) {
      attachment.error =
        "Receipt exceeds the 20 MB export limit. Download the original separately.";
      continue;
    }
    if (!attachment.bytes) continue;
    inputBytes += attachment.bytes.length;
    if (inputBytes > RECEIPT_EXPORT_LIMITS.totalBytes) {
      result[expense.id] = {
        fileName: attachment.fileName,
        error:
          "The export's 50 MB receipt input limit was reached. Download this receipt separately.",
      };
      continue;
    }
    try {
      if (attachment.mimeType !== "application/pdf") {
        // Deny executable/vector formats even if old storage contains misleading MIME labels.
        const allowed = [
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
          "image/avif",
          "image/tiff",
          "image/heic",
          "image/heif",
          "image/bmp",
        ];
        if (!allowed.includes(attachment.mimeType ?? ""))
          throw new Error("Unsupported image");
        const image = sharp(attachment.bytes, {
          limitInputPixels: RECEIPT_EXPORT_LIMITS.imagePixels,
          failOn: "warning",
          pages: 1,
        });
        const metadata = await image.metadata();
        if (
          ![
            "jpeg",
            "png",
            "webp",
            "gif",
            "avif",
            "heif",
            "tiff",
            "bmp",
          ].includes(metadata.format ?? "")
        )
          throw new Error("Unsupported decoder format");
        const bytes = await image.autoOrient().png().toBuffer();
        if (bytes.length > RECEIPT_EXPORT_LIMITS.attachmentBytes)
          throw new Error("Normalized image too large");
        attachment.bytes = bytes;
        attachment.mimeType = "image/png";
        if ((metadata.pages ?? 1) > 1)
          attachment.note = `Image has ${metadata.pages} frames/pages; first frame shown. Review the original for remaining frames.`;
      }
      outputBytes += attachment.bytes.length;
      if (outputBytes > RECEIPT_EXPORT_LIMITS.totalBytes)
        result[expense.id] = {
          fileName: attachment.fileName,
          error:
            "The export's 50 MB normalized receipt limit was reached. Download this receipt separately.",
        };
    } catch {
      result[expense.id] = {
        fileName: attachment.fileName,
        error:
          "Receipt image is unreadable, unsupported by the installed decoder, or exceeds the 25 megapixel / 20 MB export limits. Download the original separately.",
      };
    }
  }
  return result;
}
