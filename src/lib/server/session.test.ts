import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, SignJWT } from "jose";
import { appSessionCookie, authenticateWithBtAuth, createAppSession, currentUser, deleteAppSession, registerVerifiedIdentity, MAX_SIGNING_KEY_STALENESS_MS } from "./auth";
import { createTestDatabase, setTestDatabase } from "./db";
import type { DatabaseSync } from "node:sqlite";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const secondPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const issuer = "https://synthetic-issuer.example.test";
const key = { ...pair.publicKey.export({ format: "jwk" }), kid: "synthetic-key", alg: "RS256", use: "sig" };
const replacementKey = { ...secondPair.publicKey.export({ format: "jwk" }), kid: key.kid, alg: "RS256", use: "sig" };
const clock = new Date("2026-10-19T23:30:00.000Z").getTime();
let db: DatabaseSync, unavailable: boolean, publishedKeys: typeof key[], token: string, jwksCalls: number;
beforeEach(async () => {
  db = createTestDatabase(); setTestDatabase(db); unavailable = false; publishedKeys = [key]; jwksCalls = 0;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(clock);
  vi.stubEnv("BT_AUTH_BASE_URL", "http://localhost:4321"); vi.stubEnv("BT_AUTH_JWKS_URL", "http://localhost:4321/.well-known/jwks.json"); vi.stubEnv("BT_AUTH_ISSUER", issuer);
  (globalThis as typeof globalThis & { __btAuthJwks?: unknown }).__btAuthJwks = undefined;
  token = await new SignJWT({ email: "synthetic@example.test", upn: "synthetic" }).setProtectedHeader({ alg: "RS256", kid: key.kid }).setIssuer(issuer).setSubject("synthetic-subject").setIssuedAt(Math.floor(clock / 1000)).setExpirationTime(Math.floor(clock / 1000) + 1800).sign(pair.privateKey);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input).endsWith("jwks.json")) { jwksCalls++; return unavailable ? new Response(null, { status: 503 }) : Response.json({ keys: publishedKeys }); }
    return new Response("{}", { headers: { "set-cookie": "bt_session=" + token + "; Path=/; HttpOnly" } });
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); setTestDatabase(null); db.close(); (globalThis as typeof globalThis & { __btAuthJwks?: unknown }).__btAuthJwks = undefined; });
async function session() {
  const identity = await authenticateWithBtAuth("synthetic", "synthetic-only-password");
  const user = registerVerifiedIdentity(identity);
  db.prepare("UPDATE users SET access_status='active' WHERE id=?").run(user.id);
  db.prepare("INSERT INTO roles(user_id,role,granted_at) VALUES (?,'employee',?)").run(user.id, new Date().toISOString());
  const app = await createAppSession(user.id, identity.sessionProof);
  const request = new Request("http://localhost/api/me", { headers: { cookie: appSessionCookie(app.token, new Request("http://localhost"), false, app.expiresAt) } });
  return { app, request, user };
}
it("expires at the provider midnight bound and persists no provider bearer token", async () => {
  const { app, request } = await session();
  expect(app.expiresAt.getTime()).toBe(clock + 1800_000);
  expect(decodeJwt(app.token).exp).toBe((clock + 1800_000) / 1000);
  expect(request.headers.get("cookie")).toContain("Max-Age=1800");
  expect(JSON.stringify(db.prepare("SELECT * FROM sessions").get())).not.toContain(token);
  expect(await currentUser(request)).not.toBeNull();
  vi.setSystemTime(clock + 1800_000);
  expect(await currentUser(request)).toBeNull();
});
it("keeps the app maximum of eight hours when the provider expires later", async () => {
  token = await new SignJWT({ email: "synthetic@example.test", upn: "synthetic" }).setProtectedHeader({ alg: "RS256", kid: key.kid }).setIssuer(issuer).setSubject("synthetic-subject").setIssuedAt(clock / 1000).setExpirationTime(clock / 1000 + 86400).sign(pair.privateKey);
  expect((await session()).app.expiresAt.getTime()).toBe(clock + 8 * 3600_000);
});
it("rejects key removal or replacement with the same key ID after refresh", async () => {
  const { request } = await session(); publishedKeys = [replacementKey];
  vi.setSystemTime(clock + 299_000); expect(await currentUser(request)).not.toBeNull();
  vi.setSystemTime(clock + 300_000); expect(await currentUser(request)).toBeNull(); expect(jwksCalls).toBe(2);
  publishedKeys = [{ ...replacementKey, kid: "new-key" }];
  vi.setSystemTime(clock + 600_000); expect(await currentUser(request)).toBeNull();
});
it("allows cached keys only up to fifteen minutes since the last successful refresh during an outage", async () => {
  const { request } = await session(); unavailable = true;
  vi.setSystemTime(clock + MAX_SIGNING_KEY_STALENESS_MS); expect(await currentUser(request)).not.toBeNull();
  vi.setSystemTime(clock + MAX_SIGNING_KEY_STALENESS_MS + 1); expect(await currentUser(request)).toBeNull();
});
it("rechecks expiry and key staleness after a slow refresh crosses their deadlines", async () => {
  const { request } = await session();
  vi.setSystemTime(clock + MAX_SIGNING_KEY_STALENESS_MS - 1000);
  vi.stubGlobal("fetch", async () => { vi.setSystemTime(clock + MAX_SIGNING_KEY_STALENESS_MS + 1000); return new Response(null, { status: 503 }); });
  expect(await currentUser(request)).toBeNull();
  vi.setSystemTime(clock + 1800_000 - 1000);
  vi.stubGlobal("fetch", async () => { vi.setSystemTime(clock + 1800_000 + 1000); return Response.json({ keys: [key] }); });
  expect(await currentUser(request)).toBeNull();
});
it("fails closed for legacy sessions, applies role/disablement changes immediately, and logs out only this app", async () => {
  const { request, app, user } = await session();
  db.prepare("DELETE FROM roles WHERE user_id=?").run(user.id);
  expect((await currentUser(request))?.roles).toEqual([]);
  db.prepare("UPDATE users SET access_status='disabled' WHERE id=?").run(user.id);
  expect(await currentUser(request)).toBeNull();
  db.prepare("UPDATE users SET access_status='active' WHERE id=?").run(user.id);
  db.prepare("UPDATE sessions SET provider_key_thumbprint=NULL WHERE id=?").run(app.id);
  expect(await currentUser(request)).toBeNull();
  await deleteAppSession(request);
  expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
});
