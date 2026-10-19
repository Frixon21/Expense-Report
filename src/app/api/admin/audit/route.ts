import { securityAudit } from "@/lib/server/records";
import { privateError, privateJson, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const params = new URL(request.url).searchParams;
    return privateJson(securityAudit(user, {
      query: params.get("q") ?? undefined,
      event: params.get("event") ?? undefined,
      actor: params.get("actor") ?? undefined,
      account: params.get("account") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
      page: params.has("page") ? Number(params.get("page")) : 1,
    }));
  } catch (error) {
    return privateError(error);
  }
}
