import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createTestDatabase, getUser, setTestDatabase } from "./db";
import {
  manageUserAccess,
  managedUsers,
  securityAudit,
  reviewAccessRequest,
  bootstrapFirstAdmin,
} from "./records";
import type { DatabaseSync } from "node:sqlite";
let db: DatabaseSync;
const now = "2026-10-27T12:00:00.000Z";
beforeEach(() => {
  db = createTestDatabase();
  setTestDatabase(db);
  for (const [id, name] of [
    ["admin", "Synthetic Alice"],
    ["employee", "Synthetic Bob"],
  ])
    db.prepare(
      "INSERT INTO users VALUES (?, 'synthetic', ?, ?, NULL, 'active', ?, ?)",
    ).run(id, id, name, now, now);
  db.prepare(
    "INSERT INTO roles(user_id,role,granted_at) VALUES ('admin','super_admin',?),('employee','employee',?)",
  ).run(now, now);
});
afterEach(() => {
  vi.unstubAllEnvs();
  setTestDatabase(null);
  db.close();
});
it("logs a payroll self-grant and payroll grants/removals for another account with distinct actor/affected-account semantics", () => {
  manageUserAccess(getUser(db, "admin")!, "admin", {
    roles: ["super_admin", "payroll"],
  });
  manageUserAccess(getUser(db, "admin")!, "employee", {
    roles: ["employee", "payroll"],
  });
  manageUserAccess(getUser(db, "admin")!, "employee", { roles: ["employee"] });
  const events = securityAudit(getUser(db, "admin")!).events.filter(
    (e) => e.eventType === "user_access_updated",
  );
  expect(events).toHaveLength(3);
  expect(
    events.some(
      (e) =>
        e.actorName === "Synthetic Alice" &&
        e.subjectName === "Synthetic Alice" &&
        (e.details as { roles: string[] }).roles.includes("payroll"),
    ),
  ).toBe(true);
  const bob = events.filter((e) => e.subjectName === "Synthetic Bob");
  expect(bob).toHaveLength(2);
  expect(bob.every((e) => e.actorName === "Synthetic Alice")).toBe(true);
  expect(
    bob.some((e) =>
      (e.details as { roles: string[] }).roles.includes("payroll"),
    ),
  ).toBe(true);
  expect(
    bob.some(
      (e) => !(e.details as { roles: string[] }).roles.includes("payroll"),
    ),
  ).toBe(true);
  expect(getUser(db, "employee")!.roles).toEqual(["employee"]);
});
it("rolls back a role grant if its audit cannot be written", () => {
  db.exec(
    "CREATE TRIGGER fail_role_audit BEFORE INSERT ON audit_events WHEN NEW.event_type = 'user_access_updated' BEGIN SELECT RAISE(ABORT, 'synthetic role audit failure'); END",
  );
  expect(() =>
    manageUserAccess(getUser(db, "admin")!, "employee", {
      roles: ["employee", "payroll"],
    }),
  ).toThrow("synthetic role audit failure");
  expect(getUser(db, "employee")!.roles).toEqual(["employee"]);
});

it("persists a pure Super admin, including on status-only saves, without changing existing assigned roles automatically", () => {
  expect(getUser(db, "admin")!.roles).toEqual(["super_admin"]);
  manageUserAccess(getUser(db, "admin")!, "admin", { roles: ["super_admin"] });
  manageUserAccess(getUser(db, "admin")!, "admin", { accessStatus: "active" });
  expect(getUser(db, "admin")!.roles).toEqual(["super_admin"]);
  manageUserAccess(getUser(db, "admin")!, "employee", {
    roles: ["super_admin"],
  });
  manageUserAccess(getUser(db, "admin")!, "employee", {
    accessStatus: "disabled",
  });
  manageUserAccess(getUser(db, "admin")!, "employee", {
    accessStatus: "active",
  });
  expect(getUser(db, "employee")!.roles).toEqual(["super_admin"]);
  db.prepare(
    "INSERT INTO roles(user_id,role,granted_at) VALUES ('employee','payroll',?)",
  ).run(now);
  manageUserAccess(getUser(db, "admin")!, "employee", {
    accessStatus: "active",
  });
  expect(getUser(db, "employee")!.roles).toEqual(["payroll", "super_admin"]);
});
it("logs self-granted and self-removed Payroll while retaining the last Super admin", () => {
  manageUserAccess(getUser(db, "admin")!, "admin", {
    roles: ["super_admin", "payroll"],
  });
  expect(getUser(db, "admin")!.roles).toEqual(["payroll", "super_admin"]);
  manageUserAccess(getUser(db, "admin")!, "admin", { roles: ["super_admin"] });
  expect(getUser(db, "admin")!.roles).toEqual(["super_admin"]);
  const events = securityAudit(getUser(db, "admin")!).events;
  expect(events).toHaveLength(2);
  expect(
    events.every(
      (e) =>
        e.actorName === "Synthetic Alice" &&
        e.subjectName === "Synthetic Alice",
    ),
  ).toBe(true);
  expect(
    events.some((e) =>
      (e.details as { roles: string[] }).roles.includes("payroll"),
    ),
  ).toBe(true);
  expect(
    events.some(
      (e) => !(e.details as { roles: string[] }).roles.includes("payroll"),
    ),
  ).toBe(true);
  expect(() =>
    manageUserAccess(getUser(db, "admin")!, "admin", { roles: ["payroll"] }),
  ).toThrow("last active super admin");
  expect(() =>
    manageUserAccess(getUser(db, "admin")!, "admin", {
      accessStatus: "disabled",
    }),
  ).toThrow("last active super admin");
  expect(getUser(db, "admin")!.roles).toEqual(["super_admin"]);
  expect(getUser(db, "admin")!.accessStatus).toBe("active");
  expect(securityAudit(getUser(db, "admin")!).events).toHaveLength(2);
});
it.each([false, true])(
  "approves Super admin with Payroll only when explicitly selected: %s",
  (grantPayroll) => {
    const requestId = "33333333-3333-4333-8333-333333333333";
    db.prepare(
      "UPDATE users SET access_status='pending' WHERE id='employee'",
    ).run();
    db.prepare(
      "INSERT INTO access_requests(id,user_id,status,requested_at) VALUES (?,'employee','pending',?)",
    ).run(requestId, now);
    reviewAccessRequest(getUser(db, "admin")!, {
      requestId,
      decision: "approve",
      grantAdmin: true,
      grantPayroll,
    });
    const roles = getUser(db, "employee")!.roles;
    expect(roles.includes("super_admin")).toBe(true);
    expect(roles.includes("payroll")).toBe(grantPayroll);
    expect(securityAudit(getUser(db, "admin")!).events[0]).toMatchObject({
      eventType: "access_request_approved",
      details: {
        grantedRoles: grantPayroll
          ? ["employee", "payroll", "super_admin"]
          : ["employee", "super_admin"],
      },
    });
  },
);
it("bootstraps a new first admin without automatically assigning Payroll", () => {
  vi.stubEnv("FIRST_ADMIN_BOOTSTRAP_TOKEN", "synthetic-bootstrap-token");
  db.prepare(
    "UPDATE users SET access_status='disabled' WHERE id='admin'",
  ).run();
  db.prepare(
    "UPDATE users SET access_status='pending' WHERE id='employee'",
  ).run();
  db.prepare("DELETE FROM roles WHERE user_id='employee'").run();
  bootstrapFirstAdmin(getUser(db, "employee")!, "synthetic-bootstrap-token");
  expect(getUser(db, "employee")!.roles).toEqual(["employee", "super_admin"]);
  expect(securityAudit(getUser(db, "employee")!).events[0]).toMatchObject({
    eventType: "first_admin_bootstrap",
    details: { grantedRoles: ["employee", "super_admin"] },
  });
});
it("rolls back a self-removal of Payroll if auditing fails", () => {
  db.prepare(
    "INSERT INTO roles(user_id,role,granted_at) VALUES ('admin','payroll',?)",
  ).run(now);
  db.exec(
    "CREATE TRIGGER fail_role_removal_audit BEFORE INSERT ON audit_events WHEN NEW.event_type = 'user_access_updated' BEGIN SELECT RAISE(ABORT, 'synthetic removal audit failure'); END",
  );
  expect(() =>
    manageUserAccess(getUser(db, "admin")!, "admin", {
      roles: ["super_admin"],
    }),
  ).toThrow("synthetic removal audit failure");
  expect(getUser(db, "admin")!.roles).toEqual(["payroll", "super_admin"]);
});
it("persists self-role edits through the actual API and exposes updated roles on session reload", async () => {
  const { createAppSession } = await import("./auth");
  const { PATCH } = await import("@/app/api/admin/users/[id]/route");
  const { GET } = await import("@/app/api/auth/me/route");
  const session = await createAppSession("admin");
  const cookie = "expense_report_session=" + session.token;
  for (const roles of [
    ["super_admin"],
    ["super_admin", "payroll"],
    ["super_admin"],
  ]) {
    const response = await PATCH(
      new Request("http://localhost/api/admin/users/admin", {
        method: "PATCH",
        headers: {
          cookie,
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ roles }),
      }),
      { params: Promise.resolve({ id: "admin" }) },
    );
    expect(response.status).toBe(200);
    const read = await GET(
      new Request("http://localhost/api/auth/me", { headers: { cookie } }),
    );
    expect(read.status).toBe(200);
    expect((await read.json()).user.roles).toEqual([...roles].sort());
  }
  expect(
    securityAudit(getUser(db, "admin")!).events.filter(
      (e) => e.eventType === "user_access_updated",
    ),
  ).toHaveLength(3);
});

function retiredFixture(id = "retired") {
  db.prepare("INSERT INTO users(id,issuer,subject,display_name,email,access_status,created_at,updated_at) VALUES (?,?,?,?,?,'disabled',?,?)").run(id,"urn:expense-report:retired-duplicate:"+id,"synthetic-subject-"+id,"Synthetic retired duplicate","retired@example.test",now,now);
  db.prepare("INSERT INTO access_requests(id,user_id,status,requested_at,reviewed_by,reviewed_at) VALUES (?,?,'denied',?,'admin',?)").run("denial-"+id,id,now,now);
  db.prepare("INSERT INTO audit_events(id,actor_id,event_type,subject_user_id,details_json,created_at) VALUES (?,'admin','duplicate_identity_retired',?,'{}',?)").run("retirement-"+id,id,now);
}
it("hides only explicitly retired duplicates from Accounts while preserving normal disabled users and history", () => {
  retiredFixture();
  db.prepare("UPDATE users SET access_status='disabled' WHERE id='employee'").run();
  const beforeUsers=db.prepare("SELECT * FROM users ORDER BY id").all();
  const beforeRequests=db.prepare("SELECT * FROM access_requests ORDER BY id").all();
  const beforeAudit=db.prepare("SELECT * FROM audit_events ORDER BY id").all();
  expect(managedUsers(getUser(db,"admin")!).map(x=>x.id).sort()).toEqual(["admin","employee"]);
  expect(managedUsers(getUser(db,"admin")!).find(x=>x.id==="employee")?.accessStatus).toBe("disabled");
  expect(db.prepare("SELECT * FROM users ORDER BY id").all()).toEqual(beforeUsers);
  expect(db.prepare("SELECT * FROM access_requests ORDER BY id").all()).toEqual(beforeRequests);
  expect(db.prepare("SELECT * FROM audit_events ORDER BY id").all()).toEqual(beforeAudit);
  expect(securityAudit(getUser(db,"admin")!).events.some(e=>e.eventType==="duplicate_identity_retired"&&e.subjectName==="Synthetic retired duplicate")).toBe(true);
  manageUserAccess(getUser(db,"admin")!,"employee",{accessStatus:"active"});
  expect(getUser(db,"employee")?.accessStatus).toBe("active");
});
it.each([{accessStatus:"active"},{accessStatus:"disabled"},{roles:["employee"]},{roles:[]}])("blocks stale/direct management of retired duplicates: %j", input => {
  retiredFixture();
  const beforeUser=db.prepare("SELECT * FROM users WHERE id='retired'").get();
  const beforeAudit=db.prepare("SELECT * FROM audit_events ORDER BY id").all();
  expect(()=>manageUserAccess(getUser(db,"admin")!,"retired",input)).toThrow("Retired duplicate accounts cannot be changed.");
  expect(db.prepare("SELECT * FROM users WHERE id='retired'").get()).toEqual(beforeUser);
  expect(getUser(db,"retired")?.roles).toEqual([]);
  expect(db.prepare("SELECT * FROM audit_events ORDER BY id").all()).toEqual(beforeAudit);
});
it("requires exact account marker and retirement audit, rather than status, prefix or audit alone",()=>{
  for(const [id,issuer] of [["marker-only","urn:expense-report:retired-duplicate:marker-only"],["audit-only","synthetic"],["wrong-marker","urn:expense-report:retired-duplicate:someone-else"]])db.prepare("INSERT INTO users(id,issuer,subject,display_name,access_status,created_at,updated_at) VALUES (?,?,?,?,'disabled',?,?)").run(id,issuer,id,id,now,now);
  for(const id of ["audit-only","wrong-marker"])db.prepare("INSERT INTO audit_events(id,actor_id,event_type,subject_user_id,created_at) VALUES (?,'admin','duplicate_identity_retired',?,?)").run('audit-'+id,id,now);
  expect(managedUsers(getUser(db,'admin')!).map(x=>x.id)).toEqual(expect.arrayContaining(['marker-only','audit-only','wrong-marker']));
});
it("cannot reactivate an explicitly retired duplicate even if an older client previously changed its status",()=>{
  retiredFixture();db.prepare("UPDATE users SET access_status='active' WHERE id='retired'").run();
  expect(managedUsers(getUser(db,'admin')!).map(x=>x.id)).not.toContain('retired');
  expect(()=>manageUserAccess(getUser(db,'admin')!,'retired',{roles:['super_admin']})).toThrow('Retired duplicate accounts cannot be changed.');
});
