import { hasRole } from "@/lib/server/db";
import { receiptForUser, ensureEmployee } from "@/lib/server/records";
import { privateError, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    if (!hasRole(user, "payroll")) ensureEmployee(user);
    const { id } = await context.params;
    const receipt = receiptForUser(user, id);
    const filename =
      receipt.fileName
        .toWellFormed()
        .replace(/[\x00-\x1f\x7f"\\/]/g, "_")
        .slice(0, 180) || "receipt";
    const asciiFilename = filename.replace(/[^\x20-\x7e]/g, "_");
    const encodedFilename = encodeURIComponent(filename.toWellFormed()).replace(
      /['()*]/g,
      (value) => "%" + value.charCodeAt(0).toString(16).toUpperCase(),
    );
    const disposition =
      receipt.mimeType === "application/octet-stream" ? "attachment" : "inline";
    return new Response(receipt.bytes, {
      headers: {
        "Content-Type": receipt.mimeType,
        "Content-Disposition": `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": "sandbox; frame-ancestors 'self'",
      },
    });
  } catch (error) {
    return privateError(error);
  }
}
