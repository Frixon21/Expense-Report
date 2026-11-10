import { HttpError } from "./records";
import { currentUser, requestHasSameOrigin, requestUsesHttpTransport } from "./auth";
import type { AppUser } from "./db";

const MAX_JSON_BYTES = 16 * 1024;
export const MAX_EMPLOYEE_REQUEST_BYTES = 80 * 1024 * 1024;

export function privateJson(value: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store, private");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return Response.json(value, { status, headers: responseHeaders });
}

export function privateError(error: unknown) {
  if (error instanceof HttpError) return privateJson({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return privateJson({ error: "Request body must be valid JSON." }, 400);
  return privateJson({ error: "The request could not be completed." }, 500);
}

export function requireProtectedMutation(request: Request) {
  if (!requestUsesHttpTransport(request)) throw new HttpError(400, "Use the configured internal HTTP app address.");
  if (!requestHasSameOrigin(request)) throw new HttpError(403, "The request origin could not be verified.");
}

export async function requireUser(request: Request, allowPending = false): Promise<AppUser> {
  const user = await currentUser(request, allowPending);
  if (!user) throw new HttpError(401, "Sign in to continue.");
  return user;
}

export async function requestJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > maxBytes) throw new HttpError(413, "Request body is too large.");
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new HttpError(413, "Request body is too large.");
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const buffer = Buffer.concat(chunks, total);
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    throw new SyntaxError("Invalid JSON body.");
  }
}
