import { z } from "zod";
import type { DemoEmployee, TripPayrollMeta } from "@/lib/demo-types";
import { createPayrollEmployeeReport } from "@/lib/payroll-pdf";
import { privateError, privateJson, requestJson, requireProtectedMutation, requireUser } from "@/lib/server/http";
import { authorizedEmployeeSnapshot, HttpError, payrollRates, tripRateCentsPerMile } from "@/lib/server/records";
import { payrollReportAvailability, payrollReportUnavailableReason, requirePayrollReportUser, validatePayrollReportRange } from "@/lib/server/payroll-reports";
import { payrollLinesForEmployee } from "@/lib/payroll-lines";
import { payrollReportDisposition, payrollReportFilename, payrollReportName } from "@/lib/payroll-report";

export const runtime = "nodejs";

function asArrayBuffer(bytes: Uint8Array) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const params = new URL(request.url).searchParams;
    return privateJson(payrollReportAvailability(user, params.get("from") ?? "", params.get("to") ?? "", {
      query: params.get("q") ?? undefined,
      page: params.has("page") ? Number(params.get("page")) : 1,
      onlyWithRecords: params.get("withRecords") === "true",
    }));
  } catch (error) { return privateError(error); }
}

export async function POST(request: Request) {
  try {
    requireProtectedMutation(request);
    const user = await requireUser(request);
    requirePayrollReportUser(user);
    const parsed = z.object({ employeeId: z.string().min(1), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(await requestJson(request));
    if (!parsed.success) return Response.json({ error: "Choose an employee and valid report range." }, { status: 400 });
    validatePayrollReportRange(parsed.data.from, parsed.data.to);
    const { target, snapshot } = authorizedEmployeeSnapshot(user, parsed.data.employeeId);
    const recordCount = payrollLinesForEmployee(snapshot.state.trips, snapshot.expenses, parsed.data.from, parsed.data.to).length;
    const unavailableReason = payrollReportUnavailableReason(Boolean(snapshot.state.profile), recordCount);
    if (unavailableReason) throw new HttpError(409, unavailableReason);
    const rates = payrollRates(user);
    const tripMeta: Record<string, TripPayrollMeta> = {};
    for (const trip of snapshot.state.trips) {
      const status = trip.status as string | undefined;
      tripMeta[trip.id] = {
        processed: status === "Processed" || status === "Paid" || status === "Voided",
        paid: status === "Paid",
        processedRateCentsPerMile: (trip.processedRateCentsPerMile as number | null | undefined) ?? null,
      };
    }
    const expenseMeta: Record<string, { processed: boolean; paid: boolean }> = {};
    for (const expense of snapshot.expenses) {
      expenseMeta[expense.id] = { processed: expense.status === "Processed" || expense.status === "Paid" || expense.status === "Voided", paid: expense.status === "Paid" };
    }
    const employee: DemoEmployee = {
      id: target.id,
      state: snapshot.state,
      expenses: snapshot.expenses,
      tripMeta,
      expenseMeta,
    };
    const tripRatesCentsPerMile = Object.fromEntries(
      snapshot.state.trips
        .map((trip) => [trip.id, tripRateCentsPerMile(rates, trip.date, trip.processedRateCentsPerMile)] as const)
        .filter((entry): entry is readonly [string, number] => entry[1] !== null),
    );
    const dollarsPerMile = Math.max(0, Number(rates.find((rate) => rate.effective_from <= parsed.data.to)?.cents_per_mile ?? 0) / 100);
    const bytes = await createPayrollEmployeeReport({ employee, from: parsed.data.from, to: parsed.data.to, dollarsPerMile, tripRatesCentsPerMile });
    const filename = payrollReportFilename(payrollReportName(snapshot.state.profile?.driverName, target.displayName), parsed.data.from, parsed.data.to);
    return new Response(asArrayBuffer(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": payrollReportDisposition(filename), "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return privateError(error);
  }
}
