import { z } from "zod";
import { payPeriodDatePresets } from "./pay-period";
import { isoDateSchema } from "./iso-date";

export const safeFilenamePart = (value: string) =>
  value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "driver";

const dateSchema = isoDateSchema.refine(
  (value) => value >= "1900-01-01",
  "Choose a valid date.",
);

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

export const vehicleRecordSchema = z.object({
  id: z.string().uuid(),
  description: requiredText("Vehicle description", 150),
  businessUseStartDate: dateSchema.or(z.literal("")),
  retired: z.boolean(),
});
export type Vehicle = z.infer<typeof vehicleRecordSchema>;

export const tripInputSchema = z
  .object({
    date: dateSchema,
    destination: requiredText("Destination or area", 200),
    businessPurpose: requiredText("Business purpose", 500),
    vehicleId: z.string().uuid().optional(),
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
    vehicleId: value.vehicleId,
    start_tenths: value.start,
    end_tenths: value.end,
    parking_cents: value.parking,
    tolls_cents: value.tolls,
  }));

export const annualMileageInputSchema = z
  .object({
    year: z.number().int().min(1900).max(9999),
    vehicleId: z.string().uuid().optional(),
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
    vehicleId: value.vehicleId,
    opening_tenths: value.opening,
    closing_tenths: value.closing,
  }));

export const profileRecordSchema = profileSchema;
export const annualMileageRecordSchema = z
  .object({
    year: z.number().int().min(1900).max(9999),
    vehicleId: z.string().uuid().optional(),
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
    vehicleId: z.string().uuid().optional(),
    vehicleName: z.string().max(150).optional(),
    vehicleBusinessUseStartDate: z.string().optional(),
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
  vehicles: z.array(vehicleRecordSchema).optional(),
  defaultVehicleId: z.string().uuid().optional(),
  vehicleMigrationWarning: z.string().optional(),
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
  const used = new Set(
    state.trips
      .filter((t) => t.date.startsWith(String(year) + "-"))
      .map((t) => t.vehicleId ?? state.defaultVehicleId),
  );
  if (!used.size) used.add(state.defaultVehicleId);
  return [...used].every((vehicleId) =>
    state.annualMileage.some(
      (item) =>
        item.year === year &&
        (item.vehicleId ?? state.defaultVehicleId) === vehicleId &&
        item.opening_tenths !== null &&
        item.closing_tenths !== null,
    ),
  );
};

export const lastTripEndTenths = (
  trips: ReadonlyArray<Trip>,
): number | null => {
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
  payrollDate?: string;
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
    ...payPeriodDatePresets(reference),
  ];
};

/** Backward-compatible browser/demo state. Production IDs are assigned by the server migration. */
export function withLegacyVehicle(
  state: MileageState,
  initialId: string,
): MileageState {
  if (state.vehicles !== undefined || !state.profile) return state;
  if (!state.profile.vehicleDescription.trim())
    return {
      ...state,
      vehicles: [],
      vehicleMigrationWarning:
        "Existing vehicle profile is missing. Confirm the known car in Settings; trips have been retained.",
    };
  const vehicle: Vehicle = {
    id: initialId,
    description: state.profile.vehicleDescription,
    businessUseStartDate: state.profile.businessUseStartDate,
    retired: false,
  };
  return {
    ...state,
    vehicles: [vehicle],
    defaultVehicleId: initialId,
    trips: state.trips.map((t) =>
      t.vehicleId
        ? t
        : {
            ...t,
            vehicleId: initialId,
            vehicleName: t.vehicleName ?? vehicle.description,
            vehicleBusinessUseStartDate:
              t.vehicleBusinessUseStartDate ?? vehicle.businessUseStartDate,
          },
    ),
    annualMileage: state.annualMileage.map((a) => ({
      ...a,
      vehicleId: a.vehicleId ?? initialId,
    })),
  };
}
export function tripVehicleLabel(state: MileageState, trip: Trip) {
  return (
    trip.vehicleName ??
    state.vehicles?.find((v) => v.id === trip.vehicleId)?.description ??
    (!trip.vehicleId ? state.profile?.vehicleDescription : undefined) ??
    "Legacy vehicle needs review"
  );
}
