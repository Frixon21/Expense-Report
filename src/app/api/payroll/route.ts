import { transitionPayrollRecord, payrollSnapshot } from "@/lib/server/records";
import { privateError, privateJson, requestJson, requireProtectedMutation, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return privateJson(payrollSnapshot(user));
  } catch (error) {
    return privateError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireProtectedMutation(request);
    const user = await requireUser(request);
    return privateJson(transitionPayrollRecord(user, await requestJson(request)));
  } catch (error) {
    return privateError(error);
  }
}
