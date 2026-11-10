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

const legacyIssuer = "http://synthetic-legacy.example.test";
function approveAlias() {
  vi.stubEnv("BT_AUTH_LEGACY_ISSUER", legacyIssuer);
  vi.stubEnv("BT_AUTH_LEGACY_SUBJECTS", JSON.stringify(["synthetic-subject"]));
}
function originalAccount(subject = "synthetic-subject", email = "synthetic@example.test") {
  db.prepare("INSERT INTO users(id,issuer,subject,display_name,email,access_status,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?)")
    .run("original", legacyIssuer, subject, "Original", email, new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO roles(user_id,role,granted_at) VALUES ('original','super_admin',?)").run(new Date().toISOString());
}
it("aliases only an explicitly approved verified subject, preserving original IDs, roles and issuer", async () => {
  originalAccount(); approveAlias();
  const identity = await authenticateWithBtAuth("synthetic", "synthetic-only-password");
  const user = registerVerifiedIdentity(identity);
  expect(user).toMatchObject({ id: "original", issuer: legacyIssuer, roles: ["super_admin"] });
  expect(db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
  const app = await createAppSession(user.id, identity.sessionProof);
  expect((await currentUser(new Request("http://localhost/api/me", { headers: { cookie: appSessionCookie(app.token, new Request("http://localhost")) } })))?.id).toBe("original");
  expect(db.prepare("SELECT event_type FROM audit_events WHERE event_type='identity_issuer_alias_used'").get()).toBeTruthy();
});
it("does not alias by email or without explicit subject approval", async () => {
  originalAccount("different-subject"); approveAlias();
  const identity = await authenticateWithBtAuth("synthetic", "synthetic-only-password");
  expect(registerVerifiedIdentity(identity).id).not.toBe("original");
  db.prepare("DELETE FROM audit_events").run(); db.prepare("DELETE FROM access_requests").run();
  db.prepare("DELETE FROM users WHERE id != 'original'").run();
  db.prepare("UPDATE users SET subject='synthetic-subject' WHERE id='original'").run();
  vi.stubEnv("BT_AUTH_LEGACY_SUBJECTS", JSON.stringify(["unapproved-subject"]));
  expect(registerVerifiedIdentity(identity).id).not.toBe("original");
});
it("fails closed for email disagreement and malformed or wildcard alias configuration", async () => {
  originalAccount("synthetic-subject", "different@example.test"); approveAlias();
  const identity = await authenticateWithBtAuth("synthetic", "synthetic-only-password");
  expect(() => registerVerifiedIdentity(identity)).toThrow("BT_AUTH_IDENTITY_CONFLICT");
  for (const value of ['["*"]', '[]', 'invalid', '[1]']) {
    vi.stubEnv("BT_AUTH_LEGACY_SUBJECTS", value);
    expect(() => registerVerifiedIdentity(identity)).toThrow("BT_AUTH_CONFIGURATION_INVALID");
  }
});
it("resolves an existing pending-session duplicate without changing either account or its session ownership", async () => {
  originalAccount();
  const identity = await authenticateWithBtAuth("synthetic", "synthetic-only-password");
  const pending = registerVerifiedIdentity(identity);
  const app = await createAppSession(pending.id, identity.sessionProof);
  const request = new Request("http://localhost/api/me", { headers: { cookie: appSessionCookie(app.token, new Request("http://localhost")) } });
  expect(await currentUser(request)).toBeNull();
  const before = db.prepare("SELECT * FROM users ORDER BY id").all();
  approveAlias();
  expect((await currentUser(request))?.id).toBe("original");
  expect(db.prepare("SELECT * FROM users ORDER BY id").all()).toEqual(before);
  expect(db.prepare("SELECT user_id FROM sessions WHERE id=?").get(app.id)).toEqual({ user_id: pending.id });
  expect(registerVerifiedIdentity(identity).id).toBe("original");
  db.prepare("UPDATE users SET access_status='disabled' WHERE id='original'").run();
  expect(await currentUser(request)).toBeNull();
});
it.each(["active", "role", "profile", "audit"])("rejects unsafe duplicate collision: %s", async (kind) => {
  originalAccount();
  const identity = await authenticateWithBtAuth("synthetic", "synthetic-only-password");
  const duplicate = registerVerifiedIdentity(identity);
  if (kind === "active") db.prepare("UPDATE users SET access_status='active' WHERE id=?").run(duplicate.id);
  if (kind === "role") db.prepare("INSERT INTO roles(user_id,role,granted_at) VALUES (?,'employee',?)").run(duplicate.id, new Date().toISOString());
  if (kind === "profile") db.prepare("INSERT INTO profiles(user_id,profile_json,updated_at) VALUES (?,'{}',?)").run(duplicate.id, new Date().toISOString());
  if (kind === "audit") db.prepare("INSERT INTO audit_events(id,actor_id,event_type,created_at) VALUES ('unsafe',?,'admin_action',?)").run(duplicate.id, new Date().toISOString());
  approveAlias();
  expect(() => registerVerifiedIdentity(identity)).toThrow("BT_AUTH_IDENTITY_CONFLICT");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("retains unexpired old-issuer sessions only with explicit subject approval and the same signing key", async () => {
  const { request, user } = await session();
  const newIssuer = "https://synthetic-new.example.test";
  vi.stubEnv("BT_AUTH_ISSUER", newIssuer);
  expect(await currentUser(request)).toBeNull();
  vi.stubEnv("BT_AUTH_LEGACY_ISSUER", issuer);
  vi.stubEnv("BT_AUTH_LEGACY_SUBJECTS", JSON.stringify(["synthetic-subject"]));
  expect((await currentUser(request))?.id).toBe(user.id);
  publishedKeys = [replacementKey];
  vi.setSystemTime(clock + 300_000);
  expect(await currentUser(request)).toBeNull();
});
it("still rejects old-issuer JWTs on fresh login when the alias is enabled", async () => {
  approveAlias();
  token = await new SignJWT({ email: "synthetic@example.test", upn: "synthetic" }).setProtectedHeader({ alg: "RS256", kid: key.kid }).setIssuer(legacyIssuer).setSubject("synthetic-subject").setIssuedAt(clock / 1000).setExpirationTime(clock / 1000 + 1800).sign(pair.privateKey);
  await expect(authenticateWithBtAuth("synthetic", "synthetic-only-password")).rejects.toMatchObject({ code: "BT_AUTH_ISSUER_MISMATCH" });
});

function confirmLegacyRealm() {
  vi.stubEnv("BT_AUTH_LEGACY_ISSUER", legacyIssuer);
  vi.stubEnv("BT_AUTH_LEGACY_SUBJECTS", undefined);
  vi.stubEnv("BT_AUTH_LEGACY_REALM_CONFIRMED", "true");
}
it("aliases a subject outside the individually verified list only with explicit whole-realm confirmation", async () => {
  originalAccount("another-subject");
  confirmLegacyRealm();
  token = await new SignJWT({ email: "synthetic@example.test", upn: "synthetic" }).setProtectedHeader({ alg: "RS256", kid: key.kid }).setIssuer(issuer).setSubject("another-subject").setIssuedAt(clock / 1000).setExpirationTime(clock / 1000 + 1800).sign(pair.privateKey);
  const identity = await authenticateWithBtAuth("synthetic", "synthetic-only-password");
  const user = registerVerifiedIdentity(identity);
  expect(user).toMatchObject({ id: "original", issuer: legacyIssuer, roles: ["super_admin"] });
  const app = await createAppSession(user.id, identity.sessionProof);
  const request = new Request("http://localhost/api/me", { headers: { cookie: appSessionCookie(app.token, new Request("http://localhost")) } });
  expect((await currentUser(request))?.id).toBe("original");
  db.prepare("UPDATE users SET access_status='disabled' WHERE id='original'").run();
  expect(await currentUser(request)).toBeNull();
});
it("keeps unknown subjects pending in whole-realm mode and does not find legacy users by email", async () => {
  originalAccount("different-subject"); confirmLegacyRealm();
  const identity = await authenticateWithBtAuth("synthetic", "synthetic-only-password");
  const user = registerVerifiedIdentity(identity);
  expect(user.id).not.toBe("original");
  expect(user.accessStatus).toBe("pending"); expect(user.roles).toEqual([]);
});
it("recovers a harmless pending duplicate session in whole-realm mode without rewriting ownership", async () => {
  originalAccount();
  const identity = await authenticateWithBtAuth("synthetic", "synthetic-only-password");
  const duplicate = registerVerifiedIdentity(identity);
  const app = await createAppSession(duplicate.id, identity.sessionProof);
  const request = new Request("http://localhost/api/me", { headers: { cookie: appSessionCookie(app.token, new Request("http://localhost")) } });
  confirmLegacyRealm();
  expect((await currentUser(request))?.id).toBe("original");
  expect(db.prepare("SELECT user_id FROM sessions WHERE id=?").get(app.id)).toEqual({user_id:duplicate.id});
  db.prepare("INSERT INTO roles(user_id,role,granted_at) VALUES (?,'employee',?)").run(duplicate.id,new Date().toISOString());
  expect(await currentUser(request)).toBeNull();
  expect(() => registerVerifiedIdentity(identity)).toThrow("BT_AUTH_IDENTITY_CONFLICT");
});
it("retains eligible old sessions in whole-realm mode while still enforcing expiry and current keys", async () => {
  const {request,user}=await session();
  vi.stubEnv("BT_AUTH_ISSUER", "https://synthetic-new.example.test");
  vi.stubEnv("BT_AUTH_LEGACY_ISSUER", issuer);
  vi.stubEnv("BT_AUTH_LEGACY_REALM_CONFIRMED", "true");
  expect((await currentUser(request))?.id).toBe(user.id);
  vi.setSystemTime(clock+1800_000);
  expect(await currentUser(request)).toBeNull();
});
it.each(["false", "1", "TRUE", "", "yes"])("rejects ambiguous whole-realm confirmation %j", async (value) => {
  confirmLegacyRealm(); vi.stubEnv("BT_AUTH_LEGACY_REALM_CONFIRMED", value);
  const identity=await authenticateWithBtAuth("synthetic", "synthetic-only-password");
  expect(() => registerVerifiedIdentity(identity)).toThrow("BT_AUTH_CONFIGURATION_INVALID");
});
it("rejects mixed alias modes and email disagreement even with whole-realm confirmation", async () => {
  originalAccount("synthetic-subject", "different@example.test"); confirmLegacyRealm();
  const identity=await authenticateWithBtAuth("synthetic", "synthetic-only-password");
  expect(() => registerVerifiedIdentity(identity)).toThrow("BT_AUTH_IDENTITY_CONFLICT");
  vi.stubEnv("BT_AUTH_LEGACY_SUBJECTS", '["synthetic-subject"]');
  expect(() => registerVerifiedIdentity(identity)).toThrow("BT_AUTH_CONFIGURATION_INVALID");
});
it("does not accept legacy-issued fresh JWTs in whole-realm mode", async () => {
  confirmLegacyRealm();
  token=await new SignJWT({email:"synthetic@example.test",upn:"synthetic"}).setProtectedHeader({alg:"RS256",kid:key.kid}).setIssuer(legacyIssuer).setSubject("synthetic-subject").setIssuedAt(clock/1000).setExpirationTime(clock/1000+1800).sign(pair.privateKey);
  await expect(authenticateWithBtAuth("synthetic","synthetic-only-password")).rejects.toMatchObject({code:"BT_AUTH_ISSUER_MISMATCH"});
});

it("recovers only an explicitly reviewed redundant denied duplicate while retaining denial, audit and original ownership", async () => {
  originalAccount();
  const identity=await authenticateWithBtAuth("synthetic","synthetic-only-password");
  const duplicate=registerVerifiedIdentity(identity);
  const duplicateSession=await createAppSession(duplicate.id,identity.sessionProof);
  db.prepare("UPDATE access_requests SET status='denied',reviewed_by='original',reviewed_at=? WHERE user_id=?").run(new Date().toISOString(),duplicate.id);
  db.prepare("INSERT INTO audit_events(id,actor_id,event_type,subject_user_id,details_json,created_at) VALUES ('denial-audit','original','access_request_denied',?,'{}',?)").run(duplicate.id,new Date().toISOString());
  db.prepare("INSERT INTO expenses(id,user_id,date,category,amount,payment_method,merchant,business_purpose,created_at,updated_at) VALUES ('original-expense','original','2026-11-03','supplies',1234,'personal_card','Synthetic','Preserve ownership',?,?)").run(new Date().toISOString(),new Date().toISOString());
  for(const [id,accountIssuer,status] of [["other-original",legacyIssuer,"active"],["other-duplicate",issuer,"pending"]])db.prepare("INSERT INTO users(id,issuer,subject,display_name,email,access_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id,accountIssuer,"other-subject","Other synthetic","other@example.test",status,new Date().toISOString(),new Date().toISOString());
  db.prepare("INSERT INTO access_requests(id,user_id,status,requested_at,reviewed_by,reviewed_at) VALUES ('other-denial','other-duplicate','denied',?,'original',?)").run(new Date().toISOString(),new Date().toISOString());
  const originalBefore=db.prepare("SELECT * FROM users WHERE id='original'").get();
  const rolesBefore=db.prepare("SELECT * FROM roles ORDER BY user_id,role").all();
  const expensesBefore=db.prepare("SELECT * FROM expenses ORDER BY id").all();
  const requestsBefore=db.prepare("SELECT * FROM access_requests ORDER BY id").all();
  const denialBefore=db.prepare("SELECT * FROM audit_events WHERE id='denial-audit'").get();
  confirmLegacyRealm();
  expect(()=>registerVerifiedIdentity(identity)).toThrow("BT_AUTH_IDENTITY_CONFLICT");
  db.exec('BEGIN IMMEDIATE');
  try {
    expect(db.prepare("SELECT count(*) AS n FROM roles WHERE user_id=?").get(duplicate.id)).toEqual({n:0});
    const result=db.prepare("UPDATE users SET issuer=?,access_status='disabled',updated_at=? WHERE id=? AND issuer=? AND subject=? AND access_status='pending'").run('urn:expense-report:retired-duplicate:'+duplicate.id,new Date().toISOString(),duplicate.id,issuer,identity.subject);
    expect(result.changes).toBe(1);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(duplicate.id);
    db.prepare("INSERT INTO audit_events(id,actor_id,event_type,subject_user_id,details_json,created_at) VALUES ('reviewed-retirement','original','duplicate_identity_retired',?,?,?)").run(duplicate.id,JSON.stringify({originalUserId:'original',previousIssuer:issuer,reason:'Operator confirmed denial targeted redundant request, not original person'}),new Date().toISOString());
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  expect(db.prepare("SELECT * FROM users WHERE id='original'").get()).toEqual(originalBefore);
  expect(db.prepare("SELECT * FROM roles ORDER BY user_id,role").all()).toEqual(rolesBefore);
  expect(db.prepare("SELECT * FROM expenses ORDER BY id").all()).toEqual(expensesBefore);
  expect(db.prepare("SELECT * FROM access_requests ORDER BY id").all()).toEqual(requestsBefore);
  expect(db.prepare("SELECT * FROM audit_events WHERE id='denial-audit'").get()).toEqual(denialBefore);
  expect(db.prepare("SELECT id FROM sessions WHERE id=?").get(duplicateSession.id)).toBeUndefined();
  expect(registerVerifiedIdentity(identity).id).toBe('original');
  const session=await createAppSession('original',identity.sessionProof);
  expect((await currentUser(new Request('http://localhost/api/me',{headers:{cookie:appSessionCookie(session.token,new Request('http://localhost'))}})))?.id).toBe('original');
  expect(()=>registerVerifiedIdentity({issuer,subject:'other-subject',email:'other@example.test',displayName:'Other synthetic'})).toThrow('BT_AUTH_IDENTITY_CONFLICT');
});
