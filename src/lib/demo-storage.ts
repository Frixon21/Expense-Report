import { z, ZodError } from "zod";
import { expenseRecordSchema } from "./expense";
import { createDemoOrg } from "./demo-seed";
import type { DemoOrg } from "./demo-types";
import { mileageStateSchema } from "./model";

export const DEMO_STORAGE_KEY = "biztech-mileage-demo-v1";

const tripMetaSchema = z.object({
  processed: z.boolean(),
  paid: z.boolean(),
  paidNote: z.string().max(200).optional(),
});

const demoEmployeeSchema = z.object({
  id: z.string().min(1),
  state: mileageStateSchema,
  expenses: z.array(expenseRecordSchema),
  tripMeta: z.record(z.string(), tripMetaSchema),
  expenseMeta: z.record(z.string(), tripMetaSchema),
});

const demoOrgV2Schema = z.object({
  version: z.literal(2),
  dollarsPerMile: z.number().positive().max(10),
  employees: z.array(demoEmployeeSchema),
});

const demoOrgV1Schema = z.object({
  version: z.literal(1),
  dollarsPerMile: z.number().positive().max(10),
  employees: z.array(
    z.object({
      id: z.string().min(1),
      state: mileageStateSchema,
      tripMeta: z.record(z.string(), tripMetaSchema),
    }),
  ),
});

const demoOrgSchema = demoOrgV2Schema;

function migrateV1ToV2(
  v1: z.infer<typeof demoOrgV1Schema>,
): z.infer<typeof demoOrgV2Schema> {
  return {
    version: 2,
    dollarsPerMile: v1.dollarsPerMile,
    employees: v1.employees.map((employee) => ({
      ...employee,
      expenses: [],
      expenseMeta: {},
    })),
  };
}

const browserStorage = () => {
  if (typeof window === "undefined")
    throw new Error("Browser storage is unavailable.");
  return window.localStorage;
};

export function loadDemoOrg(storage: Storage = browserStorage()): DemoOrg {
  try {
    const raw = storage.getItem(DEMO_STORAGE_KEY);
    if (!raw) return createDemoOrg();
    const json = JSON.parse(raw);
    const v2 = demoOrgV2Schema.safeParse(json);
    if (v2.success) return v2.data;
    const v1 = demoOrgV1Schema.safeParse(json);
    if (v1.success) {
      const migrated = migrateV1ToV2(v1.data);
      storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return createDemoOrg();
  } catch {
    return createDemoOrg();
  }
}

function formatSaveError(error: unknown): Error {
  if (error instanceof ZodError) {
    const detail = error.issues[0]?.message ?? "invalid data";
    return new Error(`Could not save demo data (${detail}).`);
  }
  if (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.code === 22)
  ) {
    return new Error(
      "Storage is full — try a smaller receipt or reset demo data.",
    );
  }
  if (error instanceof Error) return error;
  return new Error("Could not save demo data.");
}

export function saveDemoOrg(
  org: DemoOrg,
  storage: Storage = browserStorage(),
) {
  try {
    const valid = demoOrgSchema.parse(org);
    storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(valid));
  } catch (error) {
    throw formatSaveError(error);
  }
}

export function resetDemoOrg(storage: Storage = browserStorage()): DemoOrg {
  const seeded = createDemoOrg();
  saveDemoOrg(seeded, storage);
  return seeded;
}
