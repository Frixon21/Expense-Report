import { z } from "zod";
import { isoDateSchema as dateSchema } from "./iso-date";

const requiredText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} is too long.`);

export const EXPENSE_CATEGORIES = [
  { id: "travel", label: "Travel (lodging, etc.)" },
  { id: "meals", label: "Business meals" },
  { id: "client_project", label: "Client / project" },
  { id: "marketing", label: "Marketing" },
  { id: "shipping", label: "Shipping" },
  { id: "communications", label: "Communications / internet" },
  { id: "supplies", label: "Supplies" },
  { id: "other", label: "Other business expense" },
] as const;

export const PAYMENT_METHODS = [
  { id: "company_card", label: "Company card" },
  { id: "personal_card", label: "Personal card (reimburse)" },
  { id: "cash", label: "Cash (reimburse)" },
] as const;

export type ExpenseCategoryId = (typeof EXPENSE_CATEGORIES)[number]["id"];
export type PaymentMethodId = (typeof PAYMENT_METHODS)[number]["id"];

const moneyInput = z
  .string()
  .trim()
  .regex(/^\d{1,7}(?:\.\d{1,2})?$/, "Enter a valid dollar amount.")
  .transform((value) => Math.round(Number(value) * 100));

const expenseCategorySchema = z.enum([
  "travel",
  "meals",
  "client_project",
  "marketing",
  "shipping",
  "communications",
  "supplies",
  "other",
]);

const paymentMethodSchema = z.enum(["company_card", "personal_card", "cash"]);

/** Stored expense rows (amount is cents). */
export const expenseRecordSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  date: dateSchema,
  category: expenseCategorySchema,
  amount: z.number().int().nonnegative(),
  paymentMethod: paymentMethodSchema,
  merchant: z.string().min(1).max(200),
  businessPurpose: z.string().min(1).max(500),
  projectOrClient: z.string().max(150).optional(),
  notes: z.string().max(500).optional(),
  receiptFileName: z.string().max(200).optional(),
  receiptMimeType: z.string().max(100).optional(),
  /** Base64 data URL (larger than raw file size). */
  receiptDataUrl: z.string().max(72_000_000).optional(),
});

export const expenseInputSchema = z.object({
  date: dateSchema,
  category: expenseCategorySchema,
  amount: moneyInput,
  paymentMethod: paymentMethodSchema,
  merchant: requiredText("Merchant or description", 200),
  businessPurpose: requiredText("Business purpose", 500),
  projectOrClient: z
    .string()
    .trim()
    .max(150, "Project or client is too long.")
    .transform((value) => value || undefined),
  notes: z
    .string()
    .trim()
    .max(500, "Notes are too long.")
    .transform((value) => value || undefined),
});

export type ExpenseInput = z.infer<typeof expenseInputSchema>;
export type Expense = z.infer<typeof expenseRecordSchema>;

export const MAX_RECEIPT_BYTES = 50 * 1024 * 1024;

const formatMegabytes = (bytes: number) =>
  (bytes / (1024 * 1024)).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });

export function receiptImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = setTimeout(() => {
      image.src = "";
      reject(
        new Error(
          "Receipt image could not be decoded. Use a readable JPG or PNG.",
        ),
      );
    }, 15000);
    image.onload = () => {
      clearTimeout(timeout);
      if (
        !image.naturalWidth ||
        !image.naturalHeight ||
        image.naturalWidth * image.naturalHeight > 40_000_000
      )
        reject(
          new Error(
            "Receipt image is empty or too large to preview. Use a smaller JPG or PNG.",
          ),
        );
      else resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timeout);
      reject(
        new Error(
          "Unreadable or unsupported receipt image. Try JPG, PNG or a readable PDF.",
        ),
      );
    };
    image.src = dataUrl;
  });
}

export async function rotateReceiptImage(dataUrl: string): Promise<string> {
  const image = await receiptImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalHeight;
  canvas.height = image.naturalWidth;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot rotate images.");
  context.translate(canvas.width, 0);
  context.rotate(Math.PI / 2);
  context.drawImage(image, 0, 0);
  const result = canvas.toDataURL("image/png");
  if (result.length > Math.ceil((MAX_RECEIPT_BYTES * 4) / 3) + 100)
    throw new Error("Rotated receipt exceeds 50 MB. Use a smaller image.");
  return result;
}

export async function readReceiptFile(
  file: File,
): Promise<{ fileName: string; mimeType: string; dataUrl: string }> {
  if (!file.size) throw new Error("This receipt file is empty.");
  if (file.size > MAX_RECEIPT_BYTES)
    throw new Error(
      "Receipt must be " +
        formatMegabytes(MAX_RECEIPT_BYTES) +
        " MB or smaller.",
    );
  const inferred = /\.pdf$/i.test(file.name)
    ? "application/pdf"
    : /\.png$/i.test(file.name)
      ? "image/png"
      : /\.jpe?g$/i.test(file.name)
        ? "image/jpeg"
        : "";
  const mimeType = file.type || inferred;
  if (
    !(mimeType.startsWith("image/") || mimeType === "application/pdf") ||
    mimeType === "image/svg+xml"
  )
    throw new Error("Use a readable photo (JPG, PNG, etc.) or PDF.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string" && reader.result.startsWith("data:")
        ? resolve(reader.result.replace(/^data:[^;,]*/, "data:" + mimeType))
        : reject(new Error("Could not read that receipt file."));
    reader.onerror = reader.onabort = () =>
      reject(
        new Error("Could not read that receipt file. Try choosing it again."),
      );
    reader.readAsDataURL(file);
  });
  if (mimeType === "application/pdf") {
    try {
      const { PDFDocument } = await import("pdf-lib");
      const pdf = await PDFDocument.load(dataUrl);
      if (!pdf.getPageCount()) throw new Error("No pages");
    } catch {
      throw new Error(
        "Unreadable or password-protected PDF. Choose an unlocked PDF or a photo.",
      );
    }
  } else await receiptImage(dataUrl);
  return { fileName: file.name.slice(0, 200), mimeType, dataUrl };
}

export const categoryLabel = (id: ExpenseCategoryId) =>
  EXPENSE_CATEGORIES.find((item) => item.id === id)?.label ?? id;

export const paymentMethodLabel = (id: PaymentMethodId) =>
  PAYMENT_METHODS.find((item) => item.id === id)?.label ?? id;

export const formatExpenseAmount = (cents: number) =>
  (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

/** Personal card and cash are reimbursed; company card is already paid. */
export const expenseReimbursableCents = (expense: Expense) =>
  expense.paymentMethod === "company_card" ? 0 : expense.amount;
