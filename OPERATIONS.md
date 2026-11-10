# Expense Report operations

## Current boundary

The approved deployment is HTTP-only on the internal network, for both browser access and BT Auth, including production mode. HTTP does not encrypt credentials, session cookies, or receipts in transit. Keep this setup within its approved access boundary. A future production release still needs an approved service account/process manager and a demonstrated backup restore. This source update does not deploy or restart anything.

No production deployment, process restart, provider-key rotation, real-user revocation, or backup schedule was performed during readiness work. The `demo` branch remains at `07345e8f89794a5a14987e9967ee83d76a4c3294`; `/preview` keeps the browser-local demo. A future production database starts empty; never seed it with demo data.

## Runtime and session behavior

- Node.js 24 or newer; one application process and a local SQLite file, outside build output. Use the committed lockfile when installing on an approved deployment host.
- Keep `.env.local`, database files, backup files, and secrets outside commits and release archives. Set an absolute `EXPENSE_REPORT_DB_PATH` for an unattended process. Back up configuration through a separately approved secret-management process, not with the database command.
- Set `APP_PUBLIC_ORIGIN` to the browser origin. Configure the internal HTTP BT Auth base URL, full HTTP JWKS URL, and exact unchanged issuer. The TrueNAS plan uses external BT Auth at `http://192.168.203.238:3210`, JWKS at `http://192.168.203.238:3210/.well-known/jwks.json`, and unchanged issuer `http://auth.biztechro.com`; no BT Auth container is being introduced. Login and JWKS endpoints must respond directly without redirects. The current provider OpenAPI is linked from `/docs` through `/api/openapi.json`; it has no session introspection endpoint.
- App sessions expire at the earlier of eight hours or the verified provider token expiry. Persistent provider evidence consists only of issuer, subject, expiry, key ID, and an RFC 7638 public-key fingerprint. Passwords and upstream bearer tokens are not stored.
- Protected requests recheck that public key against JWKS, cached for five minutes. Failed refreshes may use cached keys only until fifteen minutes since the last successful refresh. Removed keys and same-ID replacements invalidate sessions after refresh. Outages beyond the limit deny access. Provider-side account disablement has no independent introspection signal; local app disablement and role changes apply on the next protected request.
- The session schema migration is additive. Older sessions without provider evidence require a new sign-in after this code is activated. A persistent `AUTH_SESSION_SECRET` is required for production; never put it in this runbook or Git. App logout affects this app only.
- `FIRST_ADMIN_BOOTSTRAP_TOKEN` was absent from the inspected environment file and readiness process environment. The already-running server's environment was not inspected. Before a future authorized restart, confirm its service configuration also omits the token. The database bootstrap guard protects an existing first admin regardless.

## Verification before release

From the repository directory, using installed dependencies:

```powershell
npm run typecheck
npm test
npm run db:backup-self-test
```

The self-test uses the real application schema in a temporary database. It checks accounts, roles, profile, annual readings, mileage, expenses, history, audit, and exact PNG/PDF receipt bytes. It never reads the live database. Session tests use synthetic RS256 tokens and mocked JWKS. Cross-role workflow tests use in-memory SQLite and exercise authorized app APIs. These tests do not establish live BT Auth integration; the user separately reported completing the live workflow.

`APP_PUBLIC_ORIGIN` must be the employee-facing HTTP origin, including its port. The app accepts HTTP without `BT_AUTH_ALLOW_HTTP`; that legacy setting and `AUTH_TRUST_PROXY` are unused. Keep same-origin mutation checks enabled and preserve the public host through any proxy. The HttpOnly, SameSite=Lax app cookie intentionally omits Secure for HTTP. The persistent production session secret and all JWT, account, role and receipt-ownership checks remain required.

Run a production build in a separate release checkout before deployment. Do not build into `.next` while the existing development server uses that directory. Do not restart or deploy without authorization. For the internal HTTP production deployment, build with `npm run build`, use the configured persistent database and session secret, then start under the approved service manager. `npm start` binds `0.0.0.0`; Docker runs the standalone server with `HOSTNAME=0.0.0.0`, `PORT=3000` and `/data` storage. The local app-only Compose template publishes localhost only. The separate TrueNAS template requires the actual LAN address, host port and dataset path, and starts with fresh data; no migration is authorized. See `DOCKER.md` for runtime configuration, persistence and remaining integration inputs. Keep the working tree's development-generated `next-env.d.ts` separate from source changes.

## Existing daily local backups

Daily local backups are already configured, as confirmed by the user on October 20, 2026. The review did not change or independently inspect the existing schedule, destination, task account, permissions, or retention. Keep the current backup configuration and retained data intact; the commands below describe the backup utility, not a request to create another schedule.

The command uses SQLite's online backup API, which includes WAL-backed changes consistently. Receipt payloads live in the same SQLite database; there is no separate receipt directory to copy. It checks integrity, foreign keys, schema, all application-row content, and receipt bytes against a temporary restore copy. It refuses to overwrite a backup and returns a nonzero exit code on failure.

The backup utility supports a daily-directory argument for an external scheduler, for example:

```powershell
node scripts/backup-db.mjs --daily-dir "F:\Expense Report Backups"
```

This creates a timestamped file. It does not schedule itself, upload data, copy `.env.local`, or delete older files. The scheduled task must receive the absolute live database path in `EXPENSE_REPORT_DB_PATH`; the standalone script does not load Next.js environment files. Restrict the folder's NTFS permissions to the approved application/backup operators before copying real records. A backup on the same disk cannot recover a disk failure; choosing another destination is a later decision.

For a specifically approved backup path:

```powershell
node scripts/backup-db.mjs "F:\Expense Report Backups\chosen-backup.sqlite"
node scripts/backup-db.mjs --verify "F:\Expense Report Backups\chosen-backup.sqlite"
```

## Restore procedure — requires an approved maintenance window

1. Identify the backup and run `--verify` first. Restore into a separate directory and confirm the expected receipt, record, history, and audit content through an isolated app instance. Do not point a test instance at the live database.
2. Stop the application only after authorization. Preserve the current database and its WAL/SHM files together as a rollback set. Never overwrite a running SQLite database or mix a restored file with stale WAL/SHM files.
3. Put the verified backup at the approved database path with the approved permissions. Clear restored app sessions using an authorized maintenance operation so previously logged-out sessions cannot return from a backup. Keep business and audit records intact.
4. Start the approved release, sign in again, and check ownership, payroll actions, receipt access, PDFs, and audit history. Record the backup identifier, restoration time, operator, verification result, and rollback path. Keep rollback files until their removal is approved.

## Business settings

The current mileage rate remains unchanged and is managed through Payroll's dated rates. Processing keeps its selected rate; reopening retains that rate unless Payroll performs an audited rate correction. Paid mileage/amount repair requires Undo Paid first.

The approved provisional pay schedule remains fourteen inclusive days: anchor September 26–October 9, 2026, paid October 16. “Current pay period” follows the upcoming payday, including payday itself. October 17–30 selects October 10–23, paid October 30. No payroll-policy or rate change was made during readiness work.

## Git/release hygiene

Review and commit only application source, tests, lockfile, configuration examples, and these instructions. Generated build output, screenshots, environment files, live SQLite files, and backups remain excluded. Pre-existing tracked deployment/document archives are not an approved release artifact and were not updated. Create a fresh reviewed release package from the intended source revision rather than reusing them. No push is authorized by the local-commit request.
