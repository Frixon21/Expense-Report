# Expense-entry notifications (local implementation, not deployed)

Notifications default OFF. A newly inserted expense or mileage entry creates one delivery event when enabled; editing, repeating a save, profile changes and annual readings do not. Entries saved while OFF are not backfilled. Employee identity comes from the authenticated server user. Roles, approvals and existing records are unchanged.

## Account preparation

The user confirms `trustbiztech.com` is verified in the coworker's Resend account. Keep existing mailbox, incoming mail and DNS unchanged; mailbox passwords are not needed. The account must be authorized to send for this domain and use a sending-only key scoped to it. Do not enter keys in the browser, source control or chat. No key has been configured and no external mail was sent during implementation.

The app generates a fixed subject plus escaped HTML and plain text: employee name, a new expense or mileage entry was submitted, and the review link. No hosted template or template ID is required. Both HTML and plain text also include the registration link `http://192.168.203.238:3210/auth/local-register`. This does not grant access or change roles. Already queued messages keep their original content. Email includes no amounts or receipts. Automatic delivery defaults to `Office@trustbiztech.com`; test emails remain fixed to Alex. Existing saved recipients take precedence over this default and are not rewritten.

## Runtime and admin settings

- Server-only `RESEND_API_KEY`: supplied later through an approved runtime secret mechanism, never through the HTTP admin form.
- Server-only `RESEND_DELIVERY_ENABLED=true`: explicit runtime release gate; absent/false prevents **all** sends, including tests. Leave absent during local/mock work.
- Administration -> Email notifications: persisted on/off switch, From, Recipient and Review URL. No secret input. Default From `BizTech Expense Reports <Notifications@trustbiztech.com>`, default automatic recipient `Office@trustbiztech.com` (editable; existing saved settings take precedence), default review URL `http://192.168.203.180:3001/` (office network/VPN only). Save settings before testing.
- Send test email requires enabled settings, key and delivery gate; confirmation names the test recipient `alex@trustbiztech.com`, which is fixed for the test action even if the production recipient is later changed. It uses the same app-generated content, with employee name `Test notification`. Repeated transport retries of one test action share a key; another deliberate click is another test.

No external test is authorized yet. After separately approving runtime secret configuration, deployment and an external test, enable notifications and confirm one test to Alex. A successful provider API response means accepted, not delivered: check Resend delivery/bounce status separately. The app does not configure webhooks or inspect mailboxes.

## Reliability and operational limits

SQLite `notification_settings` and `notification_outbox` tables are additive and live in the existing persistent database under `/data`. Keep the same mount and backup the database before future deployment. No account reapproval/bootstrap or role migration is introduced. Backups include and fingerprint the new tables when present, while accepting older backups without them.

Each outbox key is permanently unique by entry type and UUID, with an immutable recipient/subject/HTML/plain-text snapshot. Sent keys remain in the ledger even if an entry is deleted. The record and delivery intent commit together. If queue insertion fails, a server warning is recorded and the expense still saves; that exceptional missed notification needs operator follow-up and is not silently backfilled.

Delivery runs after a successful save or admin retry. Each drain attempts up to ten due events. There is **no continuous worker/timer**: pending retries require a later save or the admin's Retry due notifications button; use Refresh delivery status to see counts. Turning notifications OFF pauses queued delivery; it does not delete the ledger. Re-enabling resumes pending entries, with their original payload. A future dedicated scheduler is separate scope if automatic retries during idle periods are required.

Leases prevent simultaneous drains from claiming the same row. Crashed/stale leases become eligible after two minutes. Network/unknown errors, HTTP 429 and 5xx retry with exponential backoff and Retry-After; other 4xx go to `review`. At most eight attempts; ambiguous events older than 23 hours go to `review` rather than being resent after Resend's 24-hour idempotency retention. Review events are not automatically resent: check provider status first to avoid duplicates. SDK/raw provider messages, API keys and expense payloads are not stored in error fields. `sent` records provider acceptance IDs, not recipient delivery guarantees.

Administrative settings/test actions require active super-admin access and existing same-origin mutation checks. Audit contains enable/disable state and test intent only. Notification payloads contain employee names and the internal review address; the ledger should receive the same protection as the existing expense database. Existing payroll/backend role policy is unchanged.

Official references: [Next.js integration](https://resend.com/docs/send-with-nextjs), [sending API](https://resend.com/docs/api-reference/emails/send-email), [24-hour idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).
