"use client";

import { useEffect, useRef, useState } from "react";
import { Route } from "lucide-react";
import ThemePicker from "@/components/theme-picker";
import ExpenseDashboard from "@/components/expense-dashboard";
import AdminWorkspace from "@/components/admin-workspace";
import PayrollWorkspace from "@/components/payroll-workspace";
import { Dashboard, ProfileSetup } from "@/components/mileage-app";
import type { Expense } from "@/lib/expense";
import type { TripPayrollMeta } from "@/lib/demo-types";
import type { MileageState, Profile } from "@/lib/model";
import type { Role } from "@/lib/server/db";
import { clearUserDrafts } from "@/components/form-memory";
import { clientJson } from "@/lib/client-json";

type AppUser = {
  id: string;
  displayName: string;
  email: string | null;
  accessStatus: "pending" | "active" | "disabled";
  roles: Role[];
};

type AppAuth = { authenticated: false } | { authenticated: true; user: AppUser };
type OwnHistory = Array<{ id: string; action: string; recordType: string; recordId: string; createdAt: string; fromStatus?: string | null; toStatus?: string | null; actorName: string; reason: string | null; details: unknown }>;
type ExpenseRecord = Expense & { status?: string; everProcessed?: boolean };
type Snapshot = { user: { id: string; displayName: string; email: string | null; roles: Role[] }; state: MileageState; expenses: ExpenseRecord[]; history: OwnHistory };
type View = "employee" | "payroll" | "admin";
type EmployeeModule = "mileage" | "expenses";

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Request failed.");
  return payload as T;
}

export default function SecureShell() {
  const [auth, setAuth] = useState<AppAuth | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [view, setView] = useState<View>("employee");
  const [module, setModule] = useState<EmployeeModule>("mileage");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [bootstrapEligibility, setBootstrapEligibility] = useState<"checking" | "available" | "unavailable">("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const setCurrentSnapshot = (next: Snapshot | null) => {
    snapshotRef.current = next;
    setSnapshot(next);
  };

  const refreshAuth = async (signal?: AbortSignal) => {
    const next = await clientJson<AppAuth>("/api/auth/me", signal);
    if (!next || typeof next.authenticated !== "boolean" || (next.authenticated && (!next.user || typeof next.user.id !== "string" || !Array.isArray(next.user.roles) || !["active", "pending", "disabled"].includes(next.user.accessStatus)))) throw new Error("The session service returned an invalid response. Please try again.");
    if (signal?.aborted) throw new DOMException("Request cancelled.", "AbortError");
    setAuth(next);
    if (next.authenticated && next.user.accessStatus === "active" && !next.user.roles.includes("employee") && next.user.roles.some((role) => role === "payroll" || role === "super_admin")) {
      setView(next.user.roles.includes("super_admin") ? "admin" : "payroll");
    }
    return next;
  };

  const loadSnapshot = async () => {
    const next = await clientJson<Snapshot>("/api/me");
    setCurrentSnapshot(next);
  };

  useEffect(() => {
    const controller = new AbortController();
    setSessionError("");
    void refreshAuth(controller.signal).catch((reason) => {
      if (!controller.signal.aborted) setSessionError(reason instanceof Error ? reason.message : "Could not check your session. Please try again.");
    });
    return () => controller.abort();
  }, [sessionAttempt]);

  useEffect(() => {
    if (!auth?.authenticated || auth.user.accessStatus !== "pending") {
      setBootstrapEligibility("unavailable");
      return;
    }
    setBootstrapEligibility("checking");
    void fetch("/api/admin/bootstrap/availability", { cache: "no-store" })
      .then((response) => readJson<{ available: boolean }>(response))
      .then((result) => setBootstrapEligibility(result.available ? "available" : "unavailable"))
      .catch(() => setBootstrapEligibility("unavailable"));
  }, [auth?.authenticated, auth?.authenticated ? auth.user.id : "", auth?.authenticated ? auth.user.accessStatus : ""]);

  useEffect(() => {
    if (!auth?.authenticated || auth.user.accessStatus !== "active" || !auth.user.roles.includes("employee") || view !== "employee") return;
    void loadSnapshot().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load your expense records."));
  }, [auth?.authenticated, auth?.authenticated ? auth.user.id : "", view]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const next = await readJson<{ user: AppUser }>(response);
      setPassword("");
      setAuth({ authenticated: true, user: next.user });
      if (next.user.roles.includes("employee")) await loadSnapshot();
      if (!next.user.roles.includes("employee")) setView(next.user.roles.includes("super_admin") ? "admin" : next.user.roles.includes("payroll") ? "payroll" : "employee");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign in.");
    } finally { setBusy(false); }
  };

  const logout = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      await readJson(response);
      if (auth?.authenticated) clearUserDrafts(auth.user.id);
      setCurrentSnapshot(null);
      setAuth({ authenticated: false });
      setPassword(""); setBootstrapToken(""); setView("employee");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign out.");
    } finally { setBusy(false); }
  };

  const bootstrap = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/bootstrap", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: bootstrapToken }),
      });
      await readJson(response);
      setBootstrapToken("");
      await refreshAuth();
      setView("admin");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not bootstrap the first admin.");
    } finally { setBusy(false); }
  };

  const saveSnapshot = (patch: { state?: MileageState; expenses?: ExpenseRecord[] }) => {
    const operation = saveQueue.current.then(async () => {
      const current = snapshotRef.current;
      if (!current) throw new Error("Your records are still loading. Try again.");
      const nextState = patch.state ?? current.state;
      const nextExpenses = patch.expenses ?? current.expenses;
      const removeReceiptIds = current.expenses
        .filter((expense) => expense.receiptFileName && !nextExpenses.find((next) => next.id === expense.id)?.receiptFileName)
        .map((expense) => expense.id);
      const response = await fetch("/api/me", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: nextState, expenses: nextExpenses, removeReceiptIds }),
      });
      const saved = await readJson<Omit<Snapshot, "user">>(response);
      const updated: Snapshot = { ...current, state: saved.state, expenses: saved.expenses, history: saved.history };
      setCurrentSnapshot(updated);
    });
    saveQueue.current = operation.catch(() => undefined);
    return operation;
  };

  const onMileageChange = async (state: MileageState) => saveSnapshot({ state });
  const onExpenseChange = async (expenses: Expense[]) => saveSnapshot({ expenses: expenses as ExpenseRecord[] });

  const downloadMileageReport = async (from: string, to: string) => {
    const response = await fetch("/api/reports/mileage", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? "Could not create the mileage PDF.");
    }
    return response.blob();
  };

  if (!auth) return <div className="loading-screen"><strong>Biztech Expense Report</strong>{sessionError ? <>
    <h1>Could not check your session</h1><p role="alert">{sessionError}</p>
    <button type="button" className="secondary" onClick={() => setSessionAttempt((value) => value + 1)}>Retry session check</button>
  </> : <p role="status">Checking your app session.</p>}</div>;
  if (!auth.authenticated) return <main className="setup-page"><div className="setup-wrap">
    <div className="setup-brand-row"><a className="brand" href="/" aria-label="Biztech Expense Report home"><span className="brand-icon"><Route size={22} /></span><span>Biztech<small>EXPENSE REPORT</small></span></a><ThemePicker /></div>
    <section className="setup-card"><p className="section-kicker">BT AUTH SIGN IN</p><h1>Sign in to Expense Report</h1><p>Use your existing Biztech credentials. Expense Report creates its own session.</p>
      <form onSubmit={(event) => void login(event)}>
        <label>BT Auth username<input required autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <label>Password<input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
      </form>
      <p className="storage-note">Your password is sent to the configured BT Auth service through the server. It is not saved in Expense Report.</p>
    </section>
  </div></main>;

  const user = auth.user;
  const isEmployee = user.roles.includes("employee");
  const isPayroll = user.roles.includes("payroll");
  const isAdmin = user.roles.includes("super_admin");

  if (user.accessStatus === "disabled") return <main className="setup-page"><div className="setup-wrap">
    <BrandHeader user={user} onLogout={logout} busy={busy} />
    <section className="setup-card"><p className="section-kicker">ACCESS DISABLED</p><h1>This account is disabled</h1><p>Contact a super admin if you believe this is an error.</p>{error && <p className="error" role="alert">{error}</p>}</section>
  </div></main>;

  if (user.accessStatus === "pending") return <main className="setup-page"><div className="setup-wrap">
    <BrandHeader user={user} onLogout={logout} busy={busy} />
    <section className="setup-card"><p className="section-kicker">ACCESS REQUESTED</p><h1>Waiting for Expense Report access</h1><p>Your BT Auth identity is verified. A super admin must approve your app access and any payroll or admin role.</p>
      {bootstrapEligibility === "available"
        ? <form onSubmit={(event) => void bootstrap(event)}><label>One-time first-admin bootstrap token<input type="password" autoComplete="off" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} /></label><button className="secondary" type="submit" disabled={busy || !bootstrapToken}>Bootstrap first admin</button></form>
        : <p role="status">{bootstrapEligibility === "checking" ? "Checking first-admin setup eligibility..." : "A super admin must approve your request. First-admin setup is unavailable."}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  </div></main>;

  return <div className="app-shell secure-app-shell">
    <header className="topbar secure-topbar">
      <a className="brand" href="/" aria-label="Biztech Expense Report home"><span className="brand-icon"><Route size={22} /></span><span>Biztech<small>EXPENSE REPORT</small></span></a>
      <div className="demo-controls"><ThemePicker />
        <span className="user-name">{user.displayName}<small>{user.email ?? "Verified BT Auth account"}</small></span>
        {isEmployee && <button type="button" aria-pressed={view === "employee"} className={view === "employee" ? "toggle active" : "toggle"} onClick={() => setView("employee")}>My records</button>}
        {isPayroll && <button type="button" aria-pressed={view === "payroll"} className={view === "payroll" ? "toggle active" : "toggle"} onClick={() => setView("payroll")}>Payroll</button>}
        {isAdmin && <button type="button" aria-pressed={view === "admin"} className={view === "admin" ? "toggle active" : "toggle"} onClick={() => setView("admin")}>Admin</button>}
        {view === "employee" && isEmployee && <div className="view-toggle employee-module-toggle" role="tablist" aria-label="Employee record type">
          <button type="button" role="tab" aria-selected={module === "mileage"} className={module === "mileage" ? "toggle active" : "toggle"} onClick={() => setModule("mileage")}>Mileage</button>
          <button type="button" role="tab" aria-selected={module === "expenses"} className={module === "expenses" ? "toggle active" : "toggle"} onClick={() => setModule("expenses")}>Expenses</button>
        </div>}
        <button type="button" className="secondary" onClick={() => void logout()} disabled={busy}>Sign out</button>
      </div>
    </header>
    {error && view !== "employee" && <p className="error global-message" role="alert">{error}</p>}
    {view === "employee" && isEmployee && (snapshot ? <>
      {!snapshot.state.profile ? <ProfileSetup embedded onSave={async (profile: Profile) => { await saveSnapshot({ state: { ...snapshot.state, profile } }); }} error={error} storageNote="Your records are stored on the shared Biztech server." historyContent={<HistoryPanel history={snapshot.history} snapshot={snapshot} />} /> : module === "mileage" ? <Dashboard embedded
        memoryUserId={user.id} key={`${user.id}-mileage`} state={snapshot.state} onChange={onMileageChange} storageError={error} storageLabel="Saved to Biztech" footerNote="Shared Biztech server storage | Supports recordkeeping, not tax advice" onReport={downloadMileageReport}
        historyContent={<HistoryPanel history={snapshot.history} snapshot={snapshot} />}
        payrollMeta={Object.fromEntries(snapshot.state.trips.map((trip) => {
          const row = trip as typeof trip & { status?: string; processedRateCentsPerMile?: number | null };
          return [trip.id, { processed: ["Processed", "Paid", "Voided"].includes(row.status ?? ""), paid: row.status === "Paid", processedRateCentsPerMile: row.processedRateCentsPerMile } satisfies TripPayrollMeta];
        }))}
      /> : <ExpenseDashboard
        memoryUserId={user.id} key={`${user.id}-expenses`} expenses={snapshot.expenses} onChange={onExpenseChange} storageError={error} storageLabel="Saved to Biztech" historyContent={<HistoryPanel history={snapshot.history} snapshot={snapshot} />}
        payrollMeta={Object.fromEntries(snapshot.expenses.map((expense) => [expense.id, { processed: ["Processed", "Paid", "Voided"].includes(expense.status ?? ""), paid: expense.status === "Paid" }]))}
      />}
    </> : <main className="workspace"><p>{error || "Loading your records..."}</p></main>)}
    {view === "payroll" && isPayroll && <PayrollWorkspace isAdmin={isAdmin} />}
    {view === "admin" && isAdmin && <AdminWorkspace canViewPayroll={isPayroll} />}
    {view === "employee" && !isEmployee && <main className="workspace"><section className="setup-card"><h1>No employee role assigned</h1><p>Your current roles do not include employee access. Ask a super admin to update your access.</p></section></main>}
    {view === "payroll" && !isPayroll && <main className="workspace"><p>Payroll access is required.</p></main>}
    {view === "admin" && !isAdmin && <main className="workspace"><p>Super admin access is required.</p></main>}
  </div>;
}

function BrandHeader({ user, onLogout, busy }: { user: AppUser; onLogout: () => void; busy: boolean }) {
  return <header className="topbar secure-topbar">
    <a className="brand" href="/" aria-label="Biztech Expense Report home"><span className="brand-icon"><Route size={22} /></span><span>Biztech<small>EXPENSE REPORT</small></span></a>
    <div className="demo-controls"><ThemePicker /><span className="user-name">{user.displayName}<small>{user.email ?? "Verified BT Auth account"}</small></span><button type="button" className="secondary" disabled={busy} onClick={() => void onLogout()}>Sign out</button></div>
  </header>;
}

function HistoryPanel({ history, snapshot }: { history: OwnHistory; snapshot: Snapshot }) {
  const names = new Map([...snapshot.expenses.map(item => [item.id, item.merchant] as const), ...snapshot.state.trips.map(item => [item.id, item.destination] as const)]);
  return <section className="panel own-history-panel" aria-label="Your record history"><div className="section-heading"><div><h2>Your record history</h2><p>Recorded status timeline: Submitted, Processed, Paid, reversals and voids.</p></div></div>
    {history.length ? <ul>{history.map((entry) => <li key={entry.id}>
      <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
      <span><strong>{entry.recordType === "trip" ? "Mileage" : entry.recordType} / {names.get(entry.recordId) ?? entry.recordId.slice(0, 8)}</strong> - {entry.action.replaceAll("_", " ")}{entry.toStatus ? `: ${entry.fromStatus ? entry.fromStatus + " to " : ""}${entry.toStatus}` : ""}</span>
      <span>By {entry.actorName}</span>
      {entry.reason && <span>Reason: {entry.reason}</span>}
    </li>)}</ul> : <p className="own-history-empty">No record history yet.</p>}
  </section>;
}
