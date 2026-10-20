# Expense Report review — October 20, 2026

## Baseline and scope

The running Webpack Node process resolves to `F:\Projects\Expense Report` (parent/server PIDs 33276/37764); `F:\Expense Report` is absent. Baseline HEAD: `987ec49`. The initial working tree contained `package.json`, `secure-shell.tsx`, `secure-shell.test.tsx`, and untracked `client-json.ts`/tests. Their existing Webpack startup, 12-second deadline, cancellation, and Retry behavior were retained. Baseline: **103 tests and typecheck passed**; anonymous `/api/auth/me` returned 200 with `authenticated:false`.

Read AGENTS.md and the installed Next.js 16.3.8 route/config/CLI guides. Builds and tests ran in a source-only copy with synthetic SQLite data; no environment file or live database was copied. No push, deployment, live restart, credential change, backup configuration change, or data pruning occurred.

## Important flows and preserved behavior

- BT Auth verifies identity → app session → pending access → one-time first-admin bootstrap or admin approval. Session expiry, provider-key checks, immediate local role/disablement checks, and last-admin protection remain intact.
- Employee snapshot saves are scoped to the session owner. Payroll processing, payment/reversal, locked mileage rates, and admin repairs retain their transaction/history/audit behavior.
- Receipt access requires the owner or payroll role. Reports retain their employee/payroll authorization, inclusive date ranges, all-status payroll lines, payment semantics, historical rates, and annual-mileage requirements.
- `/preview` and browser-local demo storage remain intentional features. No speculative removal of demo, deployment, archive, or dynamically used code was made.

## Findings and fixes

| Severity | Confirmed issue | Fix / evidence |
| --- | --- | --- |
| Medium — availability | Sign-in accepted the shared 80 MiB JSON allowance before validating a small credential payload. | Default limit is now 16 KiB, enforced on declared and streamed bytes. Only authenticated employee snapshots retain 80 MiB for existing 50 MiB receipt support. Oversized sign-in test now rejects before calling even the synthetic authenticator. |
| Low — receipt integrity | Upload MIME could disagree with the data URL; existing receipt MIME could be changed without replacement bytes. Malformed base64 was accepted. | Validate MIME agreement and canonical base64, normalize new uploads, and reject metadata-only type changes. Legacy unsafe/mismatched types download as octet-stream attachments. Existing CSP sandbox/nosniff remain. No working script-execution exploit was established. |
| Low — session UX/privacy | A failed logout HTTP response still displayed the signed-out screen while the server session could remain valid. | Require successful logout JSON before clearing client session state. Unit and browser tests cover failure and successful retry. |
| Low — input integrity | Some expense/rate/report dates accepted impossible calendar dates; mileage date refinement could throw on invalid dates. | Share finite calendar validation across schemas and filters; reject invalid report ranges with private 400 responses. Leap-day, impossible-date, and reversed-range tests pass. |
| Low — download reliability | Non-Latin receipt names could make response-header construction fail. | ASCII fallback plus UTF-8 filename parameter; strip control/path/header delimiters and handle malformed Unicode. Receipt bytes remain unchanged. |

The first four receipt/request regression cases failed before their fixes and passed afterward. Cleanup also removed unused route imports and the private mapper's unused receipt-byte output option.

## Performance evidence

Avoid loading receipt blobs for snapshot/direct expense metadata. Read payroll rates once rather than querying for each trip. Rates-only requests no longer build a payroll snapshot; a payroll PDF loads only its target snapshot and rates.

Synthetic fixture: one employee, 1,000 mixed-rate trips, 32 receipts of 256 KiB each, two dated rates. Two warmups and 15 measured reads, same machine/test process setup, in-memory SQLite:

| Read | Before median | After median | SQL statements before → after |
| --- | ---: | ---: | ---: |
| Employee snapshot | 48.41 ms | 5.89 ms | 5 → 5 |
| Payroll snapshot | 57.70 ms | 6.29 ms | 671 → 5 |

Serialized response SHA-256 values were identical before/after for both fixtures. These are synthetic server read measurements, not live workload or browser latency claims. JSON measurements and the benchmark fixture are under `artifacts/review/`.

## Validation

- **118 tests passed** across 26 files; `npm run typecheck` passed. JSON results: `artifacts/review/tests.json`.
- `npm run build -- --webpack` passed in the isolated copy. An initial cross-drive dependency junction prevented module resolution; physical dependency copies resolved it. The live build directory was untouched.
- **7 Playwright checks passed** against the isolated production build on port 3001: existing mileage persistence/edit/delete, annual-report requirement/backup download, payroll layout, synthetic employee submission, phone/desktop timeout recovery, and failed sign-out recovery. External authentication was mocked.
- `npm run db:backup-self-test` passed with synthetic real-schema accounts, roles, history/audit, and exact PNG/PDF receipt bytes.
- Read-only `npm audit --json --ignore-scripts`: **0 reported advisories**, 219 dependencies. No package versions changed.
- Added checks for every mutation's missing/foreign Origin rejection, anonymous protected reads, employee denial across payroll/admin routes, streamed limits, receipt atomic rollback/metadata/downloads, and bounded payroll SQL work. Existing ownership, session/key rotation, bootstrap, last-admin, repair, and export tests also pass.

## Remaining limitations

Office HTTP is the accepted temporary constraint: credentials/session material and business data can be observed or altered in transit; transport and OS/network settings were not changed. BT Auth itself was not attacked or live-login tested. Provider account disablement has no introspection signal; app login relies on upstream rate limiting. Receipts remain untrusted image/PDF files without malware scanning or full file-format validation. Large authenticated snapshots and the main payroll listing remain bounded by existing limits rather than new pagination. Existing invalid historical dates are not migrated or deleted.

Reviewed SQL uses bound values and allowlisted dynamic identifiers; reviewed UI uses React text rendering; receipt IDs do not resolve filesystem paths. Environment files are Git-ignored, no public secret variables were found, and the inspected deployment ZIP contains no environment/key/database entry names. This does not prove absence of secrets in all history or old binaries. No schema migration, historical cleanup, or backup restore against real data was attempted. Daily backups are already configured per the user; stale pending-activation wording in README/OPERATIONS was corrected without touching the scheduler.

This is a scoped code/security review, not a claim that the application is vulnerability-free. No remaining execution blocker requires a live restart.
