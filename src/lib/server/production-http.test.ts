import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as read, POST as save } from "@/app/api/me/route";
import { GET as payroll } from "@/app/api/payroll/route";
import { createTestDatabase, setTestDatabase } from "./db";
import { authenticateWithBtAuth, requestUsesHttpTransport } from "./auth";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const unrelatedPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
// The issuer is an identifier, deliberately independent of HTTP transport.
const issuer = "https://synthetic-issuer.example.test";
const origin = "http://expenses.internal.test:3000";
const base = "http://btauth:3210";
const key = { ...pair.publicKey.export({ format: "jwk" }), kid: "http-test", alg: "RS256", use: "sig" };
type FixtureGlobal = typeof globalThis & { __expenseReportDb?: ReturnType<typeof createTestDatabase>; __btAuthJwks?: unknown };
const fixtureGlobal = globalThis as FixtureGlobal;
let db: ReturnType<typeof createTestDatabase>;
let originalDb: FixtureGlobal["__expenseReportDb"];
let token: string;

async function signedToken(options: { issuer?: string; expired?: boolean; wrongKey?: boolean } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: "synthetic@example.test", upn: "synthetic" })
    .setProtectedHeader({ alg: "RS256", kid: key.kid }).setIssuer(options.issuer ?? issuer)
    .setSubject("synthetic-http-employee").setIssuedAt(now - 60)
    .setExpirationTime(options.expired ? now - 1 : now + 1800)
    .sign(options.wrongKey ? unrelatedPair.privateKey : pair.privateKey);
}

function request(path: string, cookie = "", body?: unknown, requestOrigin: string | null = origin) {
  return new Request(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, "content-type": "application/json", ...(requestOrigin === null ? {} : { origin: requestOrigin }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  db = createTestDatabase(); setTestDatabase(db);
  originalDb = fixtureGlobal.__expenseReportDb;
  // The production branch uses this same in-memory fixture, never a disk database.
  fixtureGlobal.__expenseReportDb = db;
  fixtureGlobal.__btAuthJwks = undefined;
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_PUBLIC_ORIGIN", origin);
  vi.stubEnv("AUTH_SESSION_SECRET", "synthetic-production-http-secret-at-least-32-bytes");
  vi.stubEnv("BT_AUTH_BASE_URL", base);
  vi.stubEnv("BT_AUTH_JWKS_URL", base + "/.well-known/jwks.json");
  vi.stubEnv("BT_AUTH_ISSUER", issuer);
  vi.stubEnv("BT_AUTH_ALLOW_HTTP", undefined);
  vi.stubEnv("AUTH_TRUST_PROXY", undefined);
  token = await signedToken();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith("http://btauth:3210/")).toBe(true);
    expect(init?.redirect).toBe("manual");
    if (url === base + "/.well-known/jwks.json") return Response.json({ keys: [key] });
    expect(url).toBe(base + "/auth/local-login");
    return Response.json({}, { headers: { "set-cookie": `bt_session=${token}; Domain=.biztechro.com; HttpOnly; SameSite=Lax` } });
  });
});

afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  fixtureGlobal.__expenseReportDb = originalDb;
  fixtureGlobal.__btAuthJwks = undefined;
  setTestDatabase(null); db.close();
});

async function employeeCookie() {
  const response = await login(request("/api/auth/login", "", { username: "synthetic", password: "synthetic-only" }));
  expect(response.status).toBe(200);
  const user = (await response.json()).user;
  db.prepare("UPDATE users SET access_status='active' WHERE id=?").run(user.id);
  db.prepare("INSERT INTO roles(user_id,role,granted_at) VALUES (?,'employee',?)").run(user.id, new Date().toISOString());
  const header = response.headers.get("set-cookie")!;
  expect(header).toContain("HttpOnly"); expect(header).toContain("SameSite=Lax");
  expect(header).not.toMatch(/(?:^|;)\s*Secure(?:;|$)/i);
  expect(header).not.toMatch(/(?:^|;)\s*Domain=/i);
  return header.split(";")[0];
}

it("runs production HTTP login, authenticated reads, expense mutation and logout without an opt-in", async () => {
  const cookie = await employeeCookie();
  expect((await read(request("/api/me", cookie))).status).toBe(200);
  const body = {
    state: { version: 1, profile: null, annualMileage: [], trips: [] },
    expenses: [{ id: "11111111-1111-4111-8111-111111111111", createdAt: new Date().toISOString(), date: "2026-10-26", category: "supplies", amount: 4250, paymentMethod: "personal_card", merchant: "Synthetic shop", businessPurpose: "Synthetic HTTP test" }],
  };
  expect((await save(request("/api/me", cookie, body))).status).toBe(200);
  expect((await (await read(request("/api/me", cookie))).json()).expenses[0].merchant).toBe("Synthetic shop");
  expect((await payroll(request("/api/payroll", cookie))).status).toBe(403);
  const response = await logout(request("/api/auth/logout", cookie, {}));
  expect(response.status).toBe(200); expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await read(request("/api/me", cookie))).status).toBe(401);
});

it.each([null, "http://foreign.internal.test", "http://expenses.internal.test:3001"])("rejects missing or wrong mutation origin %s", async (badOrigin) => {
  const cookie = await employeeCookie();
  expect((await save(request("/api/me", cookie, {}, badOrigin))).status).toBe(403);
  expect((await login(request("/api/auth/login", "", {}, badOrigin))).status).toBe(403);
});

it("rejects an invalid app session on HTTP", async () => {
  expect((await read(request("/api/me", "expense_report_session=invalid"))).status).toBe(401);
});

it.each([{ issuer: "https://wrong-issuer.example.test" }, { expired: true }, { wrongKey: true }])("preserves production JWT rejection for %j", async (options) => {
  token = await signedToken(options);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const response = await login(request("/api/auth/login", "", { username: "synthetic", password: "synthetic-only" }));
  expect(response.status).toBe(503);
  expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  vi.restoreAllMocks();
});

it("still requires a persistent production session secret", async () => {
  vi.stubEnv("AUTH_SESSION_SECRET", undefined);
  const response = await login(request("/api/auth/login", "", { username: "synthetic", password: "synthetic-only" }));
  expect(response.status).toBe(500);
});

it("does not use forwarded protocol headers to change the HTTP-only transport", () => {
  expect(requestUsesHttpTransport(new Request(origin))).toBe(true);
  expect(requestUsesHttpTransport(new Request("ftp://expenses.internal.test"))).toBe(false);
  vi.stubEnv("AUTH_TRUST_PROXY", "true");
  expect(requestUsesHttpTransport(new Request("https://expenses.internal.test", { headers: { "x-forwarded-proto": "https" } }))).toBe(false);
});

it("rejects unsupported JWKS URL schemes before fetching keys", async () => {
  vi.stubEnv("BT_AUTH_JWKS_URL", "file:///synthetic-keys");
  await expect(authenticateWithBtAuth("synthetic", "synthetic-only")).rejects.toMatchObject({ code: "BT_AUTH_CONFIGURATION_INVALID" });
});

it("accepts HTTPS login and JWKS transport with an independent HTTP issuer", async () => {
  const secureBase = "https://synthetic-auth.example.test";
  const httpIssuer = "http://synthetic-auth.example.test";
  vi.stubEnv("BT_AUTH_BASE_URL", secureBase);
  vi.stubEnv("BT_AUTH_JWKS_URL", secureBase + "/.well-known/jwks.json");
  vi.stubEnv("BT_AUTH_ISSUER", httpIssuer);
  token = await signedToken({ issuer: httpIssuer });
  const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    expect(init?.cache).toBe("no-store");
    if (String(input) === secureBase + "/.well-known/jwks.json") return Response.json({ keys: [key] });
    expect(String(input)).toBe(secureBase + "/auth/local-login");
    return Response.json({}, { headers: { "set-cookie": `bt_session=${token}; Secure; HttpOnly` } });
  });
  vi.stubGlobal("fetch", upstream);
  await expect(authenticateWithBtAuth("synthetic", "synthetic-only")).resolves.toMatchObject({ issuer: httpIssuer, subject: "synthetic-http-employee" });
  expect(upstream).toHaveBeenCalledTimes(2);
  fixtureGlobal.__btAuthJwks = undefined;
  token = await signedToken({ issuer: "http://wrong-issuer.example.test" });
  await expect(authenticateWithBtAuth("synthetic", "synthetic-only")).rejects.toMatchObject({ code: "BT_AUTH_ISSUER_MISMATCH" });
});

it("reports HTTPS transport failures without accepting the login", async () => {
  vi.stubEnv("BT_AUTH_BASE_URL", "https://synthetic-auth.example.test");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("synthetic TLS failure")));
  await expect(authenticateWithBtAuth("synthetic", "synthetic-only")).rejects.toMatchObject({ code: "BT_AUTH_UPSTREAM_UNREACHABLE" });
});
it.each(["config", "collision"])("returns a sanitized diagnostic for alias %s failures during registration", async (kind) => {
  vi.stubEnv("BT_AUTH_LEGACY_ISSUER", "http://synthetic-old.example.test");
  vi.stubEnv("BT_AUTH_LEGACY_REALM_CONFIRMED", "true");
  vi.stubEnv("BT_AUTH_LEGACY_SUBJECTS", kind === "config" ? "[]" : undefined);
  if (kind === "collision") {
    for (const [id, accountIssuer, status] of [["original", "http://synthetic-old.example.test", "active"], ["duplicate", issuer, "active"]]) {
      db.prepare("INSERT INTO users(id,issuer,subject,display_name,email,access_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id,accountIssuer,"synthetic-http-employee","Synthetic","synthetic@example.test",status,new Date().toISOString(),new Date().toISOString());
    }
  }
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response=await login(request("/api/auth/login","",{username:"synthetic",password:"synthetic-only"}));
    const code=kind === "config" ? "BT_AUTH_CONFIGURATION_INVALID" : "BT_AUTH_IDENTITY_CONFLICT";
    expect(response.status).toBe(503);expect((await response.json()).code).toBe(code);
    expect(warning).toHaveBeenCalledWith("BT_AUTH_LOGIN_FAILURE",{stage:"account",code});
    expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({n:0});
    expect(JSON.stringify(warning.mock.calls)).not.toContain("synthetic-only");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("synthetic@example.test");
  }finally{warning.mockRestore();}
});
it.each(["account", "session"])("reports sanitized %s storage failures without exception details", async (stage) => {
  const table=stage === "account" ? "users" : "sessions";
  db.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'sensitive-synthetic-exception-detail'); END`);
  const warning=vi.spyOn(console,"warn").mockImplementation(()=>{});
  try {
    const response=await login(request("/api/auth/login","",{username:"synthetic",password:"synthetic-only"}));
    const code=stage === "account" ? "BT_AUTH_ACCOUNT_REGISTRATION_FAILED" : "BT_AUTH_APP_SESSION_FAILED";
    expect(response.status).toBe(500);expect((await response.json()).code).toBe(code);
    expect(warning).toHaveBeenCalledWith("BT_AUTH_LOGIN_FAILURE",{stage,code});
    expect(JSON.stringify(warning.mock.calls)).not.toContain("sensitive-synthetic-exception-detail");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("synthetic-only");
  }finally{warning.mockRestore();}
});
