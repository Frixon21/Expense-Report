import { currentUser } from "@/lib/server/auth";
import { hasRole } from "@/lib/server/db";
import { receiptForUser, ensureEmployee } from "@/lib/server/records";
import { privateError, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    if (!hasRole(user, "payroll")) ensureEmployee(user);
    const { id } = await context.params;
    const receipt = receiptForUser(user, id);
    const filename = receipt.fileName.replace(/[\r\n"\\]/g, "_").slice(0, 180) || "receipt";
    return new Response(receipt.bytes, {
      headers: {
        "Content-Type": receipt.mimeType,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      },
    });
  } catch (error) {
    return privateError(error);
  }
}
