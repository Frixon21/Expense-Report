import { createMileageRate, payrollRates } from "@/lib/server/records";
import { privateError, privateJson, requestJson, requireProtectedMutation, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return privateJson({ rates: payrollRates(user) });
  } catch (error) {
    return privateError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireProtectedMutation(request);
    const user = await requireUser(request);
    return privateJson({ rates: createMileageRate(user, await requestJson(request)) }, 201);
  } catch (error) {
    return privateError(error);
  }
}
