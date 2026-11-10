import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as authMe } from "@/app/api/auth/me/route";
import { POST as bootstrap } from "@/app/api/admin/bootstrap/route";
import { GET as bootstrapAvailability } from "@/app/api/admin/bootstrap/availability/route";
import { GET as employeeData, POST as saveEmployee } from "@/app/api/me/route";
import { GET as expenseById } from "@/app/api/expenses/[id]/route";
import { GET as receiptById } from "@/app/api/expenses/[id]/receipt/route";
import { GET as payrollData } from "@/app/api/payroll/route";
import { POST as mileageReport } from "@/app/api/reports/mileage/route";
import { appSessionCookie, authenticateWithBtAuth, BtAuthIntegrationError, setTestAuthenticator } from "./auth";
import { createTestDatabase, getUser, setTestDatabase } from "./db";
import { adminRepairRecord, createMileageRate, transitionPayrollRecord } from "./records";
import type { DatabaseSync } from "node:sqlite";

const now = new Date().toISOString();
const syntheticPassword = "synthetic-only-password";
const aliceId = "11111111-1111-4111-8111-111111111111";
const bobId = "22222222-2222-4222-8222-222222222222";
const bobExpenseId = "33333333-3333-4333-8333-333333333333";

describe("server-side identity and ownership", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDatabase();
    setTestDatabase(db);
    process.env.FIRST_ADMIN_BOOTSTRAP_TOKEN = "synthetic-one-time-bootstrap-token";
  });

  afterEach(() => {
    setTestAuthenticator(null);
    setTestDatabase(null);
    db.close();
    delete process.env.FIRST_ADMIN_BOOTSTRAP_TOKEN;
  });

  async function addActiveEmployee(id: string, name: string, subject: string) {
    db.prepare(`INSERT INTO users (id, issuer, subject, display_name, email, access_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run(id, "https://synthetic.example.test", subject, name, `${subject}@example.test`, now, now);
    db.prepare("INSERT INTO roles (user_id, role, granted_at) VALUES (?, 'employee', ?)").run(id, now);
  }

  async function addSession(userId: string) {
    const { createAppSession } = await import("./auth");
    return createAppSession(userId);
  }

  function request(path: string, cookie: string, options: RequestInit = {}) {
    return new Request(`http://localhost${path}`, {
      ...options,
      headers: { cookie, ...(options.headers ?? {}) },
    });
  }

  it("creates a pending app request after synthetic BT Auth verification and bootstraps the first admin once", async () => {
    setTestAuthenticator(async (username, password) => {
      expect(username).toBe("first-admin@example.test");
      expect(password).toBe(syntheticPassword);
      return {
        issuer: "https://synthetic.example.test",
        subject: "first-admin-subject",
        displayName: "Synthetic Admin",
        email: "first-admin@example.test",
      };
    });

    const response = await login(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ username: "first-admin@example.test", password: syntheticPassword }),
    }));
    expect(response.status).toBe(200);
    const loginBody = await response.json();
    expect(loginBody.user.accessStatus).toBe("pending");
    expect(loginBody.user.roles).toEqual([]);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toContain("expense_report_session=");
    expect(db.prepare("SELECT COUNT(*) AS count FROM access_requests WHERE status = 'pending'").get()).toEqual({ count: 1 });

    const pending = await authMe(request("/api/auth/me", cookie!));
    expect((await pending.json()).user.accessStatus).toBe("pending");
    const eligibleBootstrap = await bootstrapAvailability(request("/api/admin/bootstrap/availability", cookie!));
    expect(await eligibleBootstrap.json()).toEqual({ available: true });

    const firstBootstrap = await bootstrap(request("/api/admin/bootstrap", cookie!, {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ token: "synthetic-one-time-bootstrap-token" }),
    }));
    expect(firstBootstrap.status).toBe(200);
    const active = await authMe(request("/api/auth/me", cookie!));
    expect((await active.json()).user.roles).toEqual(["employee", "super_admin"]);
    const noLongerEligible = await bootstrapAvailability(request("/api/admin/bootstrap/availability", cookie!));
    expect(await noLongerEligible.json()).toEqual({ available: false });

    const secondBootstrap = await bootstrap(request("/api/admin/bootstrap", cookie!, {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ token: "synthetic-one-time-bootstrap-token" }),
    }));
    expect(secondBootstrap.status).toBe(409);
  });

  it("hides first-admin setup from a pending employee when an active admin already exists", async () => {
    const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const pendingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    db.prepare("INSERT INTO users (id, issuer, subject, display_name, email, access_status, created_at, updated_at) VALUES (?, 'https://synthetic.example.test', 'existing-admin', 'Synthetic Admin', 'admin@example.test', 'active', ?, ?)")
      .run(adminId, now, now);
    db.prepare("INSERT INTO roles (user_id, role, granted_at) VALUES (?, 'super_admin', ?)").run(adminId, now);
    db.prepare("INSERT INTO users (id, issuer, subject, display_name, email, access_status, created_at, updated_at) VALUES (?, 'https://synthetic.example.test', 'pending-employee', 'Synthetic Employee', 'employee@example.test', 'pending', ?, ?)")
      .run(pendingId, now, now);
    db.prepare("INSERT INTO access_requests (id, user_id, status, requested_at) VALUES (?, ?, 'pending', ?)")
      .run("cccccccc-cccc-4ccc-8ccc-cccccccccccc", pendingId, now);

    const session = await addSession(pendingId);
    const cookie = "expense_report_session=" + encodeURIComponent(session.token);
    const response = await bootstrapAvailability(request("/api/admin/bootstrap/availability", cookie));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });

    const guarded = await bootstrap(request("/api/admin/bootstrap", cookie, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ token: "synthetic-one-time-bootstrap-token" }),
    }));
    expect(guarded.status).toBe(409);
  });

  it("denies direct cross-user expense and receipt requests and ignores caller-supplied owner ids", async () => {
    await addActiveEmployee(aliceId, "Synthetic Alice", "alice-subject");
    await addActiveEmployee(bobId, "Synthetic Bob", "bob-subject");
    db.prepare(`INSERT INTO expenses (id, user_id, date, category, amount, payment_method, merchant, business_purpose,
      receipt_file_name, receipt_mime_type, receipt_data_url, created_at, updated_at)
      VALUES (?, ?, '2026-10-01', 'supplies', 2250, 'personal_card', 'Synthetic Store', 'Synthetic business purchase',
        'synthetic.png', 'image/png', 'data:image/png;base64,YWJj', ?, ?)`)
      .run(bobExpenseId, bobId, now, now);
    const session = await addSession(aliceId);
    const cookie = `${"expense_report_session="}${encodeURIComponent(session.token)}`;

    const mine = await employeeData(request("/api/me", cookie));
    expect(mine.status).toBe(200);
    const snapshot = await mine.json();
    expect(snapshot.user.id).toBe(aliceId);
    expect(snapshot.expenses).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain(bobExpenseId);

    const directExpense = await expenseById(request(`/api/expenses/${bobExpenseId}`, cookie), { params: Promise.resolve({ id: bobExpenseId }) });
    expect(directExpense.status).toBe(404);
    const receipt = await receiptById(request(`/api/expenses/${bobExpenseId}/receipt`, cookie), { params: Promise.resolve({ id: bobExpenseId }) });
    expect(receipt.status).toBe(404);
    const foreignPdf = await mileageReport(request("/api/reports/mileage", cookie, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ from: "2026-10-01", to: "2026-10-31", employeeId: bobId }),
    }));
    expect(foreignPdf.status).toBe(403);

    const forgedSave = await saveEmployee(request("/api/me", cookie, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({
        userId: bobId,
        state: { version: 1, profile: null, annualMileage: [], trips: [] },
        expenses: [{
          id: bobExpenseId,
          createdAt: now,
          date: "2026-10-01",
          category: "supplies",
          amount: 2250,
          paymentMethod: "personal_card",
          merchant: "Synthetic Store",
          businessPurpose: "Synthetic business purchase",
        }],
      }),
    }));
    expect(forgedSave.status).toBe(404);
    expect((db.prepare("SELECT user_id FROM expenses WHERE id = ?").get(bobExpenseId) as { user_id: string }).user_id).toBe(bobId);

    const emptySnapshotSave = await saveEmployee(request("/api/me", cookie, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ state: { version: 1, profile: null, annualMileage: [], trips: [] }, expenses: [] }),
    }));
    expect(emptySnapshotSave.status).toBe(200);
    expect((db.prepare("SELECT user_id FROM expenses WHERE id = ?").get(bobExpenseId) as { user_id: string }).user_id).toBe(bobId);
  });

  it("reflects role removal and account disablement on the next protected request", async () => {
    await addActiveEmployee(aliceId, "Synthetic Alice", "alice-subject");
    const session = await addSession(aliceId);
    const cookie = `expense_report_session=${encodeURIComponent(session.token)}`;
    db.prepare("DELETE FROM roles WHERE user_id = ? AND role = 'employee'").run(aliceId);
    const removed = await employeeData(request("/api/me", cookie));
    expect(removed.status).toBe(403);

    db.prepare("UPDATE users SET access_status = 'disabled' WHERE id = ?").run(aliceId);
    const disabled = await employeeData(request("/api/me", cookie));
    expect(disabled.status).toBe(401);
  });

  it("logs out of the app without deleting a BT Auth cookie", async () => {
    await addActiveEmployee(aliceId, "Synthetic Alice", "alice-subject");
    const session = await addSession(aliceId);
    const cookie = `expense_report_session=${encodeURIComponent(session.token)}; bt_auth_session=synthetic-upstream-value`;
    const response = await logout(request("/api/auth/logout", cookie, { method: "POST", headers: { origin: "http://localhost" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("expense_report_session=");
    expect(response.headers.get("set-cookie")).not.toContain("bt_auth_session");
    const after = await employeeData(request("/api/me", `expense_report_session=${encodeURIComponent(session.token)}`));
    expect(after.status).toBe(401);
  });

  it("keeps employee accounts away from payroll business records", async () => {
    await addActiveEmployee(aliceId, "Synthetic Alice", "alice-subject");
    const session = await addSession(aliceId);
    const response = await payrollData(request("/api/payroll", `expense_report_session=${encodeURIComponent(session.token)}`));
    expect(response.status).toBe(403);
  });

  it("saves an employee expense under the signed-in employee and returns only that employee's record", async () => {
    await addActiveEmployee(aliceId, "Synthetic Alice", "alice-subject");
    await addActiveEmployee(bobId, "Synthetic Bob", "bob-subject");
    const session = await addSession(aliceId);
    const cookie = `expense_report_session=${encodeURIComponent(session.token)}`;
    const expenseId = "44444444-4444-4444-8444-444444444444";
    const saveResponse = await saveEmployee(request("/api/me", cookie, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({
      userId: bobId,
      state: { version: 1, profile: null, annualMileage: [], trips: [] },
      expenses: [{
        id: expenseId,
        createdAt: now,
        date: "2026-10-10",
        category: "supplies",
        amount: 4250,
        paymentMethod: "personal_card",
        merchant: "Synthetic Office Shop",
        businessPurpose: "Synthetic office supplies",
      }],
      }),
    }));
    expect(saveResponse.status).toBe(200);
    const saved = await saveResponse.json() as { expenses: Array<{ id: string }> };
    expect(saved.expenses.map((expense) => expense.id)).toEqual([expenseId]);
    expect((db.prepare("SELECT user_id FROM expenses WHERE id = ?").get(expenseId) as { user_id: string }).user_id).toBe(aliceId);
    const loaded = await employeeData(request("/api/me", cookie));
    expect((await loaded.json()).expenses.map((expense: { id: string }) => expense.id)).toEqual([expenseId]);
  });

  it("preserves a processed trip rate through reopening and audits an explicit correction", async () => {
    await addActiveEmployee(aliceId, "Synthetic Payroll", "payroll-subject");
    db.prepare("INSERT INTO roles (user_id, role, granted_at) VALUES (?, 'payroll', ?)").run(aliceId, now);
    const payrollUser = getUser(db, aliceId)!;
    createMileageRate(payrollUser, { effectiveFrom: "2026-01-01", centsPerMile: 50 });
    createMileageRate(payrollUser, { effectiveFrom: "2026-10-01", centsPerMile: 75 });
    const tripId = "55555555-5555-4555-8555-555555555555";
    db.prepare(`INSERT INTO trips (id, user_id, date, destination, business_purpose, start_tenths, end_tenths,
      parking_cents, tolls_cents, created_at, updated_at) VALUES (?, ?, '2026-06-15', 'Synthetic site',
      'Synthetic service visit', 1000, 1200, 0, 0, ?, ?)`)
      .run(tripId, aliceId, now, now);

    transitionPayrollRecord(payrollUser, { type: "trip", id: tripId, action: "process" });
    expect((db.prepare("SELECT processed_rate_cents_per_mile FROM trips WHERE id = ?").get(tripId) as { processed_rate_cents_per_mile: number }).processed_rate_cents_per_mile).toBe(50);
    transitionPayrollRecord(payrollUser, { type: "trip", id: tripId, action: "undo_processed", reason: "Synthetic reopening" });
    db.prepare("UPDATE trips SET date = '2026-10-15' WHERE id = ?").run(tripId);
    transitionPayrollRecord(payrollUser, { type: "trip", id: tripId, action: "process" });
    expect((db.prepare("SELECT processed_rate_cents_per_mile FROM trips WHERE id = ?").get(tripId) as { processed_rate_cents_per_mile: number }).processed_rate_cents_per_mile).toBe(50);

    transitionPayrollRecord(payrollUser, { type: "trip", id: tripId, action: "undo_processed", reason: "Synthetic reopening for correction" });
    transitionPayrollRecord(payrollUser, { type: "trip", id: tripId, action: "correct_rate", reason: "Synthetic corrected calculation", correctedRateCentsPerMile: 60 });
    expect((db.prepare("SELECT processed_rate_cents_per_mile FROM trips WHERE id = ?").get(tripId) as { processed_rate_cents_per_mile: number }).processed_rate_cents_per_mile).toBe(60);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'mileage_rate_correction'").get()).toEqual({ count: 1 });
  });

  it("allows an admin repair when optional expense fields are empty and records history", async () => {
    await addActiveEmployee(aliceId, "Synthetic Admin", "admin-subject");
    await addActiveEmployee(bobId, "Synthetic Employee", "employee-subject");
    db.prepare("INSERT INTO roles (user_id, role, granted_at) VALUES (?, 'super_admin', ?)").run(aliceId, now);
    db.prepare("INSERT INTO roles (user_id, role, granted_at) VALUES (?, 'payroll', ?)").run(aliceId, now);
    db.prepare(`INSERT INTO expenses (id, user_id, date, category, amount, payment_method, merchant, business_purpose, created_at, updated_at)
      VALUES (?, ?, '2026-10-01', 'supplies', 1000, 'personal_card', 'Old merchant', 'Synthetic purpose', ?, ?)`)
      .run(bobExpenseId, bobId, now, now);
    adminRepairRecord(getUser(db, aliceId)!, {
      type: "expense",
      id: bobExpenseId,
      reason: "Synthetic correction",
      patch: { merchant: "Corrected synthetic merchant" },
    });
    expect((db.prepare("SELECT merchant FROM expenses WHERE id = ?").get(bobExpenseId) as { merchant: string }).merchant).toBe("Corrected synthetic merchant");
    adminRepairRecord(getUser(db, aliceId)!, {
      type: "expense",
      id: bobExpenseId,
      reason: "Synthetic optional-field correction",
      patch: { projectOrClient: null },
    });
    expect((db.prepare("SELECT project_or_client FROM expenses WHERE id = ?").get(bobExpenseId) as { project_or_client: string | null }).project_or_client).toBeNull();
    expect(db.prepare("SELECT action, reason FROM record_history WHERE record_id = ? ORDER BY created_at DESC LIMIT 1").get(bobExpenseId)).toEqual({ action: "admin_repair", reason: "Synthetic optional-field correction" });
  });

  it("rejects unsupported BT Auth endpoint schemes in production", async () => {
    const previousBase = process.env.BT_AUTH_BASE_URL;
    const previousNodeEnv = process.env.NODE_ENV;
    Reflect.set(process.env, "NODE_ENV", "production");
    try {
      for (const base of ["ftp://synthetic-auth.example.test", "file:///synthetic-auth", "data:text/plain,synthetic"]) {
        process.env.BT_AUTH_BASE_URL = base;
        await expect(authenticateWithBtAuth("synthetic-user", syntheticPassword))
          .rejects.toMatchObject({ code: "BT_AUTH_CONFIGURATION_INVALID" });
      }
    } finally {
      if (previousBase === undefined) delete process.env.BT_AUTH_BASE_URL;
      else process.env.BT_AUTH_BASE_URL = previousBase;
      if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
      else Reflect.set(process.env, "NODE_ENV", previousNodeEnv);
    }
  });

  it("preserves BT Auth disabled, locked, and rate-limited login responses", async () => {
    const names = ["BT_AUTH_BASE_URL", "APP_PUBLIC_ORIGIN", "NODE_ENV"];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.BT_AUTH_BASE_URL = "http://synthetic-auth.example.test";
    process.env.APP_PUBLIC_ORIGIN = "http://localhost";
    Reflect.set(process.env, "NODE_ENV", "test");
    const cases = [
      { upstream: 401, app: 401 },
      { upstream: 403, app: 403 },
      { upstream: 423, app: 423 },
      { upstream: 429, app: 429 },
      { upstream: 502, app: 503 },
    ];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const { upstream, app } of cases) {
        vi.stubGlobal("fetch", async () => new Response(null, { status: upstream }));
        const response = await login(new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { origin: "http://localhost", "content-type": "application/json" },
          body: JSON.stringify({ username: "synthetic-user", password: syntheticPassword }),
        }));
        expect(response.status).toBe(app);
        if (upstream === 502) {
          expect(await response.json()).toEqual({
            error: "BT Auth could not complete sign-in.",
            code: "BT_AUTH_UPSTREAM_UNEXPECTED_STATUS",
          });
          expect(warning).toHaveBeenCalledWith("BT_AUTH_LOGIN_FAILURE", { code: "BT_AUTH_UPSTREAM_UNEXPECTED_STATUS" });
        }
      }
    } finally {
      vi.unstubAllGlobals();
      warning.mockRestore();
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else if (name === "NODE_ENV") Reflect.set(process.env, name, value);
        else process.env[name] = value;
      }
    }
  });

  it("returns safe diagnostic codes for the post-login adapter stages", async () => {
    const names = ["BT_AUTH_BASE_URL", "BT_AUTH_JWKS_URL", "BT_AUTH_ISSUER", "APP_PUBLIC_ORIGIN", "NODE_ENV"];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const base = "http://synthetic-auth.example.test";
    const jwksUrl = `${base}/.well-known/jwks.json`;
    const loginUrl = `${base}/auth/local-login`;
    process.env.BT_AUTH_BASE_URL = base;
    process.env.BT_AUTH_JWKS_URL = jwksUrl;
    process.env.BT_AUTH_ISSUER = "https://synthetic-issuer.example.test";
    process.env.APP_PUBLIC_ORIGIN = "http://localhost";
    Reflect.set(process.env, "NODE_ENV", "test");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases = [
      { name: "missing session cookie", code: "BT_AUTH_SESSION_COOKIE_MISSING" },
      { name: "JWKS HTTP failure", code: "BT_AUTH_JWKS_FETCH_FAILED" },
      { name: "JWKS parse failure", code: "BT_AUTH_JWKS_INVALID" },
    ];
    try {
      for (const scenario of cases) {
        (globalThis as typeof globalThis & { __btAuthJwks?: unknown }).__btAuthJwks = undefined;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === loginUrl) {
            const headers = new Headers({ "content-type": "application/json" });
            if (scenario.name !== "missing session cookie") {
              headers.set("set-cookie", "bt_session=synthetic-cookie; Domain=.biztechro.com; Path=/; HttpOnly");
            }
            return new Response(JSON.stringify({ status: "signed_in" }), { status: 200, headers });
          }
          if (url === jwksUrl && scenario.name === "JWKS HTTP failure") return new Response(null, { status: 503 });
          if (url === jwksUrl && scenario.name === "JWKS parse failure") return new Response("not-json", { status: 200 });
          return new Response(null, { status: 404 });
        });
        const response = await login(new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { origin: "http://localhost", "content-type": "application/json" },
          body: JSON.stringify({ username: "synthetic-user", password: syntheticPassword }),
        }));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "BT Auth could not complete sign-in.", code: scenario.code });
        expect(warning).toHaveBeenLastCalledWith("BT_AUTH_LOGIN_FAILURE", { code: scenario.code });
      }
      const logged = JSON.stringify(warning.mock.calls);
      expect(logged).not.toContain(syntheticPassword);
      expect(logged).not.toContain("synthetic-cookie");
    } finally {
      vi.unstubAllGlobals();
      warning.mockRestore();
      (globalThis as typeof globalThis & { __btAuthJwks?: unknown }).__btAuthJwks = undefined;
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else if (name === "NODE_ENV") Reflect.set(process.env, name, value);
        else process.env[name] = value;
      }
    }
  });

  it("verifies aud-less RS256 cookies and rejects invalid BT Auth claims", async () => {
    const names = ["BT_AUTH_BASE_URL", "BT_AUTH_JWKS_URL", "BT_AUTH_ISSUER", "BT_AUTH_AUDIENCE", "BT_AUTH_COOKIE_NAME", "BT_AUTH_USERNAME_FIELD", "BT_AUTH_PASSWORD_FIELD"];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const base = "http://synthetic-auth.example.test";
    const issuer = "https://synthetic-issuer.example.test";
    const jwksUrl = `${base}/.well-known/jwks.json`;
    const loginUrl = `${base}/auth/local-login`;
    const kid = "synthetic-rs256-key";
    const email = "synthetic-user@example.test";
    const upn = "synthetic-user";
    const issuedAt = Math.floor(Date.now() / 1000);
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { privateKey: unrelatedPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), use: "sig", alg: "RS256", kid };
    type TokenOptions = {
      algorithm?: "RS256" | "RS384";
      kid?: string | null;
      issuer?: string | null;
      subject?: string | null;
      email?: string | null;
      upn?: string | null;
      iat?: number | null;
      exp?: number | null;
      signer?: typeof privateKey;
    };
    const makeToken = async (options: TokenOptions = {}) => {
      const payload: Record<string, unknown> = {};
      const tokenEmail = options.email === undefined ? email : options.email;
      const tokenUpn = options.upn === undefined ? upn : options.upn;
      if (tokenEmail !== null) payload.email = tokenEmail;
      if (tokenUpn !== null) payload.upn = tokenUpn;
      const header = {
        alg: options.algorithm ?? "RS256",
        ...(options.kid === null ? {} : { kid: options.kid ?? kid }),
      };
      const token = new SignJWT(payload).setProtectedHeader(header);
      const tokenIssuer = options.issuer === undefined ? issuer : options.issuer;
      const subject = options.subject === undefined ? "synthetic-subject" : options.subject;
      const tokenIat = options.iat === undefined ? issuedAt : options.iat;
      const exp = options.exp === undefined ? issuedAt + 300 : options.exp;
      if (tokenIssuer !== null) token.setIssuer(tokenIssuer);
      if (subject !== null) token.setSubject(subject);
      if (tokenIat !== null) token.setIssuedAt(tokenIat);
      if (exp !== null) token.setExpirationTime(exp);
      return token.sign(options.signer ?? privateKey);
    };
    const invalidTokens: Array<{ token: string; code?: string }> = [
      { token: await makeToken({ issuer: "https://wrong-issuer.example.test" }), code: "BT_AUTH_ISSUER_MISMATCH" },
      { token: await makeToken({ subject: null }), code: "BT_AUTH_REQUIRED_CLAIM_MISSING" },
      { token: await makeToken({ email: null }), code: "BT_AUTH_REQUIRED_CLAIM_MISSING" },
      { token: await makeToken({ upn: null }), code: "BT_AUTH_REQUIRED_CLAIM_MISSING" },
      { token: await makeToken({ algorithm: "RS384" }), code: "BT_AUTH_TOKEN_INVALID" },
      { token: await makeToken({ kid: null }) },
      { token: await makeToken({ signer: unrelatedPrivateKey }), code: "BT_AUTH_SIGNATURE_OR_KEY_MISMATCH" },
      { token: await makeToken({ iat: issuedAt - 600, exp: issuedAt - 1 }), code: "BT_AUTH_TOKEN_EXPIRED" },
      { token: await makeToken({ iat: issuedAt + 120, exp: issuedAt + 60 }), code: "BT_AUTH_TOKEN_LIFETIME_INVALID" },
      { token: await makeToken({ iat: null }), code: "BT_AUTH_REQUIRED_CLAIM_MISSING" },
      { token: await makeToken({ exp: null }), code: "BT_AUTH_REQUIRED_CLAIM_MISSING" },
    ];
    let cookieToken = await makeToken();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    process.env.BT_AUTH_BASE_URL = base;
    process.env.BT_AUTH_JWKS_URL = jwksUrl;
    process.env.BT_AUTH_ISSUER = issuer;
    delete process.env.BT_AUTH_AUDIENCE;
    delete process.env.BT_AUTH_USERNAME_FIELD;
    delete process.env.BT_AUTH_PASSWORD_FIELD;
    delete process.env.BT_AUTH_COOKIE_NAME;
    (globalThis as typeof globalThis & { __btAuthJwks?: unknown }).__btAuthJwks = undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === jwksUrl) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === loginUrl) {
        return new Response(JSON.stringify({ status: "signed_in", username: upn }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": `bt_session=${encodeURIComponent(cookieToken)}; Domain=.biztechro.com; Path=/; HttpOnly; SameSite=Lax`,
          },
        });
      }
      return new Response(null, { status: 404 });
    });
    try {
      await expect(authenticateWithBtAuth(upn, syntheticPassword)).resolves.toMatchObject({
        issuer,
        subject: "synthetic-subject",
        displayName: upn,
        email,
      });
      const loginCall = calls.find((call) => call.url === loginUrl);
      expect(loginCall?.init?.method).toBe("POST");
      expect(JSON.parse(String(loginCall?.init?.body))).toEqual({ username: upn, password: syntheticPassword });
      expect(calls.slice(0, 2).map((call) => call.url)).toEqual([loginUrl, jwksUrl]);
      for (const invalidToken of invalidTokens) {
        cookieToken = invalidToken.token;
        (globalThis as typeof globalThis & { __btAuthJwks?: unknown }).__btAuthJwks = undefined;
        if (invalidToken.code) {
          await expect(authenticateWithBtAuth(upn, syntheticPassword)).rejects.toMatchObject({ code: invalidToken.code });
        } else {
          await expect(authenticateWithBtAuth(upn, syntheticPassword)).rejects.toBeInstanceOf(BtAuthIntegrationError);
        }
      }

      cookieToken = await makeToken({ issuer: "https://wrong-issuer.example.test" });
      (globalThis as typeof globalThis & { __btAuthJwks?: unknown }).__btAuthJwks = undefined;
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const routeResponse = await login(new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ username: upn, password: syntheticPassword }),
      }));
      expect(routeResponse.status).toBe(503);
      expect(await routeResponse.json()).toEqual({
        error: "BT Auth could not complete sign-in.",
        code: "BT_AUTH_ISSUER_MISMATCH",
      });
      expect(warning).toHaveBeenCalledWith("BT_AUTH_LOGIN_FAILURE", { code: "BT_AUTH_ISSUER_MISMATCH" });
      expect(JSON.stringify(warning.mock.calls)).not.toContain(cookieToken);
      warning.mockRestore();
    } finally {
      vi.unstubAllGlobals();
      (globalThis as typeof globalThis & { __btAuthJwks?: unknown }).__btAuthJwks = undefined;
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
  it("rolls back a payroll status change if its audit event cannot be written", async () => {
    await addActiveEmployee(aliceId, "Synthetic Payroll", "payroll-subject");
    db.prepare("INSERT INTO roles (user_id, role, granted_at) VALUES (?, 'payroll', ?)").run(aliceId, now);
    db.prepare(`INSERT INTO expenses (id, user_id, date, category, amount, payment_method, merchant, business_purpose, created_at, updated_at)
      VALUES (?, ?, '2026-10-01', 'supplies', 1000, 'personal_card', 'Synthetic Shop', 'Synthetic expense', ?, ?)`)
      .run(bobExpenseId, aliceId, now, now);
    db.exec("CREATE TRIGGER fail_audit_event BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;");

    expect(() => transitionPayrollRecord(getUser(db, aliceId)!, { type: "expense", id: bobExpenseId, action: "process" })).toThrow("synthetic audit failure");
    expect((db.prepare("SELECT status FROM expenses WHERE id = ?").get(bobExpenseId) as { status: string }).status).toBe("Submitted");
    expect(db.prepare("SELECT COUNT(*) AS count FROM record_history WHERE record_id = ?").get(bobExpenseId)).toEqual({ count: 0 });
  });
});
