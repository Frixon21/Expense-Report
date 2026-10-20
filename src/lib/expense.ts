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

export const readReceiptFile = (
  file: File,
): Promise<{ fileName: string; mimeType: string; dataUrl: string }> =>
  new Promise((resolve, reject) => {
    if (file.size > MAX_RECEIPT_BYTES) {
      reject(
        new Error(
          `Receipt must be ${formatMegabytes(MAX_RECEIPT_BYTES)} MB or smaller.`,
        ),
      );
      return;
    }
    const allowed =
      file.type.startsWith("image/") ||
      file.type === "application/pdf" ||
      file.type === "";
    if (!allowed) {
      reject(new Error("Use a photo (JPG, PNG, etc.) or PDF."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      if (!dataUrl.startsWith("data:")) {
        reject(new Error("Could not read that file."));
        return;
      }
      resolve({
        fileName: file.name.slice(0, 200),
        mimeType: file.type || "application/octet-stream",
        dataUrl,
      });
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });

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
