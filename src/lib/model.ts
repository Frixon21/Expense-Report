import { z } from "zod";

export const safeFilenamePart = (value: string) =>
  value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "driver";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a valid date.")
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`);
    return value >= "1900-01-01" && date.toISOString().slice(0, 10) === value;
  }, "Choose a valid date.");

const requiredText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} is too long.`);

const odometerInput = z
  .string()
  .trim()
  .regex(
    /^\d{1,8}(\.\d)?$/,
    "Use a nonnegative odometer reading with at most one decimal place.",
  )
  .transform((value) => {
    const [whole, tenth = "0"] = value.split(".");
    return Number(whole) * 10 + Number(tenth);
  });

const optionalOdometerInput = z
  .string()
  .trim()
  .transform((value, context) => {
    if (!value) return null;
    const parsed = odometerInput.safeParse(value);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message: parsed.error.issues[0]?.message ?? "Invalid odometer reading.",
      });
      return z.NEVER;
    }
    return parsed.data;
  });

const moneyInput = z
  .string()
  .trim()
  .regex(/^(?:\d{1,7}(?:\.\d{1,2})?)?$/, "Enter a valid dollar amount.")
  .transform((value) => (value ? Math.round(Number(value) * 100) : 0));

export const profileSchema = z.object({
  driverName: requiredText("Driver name", 100),
  businessName: requiredText("Business name", 150),
  vehicleDescription: requiredText("Vehicle description", 150),
  businessUseStartDate: dateSchema,
});

export const tripInputSchema = z
  .object({
    date: dateSchema,
    destination: requiredText("Destination or area", 200),
    businessPurpose: requiredText("Business purpose", 500),
    start: odometerInput,
    end: odometerInput,
    parking: moneyInput,
    tolls: moneyInput,
  })
  .refine((value) => value.end >= value.start, {
    path: ["end"],
    message: "Ending odometer must be at least the starting odometer.",
  })
  .transform((value) => ({
    date: value.date,
    destination: value.destination,
    businessPurpose: value.businessPurpose,
    start_tenths: value.start,
    end_tenths: value.end,
    parking_cents: value.parking,
    tolls_cents: value.tolls,
  }));

export const annualMileageInputSchema = z
  .object({
    year: z.number().int().min(1900).max(9999),
    opening: optionalOdometerInput,
    closing: optionalOdometerInput,
  })
  .refine(
    (value) =>
      value.opening === null ||
      value.closing === null ||
      value.closing >= value.opening,
    {
      path: ["closing"],
      message:
        "Closing/current odometer must be at least the opening odometer.",
    },
  )
  .transform((value) => ({
    year: value.year,
    opening_tenths: value.opening,
    closing_tenths: value.closing,
  }));

export const profileRecordSchema = profileSchema;
export const annualMileageRecordSchema = z
  .object({
    year: z.number().int().min(1900).max(9999),
    opening_tenths: z.number().int().nonnegative().nullable(),
    closing_tenths: z.number().int().nonnegative().nullable(),
  })
  .refine(
    (value) =>
      value.opening_tenths === null ||
      value.closing_tenths === null ||
      value.closing_tenths >= value.opening_tenths,
    "Closing mileage must follow opening mileage.",
  );

export const tripRecordSchema = z
  .object({
    id: z.string().uuid(),
    date: dateSchema,
    destination: requiredText("Destination or area", 200),
    businessPurpose: requiredText("Business purpose", 500),
    start_tenths: z.number().int().nonnegative(),
    end_tenths: z.number().int().nonnegative(),
    parking_cents: z.number().int().nonnegative(),
    tolls_cents: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .refine(
    (value) => value.end_tenths >= value.start_tenths,
    "Ending mileage must follow starting mileage.",
  );

export const mileageStateSchema = z.object({
  version: z.literal(1),
  profile: profileRecordSchema.nullable(),
  annualMileage: z.array(annualMileageRecordSchema),
  trips: z.array(tripRecordSchema),
});

export type Profile = z.infer<typeof profileRecordSchema>;
export type AnnualMileage = z.infer<typeof annualMileageRecordSchema>;
export type Trip = z.infer<typeof tripRecordSchema>;
export type MileageState = z.infer<typeof mileageStateSchema>;

export const emptyState = (): MileageState => ({
  version: 1,
  profile: null,
  annualMileage: [],
  trips: [],
});
export const formatMiles = (tenths: number) => (tenths / 10).toFixed(1);
export const formatDollars = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
export const totalBusinessMiles = (trips: ReadonlyArray<Trip>) =>
  trips.reduce((sum, trip) => sum + trip.end_tenths - trip.start_tenths, 0);

export const isFullTaxYearRange = (from: string, to: string) => {
  const year = Number(from.slice(0, 4));
  return from === `${year}-01-01` && to === `${year}-12-31`;
};

export const annualMileageComplete = (
  state: MileageState,
  year: number,
): boolean => {
  const record = state.annualMileage.find((item) => item.year === year);
  return (
    record !== undefined &&
    record.opening_tenths !== null &&
    record.closing_tenths !== null
  );
};

export const lastTripEndTenths = (trips: ReadonlyArray<Trip>): number | null => {
  if (!trips.length) return null;
  const latest = [...trips].sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    return byDate !== 0 ? byDate : b.createdAt.localeCompare(a.createdAt);
  })[0];
  return latest?.end_tenths ?? null;
};

export const tenthsToOdometerInput = (tenths: number) =>
  (tenths / 10).toFixed(1).replace(/\.0$/, "");

export type DateRangePreset = {
  id: string;
  label: string;
  from: string;
  to: string;
};

export const dateRangePresets = (reference = new Date()): DateRangePreset[] => {
  const year = reference.getFullYear();
  const month = reference.getMonth();
  const monthStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const monthEnd = new Date(year, month + 1, 0).toLocaleDateString("en-CA");
  const today = reference.toLocaleDateString("en-CA");
  return [
    { id: "today", label: "Today", from: today, to: today },
    { id: "month", label: "This month", from: monthStart, to: monthEnd },
    { id: "ytd", label: "Year to date", from: `${year}-01-01`, to: today },
    {
      id: "tax-year",
      label: `${year} tax year`,
      from: `${year}-01-01`,
      to: `${year}-12-31`,
    },
  ];
};
