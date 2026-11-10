"use client";
import { NotificationSettings } from "./notification-settings";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAdministrativeAuditEvent, presentAuditEvent, type AuditEvent } from "@/lib/audit-presentation";
import type { Role } from "@/lib/server/db";

type AdminData = {
  requests: Array<{ request_id: string; requested_at: string; user_id: string; display_name: string; email: string | null }>;
  users: Array<{ id: string; displayName: string; email: string | null; accessStatus: string; roles: Role[] }>;
};
type AuditPage = { events: AuditEvent[]; page: number; pageSize: number; total: number; totalPages: number };
type AuditFilters = { query: string; from: string; to: string; event: string; actor: string; account: string };
const emptyAuditFilters: AuditFilters = { query: "", from: "", to: "", event: "", actor: "", account: "" };

async function getJson<T>(response: Response) {
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Request failed.");
  return payload as T;
}

export default function AdminWorkspace({ canViewPayroll = false }: { canViewPayroll?: boolean }) {
  const [data, setData] = useState<AdminData | null>(null);
  const [error, setError] = useState("");
  const [audit, setAudit] = useState<AuditPage | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditFilters, setAuditFilters] = useState<AuditFilters>(emptyAuditFilters);
  const [appliedAuditFilters, setAppliedAuditFilters] = useState<AuditFilters>(emptyAuditFilters);
  const [grant, setGrant] = useState<Record<string, { payroll: boolean; admin: boolean }>>({});
  const [roleSelections, setRoleSelections] = useState<Record<string, Role[]>>({});
  const [busy, setBusy] = useState("");
  const roleSavePending = useRef(false);

  const loadAudit = async (filters: AuditFilters, page: number) => {
    setAuditBusy(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      for (const [key, value] of Object.entries(filters)) {
        if ((key !== "query" || canViewPayroll) && value.trim()) params.set(key === "query" ? "q" : key, value.trim());
      }
      const next = await fetch(`/api/admin/audit?${params.toString()}`, { cache: "no-store" }).then((response) => getJson<AuditPage>(response));
      setAudit({ ...next, events: next.events.map(event => presentAuditEvent(event, canViewPayroll)) });
      setAuditPage(next.page);
    } finally {
      setAuditBusy(false);
    }
  };

  const refresh = async () => {
    const [access, users] = await Promise.all([
      fetch("/api/admin/access", { cache: "no-store" }).then((response) => getJson<{ requests: AdminData["requests"] }>(response)),
      fetch("/api/admin/users", { cache: "no-store" }).then((response) => getJson<{ users: AdminData["users"] }>(response)),
    ]);
    setData({ requests: access.requests, users: users.users });
    await loadAudit(appliedAuditFilters, auditPage);
  };

  useEffect(() => {
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load access management."));
  }, [canViewPayroll]);

  const review = async (requestId: string, decision: "approve" | "deny") => {
    setBusy(requestId); setError("");
    try {
      const grants = grant[requestId] ?? { payroll: false, admin: false };
      const response = await fetch("/api/admin/access", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, decision, grantPayroll: grants.payroll, grantAdmin: grants.admin }),
      });
      await getJson(response); await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not review this request.");
    } finally { setBusy(""); }
  };

  const saveRoles = async (id: string) => {
    if (roleSavePending.current || busy) return;
    roleSavePending.current = true;
    setBusy(id); setError("");
    let reloading = false;
    try {
      const roles = roleSelections[id] ?? data?.users.find(account => account.id === id)?.roles;
      if (!roles) throw new Error("This account is no longer available. Reload and try again.");
      const response = await fetch("/api/admin/users/" + encodeURIComponent(id), {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ roles }),
      });
      await getJson(response);
      // A full reload rechecks the authenticated account's current server-backed roles.
      window.location.reload();
      reloading = true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update roles.");
    } finally {
      if (!reloading) { roleSavePending.current = false; setBusy(""); }
    }
  };

  const toggleStatus = async (id: string, accessStatus: "active" | "disabled") => {
    setBusy(id); setError("");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessStatus }),
      });
      await getJson(response); await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update account access.");
    } finally { setBusy(""); }
  };

  const flipRole = (id: string, role: Role, current: Role[]) => {
    const selected = roleSelections[id] ?? current;
    setRoleSelections((old) => ({ ...old, [id]: selected.includes(role) ? selected.filter((item) => item !== role) : [...selected, role] }));
  };

  const applyAuditFilters = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const next = { ...auditFilters };
    setAppliedAuditFilters(next);
    try { await loadAudit(next, 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not filter security history."); }
  };

  const clearAuditFilters = async () => {
    setError("");
    setAuditFilters(emptyAuditFilters);
    setAppliedAuditFilters(emptyAuditFilters);
    try { await loadAudit(emptyAuditFilters, 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not clear security history filters."); }
  };

  const goToAuditPage = async (page: number) => {
    setError("");
    try { await loadAudit(appliedAuditFilters, page); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load security history."); }
  };

  if (!data || !audit) return <main className="workspace admin-workspace"><p>{error || "Loading access management..."}</p></main>;

  return <main className="workspace admin-workspace">
    <div className="page-heading"><div><p className="section-kicker">ACCESS AND SECURITY</p><h1>Administration</h1><p>Review verified account requests, assign roles, and audit access changes.</p></div></div>
    {error && <p className="error global-message" role="alert">{error}</p>}

    <section className="panel admin-panel">
      <div className="section-heading"><div><h2>Pending app access</h2><p>Every approval grants employee access. Payroll and admin access are explicit choices.</p></div></div>
      {data.requests.length ? data.requests.map((request) => {
        const grants = grant[request.request_id] ?? { payroll: false, admin: false };
        return <article className="admin-request-row" key={request.request_id}>
          <div className="admin-person"><strong>{request.display_name}</strong><div className="admin-person-meta"><small>{request.email ?? "Verified BT Auth account"}</small><small>Requested {new Date(request.requested_at).toLocaleString()}</small></div></div>
          <div className="admin-option-list" role="group" aria-label={`Optional roles for ${request.display_name}`}>
            <label className="admin-option"><input type="checkbox" checked={grants.payroll} onChange={(event) => setGrant((old) => ({ ...old, [request.request_id]: { ...grants, payroll: event.target.checked } }))} /> Payroll</label>
            <label className="admin-option"><input type="checkbox" checked={grants.admin} onChange={(event) => setGrant((old) => ({ ...old, [request.request_id]: { ...grants, admin: event.target.checked } }))} /> Super admin</label>
          </div>
          <div className="admin-request-actions">
            <button type="button" className="primary" disabled={busy === request.request_id} onClick={() => void review(request.request_id, "approve")}>Approve</button>
            <button type="button" className="secondary" disabled={busy === request.request_id} onClick={() => void review(request.request_id, "deny")}>Deny</button>
          </div>
        </article>;
      }) : <p className="admin-empty-state">No pending access requests.</p>}
    </section>

    <section className="panel admin-panel">
      <div className="section-heading"><div><h2>Accounts and roles</h2><p>Role changes and disablement take effect on the next protected request. The last active super admin is protected.</p></div></div>
      {data.users.map((account) => {
        const roles = roleSelections[account.id] ?? account.roles;
        return <article className="admin-user-row" key={account.id}>
          <div className="admin-person"><strong>{account.displayName}</strong><div className="admin-person-meta"><small>{account.email ?? "No email claim"}</small><span className="admin-status" data-status={account.accessStatus}>{account.accessStatus}</span></div></div>
          <div className="admin-role-list" role="group" aria-label={`Roles for ${account.displayName}`}>
            {(["employee", "payroll", "super_admin"] as Role[]).map((role) => <label className="admin-option" key={role}>
              <input type="checkbox" checked={roles.includes(role)} onChange={() => flipRole(account.id, role, account.roles)} /> {role === "super_admin" ? "Super admin" : role[0].toUpperCase() + role.slice(1)}
            </label>)}
          </div>
          <div className="admin-user-actions">
            <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void saveRoles(account.id)}>Save roles</button>
            {account.accessStatus === "active"
              ? <button type="button" className="danger-button" disabled={busy === account.id} onClick={() => void toggleStatus(account.id, "disabled")}>Disable</button>
              : <button type="button" className="secondary" disabled={busy === account.id} onClick={() => void toggleStatus(account.id, "active")}>Enable</button>}
          </div>
        </article>;
      })}
      {!data.users.length && <p className="admin-empty-state">No accounts to manage.</p>}
    </section>

    <NotificationSettings />

    <section className="panel admin-panel">
      <div className="section-heading"><div><h2>Security and access history</h2><p>Performed by identifies who acted; affected account identifies the user changed, when recorded. Payroll entries remain listed; details require the Payroll role in this view.</p></div></div>
      <form className="admin-audit-filters" onSubmit={(event) => void applyAuditFilters(event)}>
        <label>Search history<input type="search" maxLength={160} placeholder={canViewPayroll ? "Event, person, or details" : "Payroll only: use the other filters"} disabled={!canViewPayroll} value={canViewPayroll ? auditFilters.query : ""} onChange={(event) => setAuditFilters((old) => ({ ...old, query: event.target.value }))} /></label>
        <label>From<input type="date" value={auditFilters.from} onChange={(event) => setAuditFilters((old) => ({ ...old, from: event.target.value }))} /></label>
        <label>To<input type="date" value={auditFilters.to} onChange={(event) => setAuditFilters((old) => ({ ...old, to: event.target.value }))} /></label>
        <label>Event<input type="search" maxLength={160} placeholder="For example: payroll" value={auditFilters.event} onChange={(event) => setAuditFilters((old) => ({ ...old, event: event.target.value }))} /></label>
        <label>Performed by<input type="search" maxLength={160} placeholder="Name or email" value={auditFilters.actor} onChange={(event) => setAuditFilters((old) => ({ ...old, actor: event.target.value }))} /></label>
        <label>Affected account<input type="search" maxLength={160} placeholder="Name, email, or ID" value={auditFilters.account} onChange={(event) => setAuditFilters((old) => ({ ...old, account: event.target.value }))} /></label>
        <div className="admin-audit-filter-actions"><button className="primary" type="submit" disabled={auditBusy}>Apply filters</button><button className="secondary" type="button" onClick={() => void clearAuditFilters()} disabled={auditBusy}>Clear</button></div>
      </form>
      {auditBusy && <p className="admin-audit-updating" role="status">Updating security history...</p>}
      <div className="table-scroll admin-audit-scroll" aria-busy={auditBusy}>
        <table className="records-table admin-audit-table">
          <thead><tr><th>When</th><th>Performed by</th><th>Event</th><th>Affected account</th><th>Details</th></tr></thead>
          <tbody>{audit.events.map((event) => event.payrollOnly || (!canViewPayroll && !isAdministrativeAuditEvent(event.eventType)) ? <tr key={event.id}><td><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></td><td colSpan={4}><span className="admin-audit-muted">Payroll only</span></td></tr> : <tr key={event.id}>
            <td><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></td>
            <td><strong>{event.actorName}</strong>{event.actorEmail && <small>{event.actorEmail}</small>}</td>
            <td><code className="admin-audit-event">{event.eventType}</code></td>
            <td><strong>{event.subjectName ?? (event.subjectUserId ? "Account" : "Account not recorded")}</strong>{(event.subjectEmail ?? event.subjectUserId) && <small>{event.subjectEmail ?? event.subjectUserId}</small>}</td>
            <td>{event.details == null ? <span className="admin-audit-muted">No details recorded</span> : <details className="admin-audit-details"><summary>View details</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details>}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {!audit.events.length && <p className="admin-empty-state">No security events match these filters.</p>}
      <div className="admin-audit-pagination">
        <p role="status">{audit.total ? `Showing ${(audit.page - 1) * audit.pageSize + 1}-${Math.min(audit.page * audit.pageSize, audit.total)} of ${audit.total} events` : "No matching events"}</p>
        <div><button type="button" className="secondary" onClick={() => void goToAuditPage(audit.page - 1)} disabled={auditBusy || audit.page <= 1}>Previous</button><span aria-live="polite">Page {audit.page} of {audit.totalPages}</span><button type="button" className="secondary" onClick={() => void goToAuditPage(audit.page + 1)} disabled={auditBusy || audit.page >= audit.totalPages}>Next</button></div>
      </div>
    </section>
  </main>;
}
