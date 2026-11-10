# Payroll PDF receipt appendix

Payroll's existing employee/date PDF export now adds a receipt appendix **after all report table pages**. The table adds `[Receipt R1]`, `[Receipt R2]`, etc. Each appendix page repeats that reference, the employee/period, expense date, merchant, original expense amount and filename. The current app stores one attachment per expense; an attachment can contain several PDF pages.

The existing inclusive `From`/`To` dates and chosen employee determine both table rows and receipt selection. Separate record-browser search/status filters do not change this existing employee report's scope. Authorization, roles, calculations, statuses, filenames and private/no-store response headers are unchanged. There are no database migrations.

The server reads only those included expenses' stored receipt bytes, bounded again by employee ID and date. It does not fetch receipt endpoint URLs or external URLs. Missing, corrupt, unsupported, encrypted or excessive attachments produce an explicit labeled warning in the exported appendix. One bad receipt does not discard the summary or other receipts.

## Printed content

- Production image export uses Sharp to apply EXIF orientation and locally convert supported JPEG/PNG/WebP/GIF/AVIF/TIFF images to PNG. Existing user-saved image rotations remain intact. Decoder support for HEIC/HEIF/BMP depends on the installed native build; unreadable formats get a warning. Animated or multipage images show the first frame/page with an explicit note to consult the original.
- Normal images fit the available page area without changing aspect ratio. Very long or wide images continue across numbered, slightly overlapping sections rather than being squeezed into unreadable thumbnails or losing content. Blank areas of the original remain blank.
- Every page of a supported PDF receipt is included, preserving its displayed crop box and rotation. The appendix is a static printed representation. Existing form appearances are flattened; source document actions, hyperlinks, interactive annotations, embedded files and signature validation are not copied. The original attachment remains unchanged and downloadable in the app.
- Page numbers cover both table and appendix. Warnings have matching references and are collected into appendix warning pages.

## Export limits

Limits keep large exports bounded: 20 MB per attachment, 50 MB combined raw receipt input, 50 MB normalized receipt content, 25 megapixels per image, 50 PDF pages or image sections per attachment and 150 receipt-content pages per export. Table and warning pages are additional. A receipt that would exceed a limit is represented by a labeled warning rather than silently truncated. Download the original separately in those cases.

Only the new report is changed; no stored expense, receipt, approval, email setting or access permission is modified. No receipt is sent to OCR or another external service.

## Safe local preview

Use a fresh PowerShell window and synthetic tests (in-memory SQLite; no sign-in or live data needed):

```powershell
Set-Location 'F:\Projects\Expense Report'
$env:RESEND_API_KEY=''
$env:RESEND_DELIVERY_ENABLED='false'
$env:RECEIPT_PDF_FIXTURE_DIR="$env:TEMP\expense-report-receipt-preview"
npm exec -- vitest run src/lib/server/payroll-receipts.test.ts --reporter=dot
Invoke-Item "$env:RECEIPT_PDF_FIXTURE_DIR\receipt-appendix-preview.pdf"
```

The preview contains only clearly synthetic names, expenses and attachments. It demonstrates normal, tall, wide and rotated images, a multipage PDF, and missing/broken attachment warnings. Other fixture PDFs isolate individual cases. Running these tests does not start or contact the NAS, real BTAuth or Resend.

Verification uses Poppler rendering and actual pixel inspection as well as PDF/API tests. A browser download check uses the generated synthetic PDF and mocked API responses; server tests separately exercise the actual authorized export route and cross-user/date exclusions. No new Windows browser restriction is bypassed. Linux/amd64 local packaging verification passed 23 container checks, including the actual filtered PDF export and Sharp 0.35.5 / libvips 8.18.7. The resulting 19-page PDF was rendered and inspected. This was a local-only receipt-check image; no image was published and no deployment was performed.
