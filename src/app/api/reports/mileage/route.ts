import { z } from "zod";
import { createReport } from "@/lib/pdf";
import { privateError, requestJson, requireProtectedMutation, requireUser } from "@/lib/server/http";
import { authorizedEmployeeSnapshot } from "@/lib/server/records";

export const runtime = "nodejs";

function asArrayBuffer(bytes: Uint8Array) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export async function POST(request: Request) {
  try {
    requireProtectedMutation(request);
    const user = await requireUser(request);
    const parsed = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), employeeId: z.string().optional() }).safeParse(await requestJson(request));
    if (!parsed.success) return Response.json({ error: "Choose a valid report range." }, { status: 400 });
    const { target, snapshot } = authorizedEmployeeSnapshot(user, parsed.data.employeeId ?? user.id);
    const bytes = await createReport({ state: snapshot.state, from: parsed.data.from, to: parsed.data.to });
    const safeName = target.displayName.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "employee";
    return new Response(asArrayBuffer(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${safeName}-mileage-${parsed.data.from}-${parsed.data.to}.pdf"`, "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return privateError(error);
  }
}
