# Biztech Expense Report

Expense Report keeps employee mileage, expense, receipt, payroll, and access records in a shared server-side SQLite database. The root app uses BT Auth to verify the employee's identity, then creates a separate Expense Report session. `/preview` retains the browser-local demo, and the `demo` branch remains separate; demo data is separate from future production data.

## Runtime and local setup

Use Node.js 24 or newer. The server uses Node's built-in `node:sqlite` module and online backup API. Its current process must have write access to the database directory.

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Open `http://127.0.0.1:3000`. Local loopback HTTP is accepted for the app itself. The BT Auth OpenAPI 0.9.0 confirms `POST /auth/local-login` accepts `username` and `password`, sets the `bt_session` cookie scoped to `.biztechro.com`, and expires it at the next local midnight. Its public JWKS endpoint is `/.well-known/jwks.json` and publishes RS256 keys. The adapter extracts the upstream cookie server-side; it does not rely on the domain-scoped cookie reaching localhost.

The adapter defaults the credential field names and upstream cookie name to the documented values. The planned TrueNAS app uses the existing external BT Auth at `http://192.168.203.238:3210`, its JWKS at `http://192.168.203.238:3210/.well-known/jwks.json`, and the unchanged issuer `http://auth.biztechro.com`. No BT Auth container or expense-data migration is planned; the app starts with fresh data. Login calls root `/auth/local-login`; configure direct endpoints because login and JWKS redirects are not followed. The issuer identifies the signer independently of the transport hostname. RS256 signature, issuer, required identity claims, signing key and token lifetime remain verified.

This deployment uses HTTP for both employee browser access and server-to-server BT Auth requests, including production mode, without an opt-in flag. Keep it within the approved internal network: HTTP does not encrypt passwords, session cookies or receipt traffic. `BT_AUTH_ALLOW_HTTP` and `AUTH_TRUST_PROXY` are no longer used. Set `APP_PUBLIC_ORIGIN` to the exact employee-facing HTTP origin, including a non-default port; mutation requests must supply a matching Origin header. A reverse proxy must preserve the public host. Forwarded protocol headers do not bypass transport checks.

Set a persistent random `AUTH_SESSION_SECRET` of at least 32 bytes for production. The app session cookie is HttpOnly, SameSite=Lax, host-only and scoped to `/`; it omits Secure so browsers send it over HTTP. Authentication, server-side roles, ownership checks and same-origin mutation checks still apply. Use `npm run build` and `npm start` for production; the production listener binds `0.0.0.0` and development remains loopback-only. Docker packaging uses the standalone server with a persistent `/data` volume; see [Docker configuration and pending deployment inputs](DOCKER.md).

## Access and data

A verified identity starts as a pending access request. A super admin approves employee access and can grant payroll or super admin explicitly. The first admin can be established once by setting `FIRST_ADMIN_BOOTSTRAP_TOKEN` temporarily and signing in as the intended verified account; remove the setting after bootstrap. Super admins have payroll access and the system protects the last active super admin.

`EXPENSE_REPORT_DB_PATH` can select the SQLite file; it defaults to `.data/expense-report.sqlite`. The database is authoritative for shared business records. Passwords and upstream cookies are not stored. Employee reads and writes are scoped to the signed-in user; payroll and admin operations are separately authorized on the server. Role or account changes take effect on the next protected request.

App sessions are bounded by both eight hours and the verified provider expiry. Protected requests recheck the provider signing-key fingerprint against cached JWKS (five-minute refresh; fifteen-minute maximum key staleness on failure). Only public verification metadata is persisted. Legacy sessions without that metadata require sign-in again when this revision is activated. Provider account disablement cannot be independently detected because the current contract has no introspection endpoint. See [operations and deployment instructions](OPERATIONS.md).

## Backups and restore checks

The app provides a consistent SQLite backup command and a restore-copy check. Daily local backups are already configured outside this repository, as confirmed by the user on October 20, 2026. This review leaves that schedule, destination, and retained data unchanged. For manual backups and verification:

```powershell
node scripts/backup-db.mjs "D:\ExpenseBackups\expense-report-YYYYMMDD.sqlite"
node scripts/backup-db.mjs --verify "D:\ExpenseBackups\expense-report-YYYYMMDD.sqlite"
npm run db:backup-self-test
```

The backup command refuses to overwrite an existing file and checks SQLite integrity, foreign keys, the Expense Report schema, row content, and receipt bytes against a temporary restore copy. `--verify` repeats that check. The self-test uses the real schema with synthetic data and PNG/PDF receipts. `--daily-dir <approved-directory>` creates a timestamped backup for an external scheduler; it performs no scheduling or pruning. Exact path, task timing, permissions, and retention remain operational decisions. Before production, test a restore from a real backup using the approved deployment path and keep the result with the operations record.

## Recordkeeping fields

Each trip records the date, business destination or area, business purpose, starting and ending odometer readings, and optional parking and tolls. The profile records the driver, vehicle, and date the vehicle was first used for business. Annual opening and closing/current odometer readings establish total vehicle mileage for the year; both are required before exporting a final full-year report.

These fields follow the vehicle-expense recordkeeping elements in IRS Publication 463. California Franchise Tax Board guidance generally follows the federal automobile-expense rules and requires adequate records of the date, amount, place, and business character of expenses. The app supports recordkeeping but does not determine whether a trip is deductible or provide tax advice.

Official guidance:

- [IRS Publication 463 - Travel, Gift, and Car Expenses](https://www.irs.gov/publications/p463)
- [California FTB 984 - Business Expenses](https://www.ftb.ca.gov/forms/misc/984.pdf)
- [California FTB - Keeping your tax records](https://www.ftb.ca.gov/file/after-you-file/keeping-your-tax-records.html)

## Verification

```powershell
npm run typecheck
npm test -- --maxWorkers=1 --no-isolate
npm run db:backup-self-test
npm run build
```
