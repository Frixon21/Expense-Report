# Multiple vehicles — local implementation

Employees can add cars in Mileage → Settings → Vehicles and choose a default. There is no three-car limit. Each new trip selects a car; switching clears the ending reading and suggests only that car's last saved ending reading (or its annual opening reading). A recovered draft keeps its chosen car. Older drafts retain their text but require a vehicle selection. Duplication retains an active original car, clears new-date/distance/cost confirmation, and never inherits payroll state.

The current onboarding car becomes the initial/default vehicle. Existing trips are associated with that employee's car; available own historical profile snapshots take precedence for those old trips. Different historical cars remain archived internally. Trips with unexpectedly missing legacy profiles are retained with an explicit warning; another employee's car is never used. Existing annual readings are copied to the original car once; the legacy table is retained. Account approvals, roles, receipts, payment status and reimbursement rate selection are unchanged.

New SQLite tables: vehicles, vehicle_preferences, vehicle_annual_mileage. Trip columns store vehicle ID plus immutable name/business-use-date snapshots. An existing trip keeps its recorded name when a profile/default car is renamed. The server rejects foreign-owned vehicle IDs and preserves existing payroll edit locks. Referenced vehicles are not deleted. Optional edit/retire management UI is deferred; the UI provides add/list/default only. The existing profile editor edits the default car.

Payroll records and payroll PDFs label each mileage entry with its recorded car. Employee mileage PDFs group cars into separate sections/pages and require annual readings for each car used in a full-year report. There is no existing CSV export in this app; no new CSV subsystem was added. JSON backups include vehicle metadata. The SQLite backup CLI checks all three new tables and retains receipt bytes.

Migration runs on database opening and when loading an employee. All development verification uses isolated synthetic databases. No live database was migrated. Back up the complete SQLite database before any future deployment. Reverting to an older image can ignore new vehicle fields; avoid mileage writes through old versions after starting to use several cars. Restoring a pre-update backup is the complete schema/data rollback and discards subsequent entries.

Safe local demo preview (separate sanitized QA copy; no real BTAuth login required):

```powershell
Set-Location 'C:\Users\alex\Documents\Codex\2026-10-26\task\expense-qol-check'
$env:RESEND_API_KEY = ''
$env:RESEND_DELIVERY_ENABLED = 'false'
$env:BT_AUTH_BASE_URL = 'http://127.0.0.1:9'
$env:BT_AUTH_JWKS_URL = 'http://127.0.0.1:9/jwks'
$env:EXPENSE_REPORT_DB_PATH = "$PWD\vehicle-manual-synthetic.sqlite"
npm run dev -- --port 18412
```

Open http://127.0.0.1:18412/preview. Demo records are synthetic and stored in that browser; use Settings to add a second car, choose a default, switch cars when adding trips, and inspect payroll/PDF labels. This demo does not authenticate against real BTAuth. Do not run these preview commands in the original checkout, which contains user-managed local configuration.

Synthetic PDF previews are in the task output/pdf/vehicles folder. RECEIPT-PDF.md documents receipt export limits. The prior receipt-only image is not verification of this later vehicle code. No image is published or deployed by this feature work.

Verified locally on 2026-10-29: 204 tests across 34 files, typecheck (including original checkout with approved F-drive write access), production build and focused Prettier check passed. The full browser suite passed 27 checks; the final selector styling was rechecked with 3 focused vehicle/theme checks. A sanitized combined Linux/amd64 image expense-report:vehicles-check-20261029 passed 25 isolated container checks, including actual vehicle APIs/PDF, receipt export, CSPRNG HTTP browser fallback, auth rejection, persistence after recreation, and backup/restore. Native Sharp 0.35.5/libvips 8.18.7 loaded. Rendered container PDFs were inspected. Image ID: sha256:72f55f12146ba43a8b8699ba4bc92328470806df11cb51561e0b1094fe6cb116. Temporary test containers/network/volume were removed. Image remains local only.
