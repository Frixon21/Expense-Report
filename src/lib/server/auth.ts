import { randomBytes, randomUUID } from "node:crypto";
import {
  createLocalJWKSet,
  calculateJwkThumbprint,
  errors as joseErrors,
  jwtVerify,
  SignJWT,
  type JSONWebKeySet,
} from "jose";
import { database, getUser, recordAudit, type AppUser, withTransaction } from "./db";

export const SESSION_COOKIE = "expense_report_session";
const SESSION_HOURS = 8;
const KEY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_SIGNING_KEY_STALENESS_MS = 15 * 60 * 1000;

export const BT_AUTH_DIAGNOSTIC_CODES = [
  "BT_AUTH_CONFIGURATION_INVALID",
  "BT_AUTH_IDENTITY_CONFLICT",
  "BT_AUTH_UPSTREAM_UNREACHABLE",
  "BT_AUTH_UPSTREAM_UNEXPECTED_STATUS",
  "BT_AUTH_SESSION_COOKIE_MISSING",
  "BT_AUTH_JWKS_FETCH_FAILED",
  "BT_AUTH_JWKS_INVALID",
  "BT_AUTH_SIGNATURE_OR_KEY_MISMATCH",
  "BT_AUTH_ISSUER_MISMATCH",
  "BT_AUTH_REQUIRED_CLAIM_MISSING",
  "BT_AUTH_REQUIRED_CLAIM_INVALID",
  "BT_AUTH_TOKEN_EXPIRED",
  "BT_AUTH_TOKEN_LIFETIME_INVALID",
  "BT_AUTH_SIGNING_KEY_ID_MISSING",
  "BT_AUTH_TOKEN_INVALID",
  "BT_AUTH_ACCOUNT_REGISTRATION_FAILED",
  "BT_AUTH_APP_SESSION_FAILED",
  "BT_AUTH_UNEXPECTED_FAILURE",
] as const;

export type BtAuthDiagnosticCode = (typeof BT_AUTH_DIAGNOSTIC_CODES)[number];

export class BtAuthIntegrationError extends Error {
  constructor(readonly code: BtAuthDiagnosticCode) {
    super(code);
    this.name = "BtAuthIntegrationError";
  }
}

export class LoginRejectedError extends Error {}
export class LoginForbiddenError extends Error {}
export class LoginLockedError extends Error {}
export class LoginRateLimitedError extends Error {}

type VerifiedIdentity = {
  issuer: string;
  subject: string;
  displayName: string;
  email: string | null;
  sessionProof?: ProviderSessionProof;
};
export type ProviderSessionProof = { expiresAt: number; keyId: string; keyThumbprint: string; issuer: string; subject: string };
// Direct synthetic sessions are available only to in-memory test fixtures.
const syntheticSessionIds = new Set<string>();
type TestAuthenticator = (username: string, password: string) => Promise<VerifiedIdentity>;

type CachedJwks = {
  value: JSONWebKeySet;
  refreshedAt: number;
  localKeySet: ReturnType<typeof createLocalJWKSet>;
};

type JwksRefreshResult = {
  jwks: CachedJwks;
  refreshFailure?: BtAuthDiagnosticCode;
};

type AuthGlobal = typeof globalThis & {
  __expenseReportSessionKey?: Uint8Array;
  __btAuthJwks?: CachedJwks;
  __btAuthJwksRefresh?: Promise<JwksRefreshResult>;
};

const authGlobal = globalThis as AuthGlobal;
let testAuthenticator: TestAuthenticator | null = null;

export function setTestAuthenticator(authenticator: TestAuthenticator | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("A synthetic authenticator can only be selected in test mode.");
  testAuthenticator = authenticator;
}

function sessionKey() {
  if (process.env.AUTH_SESSION_SECRET) {
    const secret = Buffer.from(process.env.AUTH_SESSION_SECRET, "utf8");
    if (secret.byteLength < 32) throw new Error("AUTH_SESSION_SECRET must be at least 32 bytes.");
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SESSION_SECRET must be configured in production.");
  }
  authGlobal.__expenseReportSessionKey ??= randomBytes(32);
  return authGlobal.__expenseReportSessionKey;
}

export function requestUsesHttpTransport(request: Request) {
  return new URL(request.url).protocol === "http:";
}

export function requestHasSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const expected = process.env.APP_PUBLIC_ORIGIN ?? new URL(request.url).origin;
  try {
    return new URL(origin).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const item of cookie.split(";")) {
    const index = item.indexOf("=");
    if (index < 0 || item.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

// An explicit subject-list or whole-realm trust decision; never infer continuity from email.
function legacyIssuerForSubject(subject: string): string | null {
  const legacy = process.env.BT_AUTH_LEGACY_ISSUER;
  const subjects = process.env.BT_AUTH_LEGACY_SUBJECTS;
  const realmConfirmed = process.env.BT_AUTH_LEGACY_REALM_CONFIRMED;
  if (legacy === undefined && subjects === undefined && realmConfirmed === undefined) return null;
  const current = process.env.BT_AUTH_ISSUER;
  if (!legacy || !current || legacy === current || legacy !== legacy.trim()) throw new BtAuthIntegrationError("BT_AUTH_CONFIGURATION_INVALID");
  configuredUrl(legacy, "BT_AUTH_LEGACY_ISSUER");
  if (realmConfirmed !== undefined) {
    // This trusts continuity of the entire subject namespace, not just known accounts.
    // Reject ambiguous mode selection and truthy spellings rather than broadening silently.
    if (realmConfirmed !== "true" || subjects !== undefined) throw new BtAuthIntegrationError("BT_AUTH_CONFIGURATION_INVALID");
    return legacy;
  }
  let approved: unknown;
  try { approved = JSON.parse(subjects ?? ""); } catch { throw new BtAuthIntegrationError("BT_AUTH_CONFIGURATION_INVALID"); }
  if (!Array.isArray(approved) || approved.length === 0 || approved.some((value) => typeof value !== "string" || !value.trim() || value !== value.trim() || value === "*")) throw new BtAuthIntegrationError("BT_AUTH_CONFIGURATION_INVALID");
  return approved.includes(subject) ? legacy : null;
}

function providerMatchesUser(issuer: string, subject: string, user: AppUser) {
  if (subject !== user.subject) return false;
  const current = process.env.BT_AUTH_ISSUER;
  const legacy = legacyIssuerForSubject(subject);
  if (issuer !== current && issuer !== legacy) return false;
  return issuer === user.issuer || (legacy !== null && issuer === current && user.issuer === legacy);
}

function aliasedUser(issuer: string, subject: string, email: string | null): AppUser | null {
  const legacy = legacyIssuerForSubject(subject);
  if (!legacy || issuer !== process.env.BT_AUTH_ISSUER) return null;
  const db = database();
  const original = db.prepare("SELECT id FROM users WHERE issuer = ? AND subject = ?").get(legacy, subject) as { id: string } | undefined;
  if (!original) return null;
  const user = getUser(db, original.id)!;
  if (!email || !user.email || email.toLowerCase() !== user.email.toLowerCase()) throw new BtAuthIntegrationError("BT_AUTH_IDENTITY_CONFLICT");
  const duplicate = db.prepare("SELECT id FROM users WHERE issuer = ? AND subject = ?").get(issuer, subject) as { id: string } | undefined;
  if (duplicate) {
    const candidate = getUser(db, duplicate.id)!;
    if (candidate.accessStatus !== "pending" || candidate.roles.length || !candidate.email || candidate.email.toLowerCase() !== email.toLowerCase()) throw new BtAuthIntegrationError("BT_AUTH_IDENTITY_CONFLICT");
    // Keep pending duplicates and their audit/access-request history intact. Never merge data.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    for (const { name } of tables) {
      if (["sessions", "access_requests", "audit_events"].includes(name)) continue;
      const references = db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as { table: string; from: string }[];
      for (const reference of references) {
        if (reference.table === "users" && db.prepare(`SELECT 1 FROM ${quote(name)} WHERE ${quote(reference.from)} = ? LIMIT 1`).get(candidate.id)) throw new BtAuthIntegrationError("BT_AUTH_IDENTITY_CONFLICT");
      }
    }
    if (db.prepare("SELECT 1 FROM access_requests WHERE reviewed_by = ? OR (user_id = ? AND status != 'pending') LIMIT 1").get(candidate.id, candidate.id)) throw new BtAuthIntegrationError("BT_AUTH_IDENTITY_CONFLICT");
    if (db.prepare("SELECT 1 FROM audit_events WHERE actor_id = ? AND event_type NOT IN ('access_request_created', 'session_created', 'logout') LIMIT 1").get(candidate.id)) throw new BtAuthIntegrationError("BT_AUTH_IDENTITY_CONFLICT");
  }
  return user;
}

export async function createAppSession(userId: string, proof?: ProviderSessionProof) {
  const db = database();
  if (!proof && process.env.NODE_ENV !== "test") throw new Error("A verified provider session is required.");
  const user = getUser(db, userId);
  if (proof && (!user || !providerMatchesUser(proof.issuer, proof.subject, user) || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= Date.now() || !proof.keyId || !/^[A-Za-z0-9_-]{43}$/.test(proof.keyThumbprint))) throw new Error("Invalid provider session proof.");
  const id = randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(Math.min(createdAt.getTime() + SESSION_HOURS * 60 * 60 * 1000, proof?.expiresAt ?? Infinity));
  withTransaction(db, () => {
    db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, provider_expires_at, provider_key_id, provider_key_thumbprint, provider_issuer, provider_subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, createdAt.toISOString(), expiresAt.getTime(), proof?.expiresAt ?? null, proof?.keyId ?? null, proof?.keyThumbprint ?? null, proof?.issuer ?? null, proof?.subject ?? null);
    recordAudit(db, userId, "session_created");
  });
  if (!proof && process.env.NODE_ENV === "test") syntheticSessionIds.add(id);
  const token = await new SignJWT({ sid: id })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("biztech-expense-report")
    .setAudience("biztech-expense-report-app")
    .setIssuedAt(Math.floor(createdAt.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(sessionKey());
  return { id, token, expiresAt };
}

export function appSessionCookie(token: string, _request: Request, clear = false, expiresAt?: Date) {
  const parts = [
    `${SESSION_COOKIE}=${clear ? "" : encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  const maxAge = expiresAt ? Math.max(0, Math.min(SESSION_HOURS * 60 * 60, Math.floor((expiresAt.getTime() - Date.now()) / 1000))) : SESSION_HOURS * 60 * 60;
  parts.push(clear ? "Max-Age=0" : `Max-Age=${maxAge}`);
  return parts.join("; ");
}

export async function currentUser(request: Request, allowPending = false): Promise<AppUser | null> {
  if (!requestUsesHttpTransport(request)) return null;
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionKey(), {
      issuer: "biztech-expense-report",
      audience: "biztech-expense-report-app",
    });
    if (typeof payload.sid !== "string") return null;
    const row = database().prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?")
      .get(payload.sid, Date.now()) as { user_id: string; expires_at: number; provider_expires_at: number | null; provider_key_id: string | null; provider_key_thumbprint: string | null; provider_issuer: string | null; provider_subject: string | null } | undefined;
    if (!row) return null;
    let user = getUser(database(), row.user_id);
    if (!user) return null;
    if (!(process.env.NODE_ENV === "test" && syntheticSessionIds.has(payload.sid))) {
      if (!row.provider_expires_at || row.provider_expires_at <= Date.now() || !row.provider_issuer || !row.provider_subject || !providerMatchesUser(row.provider_issuer, row.provider_subject, user) || !row.provider_key_id || !row.provider_key_thumbprint) return null;
      const { jwks } = await refreshJwks();
      const eligible = jwks.value.keys.filter((key) => key.kid === row.provider_key_id && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig") && (!key.key_ops || key.key_ops.includes("verify")));
      const fingerprints = await Promise.all(eligible.map((key) => calculateJwkThumbprint(key)));
      if (!fingerprints.includes(row.provider_key_thumbprint) || Date.now() >= row.provider_expires_at || Date.now() >= row.expires_at || Date.now() - jwks.refreshedAt > MAX_SIGNING_KEY_STALENESS_MS) return null;
    }
    user = aliasedUser(user.issuer, user.subject, user.email) ?? user;
    if (!allowPending && user.accessStatus !== "active") return null;
    if (user.accessStatus === "disabled") return null;
    return user;
  } catch {
    return null;
  }
}

export async function deleteAppSession(request: Request, user: AppUser | null = null) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return;
  try {
    const { payload } = await jwtVerify(token, sessionKey(), {
      issuer: "biztech-expense-report",
      audience: "biztech-expense-report-app",
    });
    if (typeof payload.sid === "string") {
      withTransaction(database(), () => {
        database().prepare("DELETE FROM sessions WHERE id = ?").run(payload.sid as string);
        syntheticSessionIds.delete(payload.sid as string);
        if (user) recordAudit(database(), user.id, "logout");
      });
    }
  } catch {
    // Invalid or expired cookies are still cleared in the response.
  }
}

function configuredUrl(value: string | undefined, label: string) {
  if (!value) throw new BtAuthIntegrationError("BT_AUTH_CONFIGURATION_INVALID");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BtAuthIntegrationError("BT_AUTH_CONFIGURATION_INVALID");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BtAuthIntegrationError("BT_AUTH_CONFIGURATION_INVALID");
  return url;
}

async function refreshJwks(force = false): Promise<JwksRefreshResult> {
  if (authGlobal.__btAuthJwksRefresh) return authGlobal.__btAuthJwksRefresh;
  const pending = fetchJwks(force);
  authGlobal.__btAuthJwksRefresh = pending;
  try { return await pending; }
  finally { authGlobal.__btAuthJwksRefresh = undefined; }
}

async function fetchJwks(force = false): Promise<JwksRefreshResult> {
  const now = Date.now();
  const cached = authGlobal.__btAuthJwks;
  if (!force && cached && now - cached.refreshedAt < KEY_REFRESH_INTERVAL_MS) return { jwks: cached };
  try {
    const url = configuredUrl(process.env.BT_AUTH_JWKS_URL, "BT_AUTH_JWKS_URL");
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(8000) });
    } catch {
      throw new BtAuthIntegrationError("BT_AUTH_JWKS_FETCH_FAILED");
    }
    if (!response.ok) throw new BtAuthIntegrationError("BT_AUTH_JWKS_FETCH_FAILED");
    let value: JSONWebKeySet;
    try {
      value = (await response.json()) as JSONWebKeySet;
    } catch {
      throw new BtAuthIntegrationError("BT_AUTH_JWKS_INVALID");
    }
    if (!value || !Array.isArray(value.keys) || value.keys.length === 0) {
      throw new BtAuthIntegrationError("BT_AUTH_JWKS_INVALID");
    }
    let localKeySet: CachedJwks["localKeySet"];
    try {
      localKeySet = createLocalJWKSet(value);
    } catch {
      throw new BtAuthIntegrationError("BT_AUTH_JWKS_INVALID");
    }
    const fresh: CachedJwks = { value, refreshedAt: Date.now(), localKeySet };
    authGlobal.__btAuthJwks = fresh;
    return { jwks: fresh };
  } catch (error) {
    if (!cached || Date.now() - cached.refreshedAt > MAX_SIGNING_KEY_STALENESS_MS) {
      if (error instanceof BtAuthIntegrationError) throw error;
      throw new BtAuthIntegrationError("BT_AUTH_JWKS_INVALID");
    }
    return {
      jwks: cached,
      refreshFailure: error instanceof BtAuthIntegrationError ? error.code : "BT_AUTH_JWKS_INVALID",
    };
  }
}

function setCookieHeaders(headers: Headers) {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (extended.getSetCookie) return extended.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? combined.split(/,(?=\s*[^;,]+=)/g) : [];
}

function cookieFromHeader(headers: Headers, name: string) {
  const prefix = `${name}=`;
  for (const header of setCookieHeaders(headers)) {
    const pair = header.split(";", 1)[0]?.trim();
    if (pair?.startsWith(prefix)) {
      try {
        return decodeURIComponent(pair.slice(prefix.length));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function verifiedBtIdentity(cookie: string): Promise<VerifiedIdentity> {
  const issuer = process.env.BT_AUTH_ISSUER;
  if (!issuer?.trim()) throw new BtAuthIntegrationError("BT_AUTH_CONFIGURATION_INVALID");
  const verificationOptions = {
    algorithms: ["RS256"],
    issuer,
    requiredClaims: ["sub", "email", "upn", "iat", "exp", "iss"],
  };
  const keys = await refreshJwks();
  let verifiedKeys = keys.jwks;
  let result;
  try {
    result = await jwtVerify(cookie, keys.jwks.localKeySet, verificationOptions);
  } catch (error) {
    const initialCode = verificationFailureCode(error);
    if (initialCode !== "BT_AUTH_SIGNATURE_OR_KEY_MISMATCH") {
      throw new BtAuthIntegrationError(initialCode);
    }
    const refreshed = await refreshJwks(true);
    try {
      result = await jwtVerify(cookie, refreshed.jwks.localKeySet, verificationOptions);
      verifiedKeys = refreshed.jwks;
    } catch (retryError) {
      throw new BtAuthIntegrationError(refreshed.refreshFailure ?? verificationFailureCode(retryError));
    }
  }
  const { payload, protectedHeader } = result;
  if (typeof protectedHeader.kid !== "string" || protectedHeader.kid.length === 0) {
    throw new BtAuthIntegrationError("BT_AUTH_SIGNING_KEY_ID_MISSING");
  }
  for (const claim of ["sub", "email", "upn"] as const) {
    if (payload[claim] === undefined || payload[claim] === null) {
      throw new BtAuthIntegrationError("BT_AUTH_REQUIRED_CLAIM_MISSING");
    }
    if (typeof payload[claim] !== "string" || !payload[claim].trim()) {
      throw new BtAuthIntegrationError("BT_AUTH_REQUIRED_CLAIM_INVALID");
    }
  }
  if (payload.iat === undefined || payload.exp === undefined) {
    throw new BtAuthIntegrationError("BT_AUTH_REQUIRED_CLAIM_MISSING");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new BtAuthIntegrationError("BT_AUTH_REQUIRED_CLAIM_INVALID");
  }
  if (payload.exp <= payload.iat) throw new BtAuthIntegrationError("BT_AUTH_TOKEN_LIFETIME_INVALID");
  if (payload.iss !== issuer) throw new BtAuthIntegrationError("BT_AUTH_ISSUER_MISMATCH");
  const subject = payload.sub as string;
  const email = payload.email as string;
  const upn = payload.upn as string;
  const displayName =
    (typeof payload.name === "string" && payload.name) ||
    (typeof payload.preferred_username === "string" && payload.preferred_username) ||
    upn ||
    email ||
    subject;
  const signingKey = verifiedKeys.value.keys.find((key) => key.kid === protectedHeader.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig") && (!key.key_ops || key.key_ops.includes("verify")));
  if (!signingKey) throw new BtAuthIntegrationError("BT_AUTH_SIGNATURE_OR_KEY_MISMATCH");
  return { issuer, subject, email, displayName, sessionProof: { expiresAt: payload.exp * 1000, keyId: protectedHeader.kid, keyThumbprint: await calculateJwkThumbprint(signingKey), issuer, subject } };
}

const requiredBtClaims = ["iss", "sub", "email", "upn", "iat", "exp"] as const;

function verificationFailureCode(error: unknown): BtAuthDiagnosticCode {
  if (error instanceof joseErrors.JWTExpired) return "BT_AUTH_TOKEN_EXPIRED";
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === "iss" && error.reason !== "missing") return "BT_AUTH_ISSUER_MISMATCH";
    if (requiredBtClaims.includes(error.claim as (typeof requiredBtClaims)[number])) {
      return error.reason === "missing" ? "BT_AUTH_REQUIRED_CLAIM_MISSING" : "BT_AUTH_REQUIRED_CLAIM_INVALID";
    }
    return "BT_AUTH_TOKEN_INVALID";
  }
  if (
    error instanceof joseErrors.JWKSNoMatchingKey ||
    error instanceof joseErrors.JWKSMultipleMatchingKeys ||
    error instanceof joseErrors.JWSSignatureVerificationFailed
  ) {
    return "BT_AUTH_SIGNATURE_OR_KEY_MISMATCH";
  }
  return "BT_AUTH_TOKEN_INVALID";
}
export async function authenticateWithBtAuth(username: string, password: string): Promise<VerifiedIdentity> {
  if (process.env.NODE_ENV === "test" && testAuthenticator) return testAuthenticator(username, password);
  const base = configuredUrl(process.env.BT_AUTH_BASE_URL, "BT_AUTH_BASE_URL");
  const endpoint = new URL("/auth/local-login", base);
  const cookieName = process.env.BT_AUTH_COOKIE_NAME || "bt_session";
  const usernameField = process.env.BT_AUTH_USERNAME_FIELD || "username";
  const passwordField = process.env.BT_AUTH_PASSWORD_FIELD || "password";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(usernameField) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(passwordField)) {
    throw new BtAuthIntegrationError("BT_AUTH_CONFIGURATION_INVALID");
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ [usernameField]: username, [passwordField]: password }),
    });
  } catch {
    throw new BtAuthIntegrationError("BT_AUTH_UPSTREAM_UNREACHABLE");
  }
  if (response.status === 401) throw new LoginRejectedError("BT Auth did not accept the supplied credentials.");
  if (response.status === 403) throw new LoginForbiddenError("BT Auth did not permit this sign-in.");
  if (response.status === 423) throw new LoginLockedError("BT Auth temporarily locked this account.");
  if (response.status === 429) throw new LoginRateLimitedError("BT Auth is limiting sign-in attempts.");
  if (!response.ok) throw new BtAuthIntegrationError("BT_AUTH_UPSTREAM_UNEXPECTED_STATUS");
  const signedCookie = cookieFromHeader(response.headers, cookieName);
  if (!signedCookie) throw new BtAuthIntegrationError("BT_AUTH_SESSION_COOKIE_MISSING");
  return verifiedBtIdentity(signedCookie);
}

export function registerVerifiedIdentity(identity: VerifiedIdentity) {
  const db = database();
  const now = new Date().toISOString();
  return withTransaction(db, () => {
    const alias = aliasedUser(identity.issuer, identity.subject, identity.email);
    const existing = alias ? { id: alias.id, access_status: alias.accessStatus } : db.prepare("SELECT id, access_status FROM users WHERE issuer = ? AND subject = ?")
      .get(identity.issuer, identity.subject) as { id: string; access_status: AppUser["accessStatus"] } | undefined;
    let userId = existing?.id;
    if (!userId) {
      userId = randomUUID();
      db.prepare(`INSERT INTO users (id, issuer, subject, display_name, email, access_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(userId, identity.issuer, identity.subject, identity.displayName, identity.email, now, now);
      db.prepare("INSERT INTO access_requests (id, user_id, status, requested_at) VALUES (?, ?, 'pending', ?)")
        .run(randomUUID(), userId, now);
      recordAudit(db, userId, "access_request_created", userId);
    } else {
      db.prepare("UPDATE users SET display_name = ?, email = ?, updated_at = ? WHERE id = ?")
        .run(identity.displayName, identity.email, now, userId);
      if (existing?.access_status === "pending") {
        const open = db.prepare("SELECT id FROM access_requests WHERE user_id = ? AND status = 'pending'").get(userId);
        if (!open) {
          db.prepare("INSERT INTO access_requests (id, user_id, status, requested_at) VALUES (?, ?, 'pending', ?)")
            .run(randomUUID(), userId, now);
          recordAudit(db, userId, "access_request_created", userId);
        }
      }
    }
    if (alias) recordAudit(db, userId, "identity_issuer_alias_used", userId, { verifiedIssuer: identity.issuer, accountIssuer: alias.issuer, subject: identity.subject });
    return getUser(db, userId)!;
  });
}

export function appAuthStatus(user: AppUser | null) {
  if (!user) return { authenticated: false as const };
  return {
    authenticated: true as const,
    user: { id: user.id, displayName: user.displayName, email: user.email, accessStatus: user.accessStatus, roles: user.roles },
  };
}
