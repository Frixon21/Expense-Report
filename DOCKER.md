# Expense Report on TrueNAS

The target is TrueNAS **25.10.0.1 at 192.168.203.180**, running one Expense Report app with a fresh database and existing external BTAuth. No TrueNAS changes, image publication or real-data migration have been performed.

## Image and HTTP runtime

`Dockerfile` builds with Node 24 on Debian slim and the committed npm lockfile. Next.js standalone output runs as unprivileged `node` (UID/GID 1000) on `0.0.0.0:3000` inside the container. Public/static assets and the backup utility/schema are included. The health check calls `/api/auth/me`; it checks the web server, not BTAuth or database health.

`.dockerignore` allowlists build inputs, excluding environment files, databases, host dependencies, archives and Git history. Secrets are runtime settings, never build arguments. `npm start` also binds `0.0.0.0`; development remains loopback-only. The approved HTTP behavior, JWT validation, roles, ownership and same-origin checks remain intact.

## TrueNAS 25.10.0.1: prefer the guided Custom App

The confirmed target is **25.10.0.1**, using Docker-based Apps. Your coworker's route is correct: **Apps > Discover Apps > Custom App** opens the guided wizard. For this single service it is simpler than YAML. The optional menu > Install via YAML route accepts Compose. These UI paths and fields are documented in the [official TrueNAS 25.10 Custom App reference](https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/installcustomappscreens/).

Once the image and missing host details are ready and installation is authorized, use this mapping:

| Wizard area | Expense Report value |
| --- | --- |
| Application Name | A chosen name such as `expense-report`; accept the wizard's app-version default. |
| Image Configuration | The built image's actual Repository and explicit Tag. Choose a pull policy appropriate to its agreed delivery route. No image is published yet. |
| Container Configuration | Leave Entrypoint/Command unset to use the image defaults. Add runtime variables from the table below, including the public origin and persistent session secret. |
| Security Context | Unprivileged; if specifying Custom User, use UID 1000 and GID 1000. Do not override to the unrelated apps UID. |
| Network | Host Network off. TCP container port 3000 to the selected free host port; use the actual approved host IP where supported. |
| Portal | HTTP, actual employee-facing host, selected host port, path `/`. |
| Storage | Writable Host Path at the actual dedicated dataset, container Mount Path `/data`; set permissions for UID/GID 1000. |

The wizard **pulls/runs an image**; it does not build the Windows checkout. The tested Linux/amd64 image now exists locally on PC-GANNON as `expense-report:verified-20261026`; it is not available on TrueNAS yet. The simplest supported wizard delivery route is an approved image registry: after separate publication authorization, tag/push this image to the agreed repository, then set that Repository and explicit Tag in Custom App. Private registry authentication, if needed, stays in the approved TrueNAS configuration. A local archive/import route is an alternative only after support and pull policy are confirmed; none has been performed. No registry upload is authorized yet.

Older SCALE 24.04 Apps use Kubernetes/pods, so these Docker instructions would not apply there; see [the older official documentation](https://www.truenas.com/docs/scale/24.04/scaletutorials/apps/usingcustomapp/). The target is now confirmed as 25.10.0.1, so no upgrade or Docker installation on TrueNAS is proposed.

## Templates and required inputs

`compose.truenas.yaml` defines one prebuilt image, a dataset bind mount and explicit LAN IP/port. It has no `build:` section: the TrueNAS YAML editor cannot use this PC's source directory as a build context. Use the tested image through an agreed registry or supported image-delivery route. No remote publication destination has been invented. The local image tag is not automatically visible on TrueNAS.

`compose.app.yaml` is a separate local build/validation template with a named volume and **localhost-only** publication. It is not the LAN installation template. Neither template starts BTAuth.

Copy `.env.docker.example` to an approved private location outside the repository/build context, then fill the required blanks:

| Setting | Required input |
| --- | --- |
| `EXPENSE_REPORT_IMAGE` | Built image reference available to TrueNAS, for its CPU architecture. |
| `TRUENAS_HOST_IP` | Confirmed: `192.168.203.180`. |
| `EXPENSE_REPORT_HOST_PORT` | Selected unused host TCP port, mapped to container port 3000. |
| `APP_PUBLIC_ORIGIN` | `http://192.168.203.180:<selected-port>`, or the exact approved employee-facing hostname with that port. No free port is assumed. |
| `EXPENSE_REPORT_DATASET_PATH` | Actual absolute pre-created dataset path, shaped `/mnt/<pool>/<dataset>`; pool and dataset are required inputs. |
| `AUTH_SESSION_SECRET` | Persistent secret of at least 32 bytes, supplied through the approved configuration process. No secret is generated or included here. |
| `FIRST_ADMIN_BOOTSTRAP_TOKEN` | Optional temporary runtime value for fresh-database administration setup below. |

The TrueNAS template retains existing non-secret settings:

```text
BT_AUTH_BASE_URL=http://192.168.203.238:3210
BT_AUTH_JWKS_URL=http://192.168.203.238:3210/.well-known/jwks.json
BT_AUTH_ISSUER=http://auth.biztechro.com
EXPENSE_REPORT_DB_PATH=/data/expense-report.sqlite
```

The app container must reach that LAN endpoint. No new BTAuth image or auth migration is required. Keep the issuer unchanged: it identifies the signer independently of the transport hostname. Optional cookie/credential field names retain application defaults. `BT_AUTH_ALLOW_HTTP` and `AUTH_TRUST_PROXY` are unused. HTTP traffic remains unencrypted within the approved internal-network boundary.

Templates deliberately fail validation while required values are missing. The TrueNAS YAML editor needs completed configuration; it does not automatically load a private `.env` from this PC. For a later authorized installation, resolve configuration locally into a protected file, without printing secrets:

```text
docker compose --env-file <private-runtime-file> -f compose.truenas.yaml config --quiet
docker compose --env-file <private-runtime-file> -f compose.truenas.yaml config --output <private-resolved-yaml>
```

Resolved YAML contains runtime secrets: keep it private, outside Git and image contexts, and enter it only through the approved TrueNAS app configuration workflow. Wait for the image route, address, port and dataset before installation.

## Fresh dataset and persistence

Create a dedicated empty dataset before installation and map its actual host path to `/data`. The template sets `create_host_path: false`, preventing a typo from silently creating an unrelated empty directory. SQLite needs read/write/create access for database and WAL/SHM files. Grant container UID/GID 1000 the necessary dataset access and parent traversal through the version's supported ACL/permissions interface. No host permissions are changed here. Official [app storage guidance](https://apps.truenas.com/getting-started/app-storage/) describes host paths and numeric run-as permissions.

Use one app instance and local dataset storage initially. Do not put the active SQLite directory on an SMB/NFS client mount or share it for employee editing. All receipts live inside SQLite alongside expenses, mileage, users, sessions and audit/history; there is no separate receipt directory. Retain the same dataset when replacing the container/image. A fresh dataset creates a fresh app database; do not copy existing PC data or seed demo records.

The image includes `scripts/backup-db.mjs` and its synthetic `--self-test`. Real backups need the existing online SQLite backup/verification workflow and an approved persistent destination. Do not copy a running database alone or lose its WAL. Dataset snapshots do not replace an application restore check. The TrueNAS backup mapping/schedule remains a deployment decision; existing PC backups and retained data stay untouched. See `OPERATIONS.md` for restore/session handling.

## First administrator on a fresh database

1. At the authorized initial installation, supply an operator-controlled temporary `FIRST_ADMIN_BOOTSTRAP_TOKEN` through private runtime configuration. This document does not generate or reveal one.
2. Sign in with the intended administrator's existing BTAuth account. Verified sign-in creates a pending Expense Report access request; it does not create a BTAuth account.
3. With bootstrap enabled and a fresh database, the waiting-for-access page offers **One-time first-admin bootstrap token** and **Bootstrap first admin**. Submit the configured value. The server activates that verified account and grants employee and super-admin roles. Payroll is an optional explicit role assigned afterward through Accounts and roles; that change is audited.
4. Remove the bootstrap value and update/recreate the app while keeping the same dataset. The database records one-time use and rejects reuse or bootstrap when an active administrator already exists.
5. The administrator approves later verified employee requests and grants payroll/admin roles explicitly.

## Verified local Linux image

Built from the current checkout using the official Node 24 Debian slim base and locked npm dependencies. The production build and TypeScript checks passed inside Docker.

- Tag: `expense-report:verified-20261026`
- Local image ID: `sha256:a0dcf3dd748930e1452b8052b5d9f19bd5544027cdee0dce1d31fbe4a58a7973`
- Platform: `linux/amd64`; inspected size: 95,004,545 bytes (about 90.6 MiB).
- 17/17 actual-container checks passed: UID 1000, localhost-only test publication, health, public/static assets, production HTTP login/cookies, pending/approved roles, same-origin and token rejection, PNG/PDF receipt ownership and byte integrity, persistence across container recreation, online backup, restored-database startup and logout.
- The packaged synthetic backup/restore self-test passed. A separate image inspection confirmed an empty `/data`, no host environment/Git/data directories, and no baked-in runtime auth settings or secrets.

All checks used an isolated mock BTAuth, synthetic data and uniquely labeled temporary Docker resources. Test containers, network and volume were removed; the tested image remains. No registry push, TrueNAS deployment, host firewall changes or real data access occurred. Linux image verification does not establish TrueNAS dataset permissions or live reachability of the external BTAuth service; those remain installation checks. The image platform matches the x86_64 family documented for [TrueNAS 25.10](https://www.truenas.com/docs/scale/25.10/gettingstarted/install/installingscale/).

## Minimal remaining inputs

1. An unused employee-facing host port, to complete `http://192.168.203.180:<port>` (or the approved hostname).
2. The actual dedicated fresh dataset path and its UID/GID 1000 access plan.
3. An approved registry/repository destination and permission for a separate image-publication step; registry access must be available to TrueNAS. No remote image exists yet.

Before installation, arrange private persistent session-secret/bootstrap delivery and backup ownership through the approved process; do not paste secrets into chat. TrueNAS version/IP, fresh data and external BTAuth/JWKS/issuer settings are already confirmed.

Email notifications are default OFF; see [RESEND.md](RESEND.md) for server-only configuration, delivery approval requirements. Never enter an API key in the app UI.

## BTAuth HTTPS migration (2026-11-03)

BTAuth login and JWKS URLs accept HTTP or HTTPS. For the migrated BTAuth service, runtime settings are:

```text
BT_AUTH_BASE_URL=https://orca.biztechro.com
BT_AUTH_JWKS_URL=https://orca.biztechro.com/.well-known/jwks.json
BT_AUTH_ISSUER=http://orca.biztechro.com
```

The issuer must exactly match BTAuth's SERVICE_ISSUER and the signed token's `iss`; it is independent of the HTTPS transport URL. Normal TLS certificate validation, manual redirects and JWT signature/claim checks remain enabled. Do not disable TLS validation to address connectivity failures.

A new image must be built from this checkout to include the validator fix; changing runtime variables or pulling the existing image does not alter its compiled code. Registry publication and production redeployment require separate authorization. Preserve existing database/receipt mounts and AUTH_SESSION_SECRET when updating the image. The earlier image verification and pre-migration endpoint examples above are historical.
## Opt-in BTAuth issuer alias (local implementation; not published)

Only after verifying that a subject identifies the same person in the migrated BTAuth database, explicitly approve that subject for the issuer alias:

```text
BT_AUTH_ISSUER=http://orca.biztechro.com
BT_AUTH_LEGACY_ISSUER=http://auth.biztechro.com
BT_AUTH_LEGACY_SUBJECTS=["d2815ea3-f16a-46bd-816e-7bcf5967b6db"]
```

The last value is a JSON array of exact, case-sensitive BTAuth subjects. No wildcard is supported. Both legacy settings must be supplied together; otherwise leave both unset. Do not enable subjects merely because their email matches. This example contains only the subject whose continuity was confirmed; other users require independent continuity checks before inclusion.

Transport URLs remain HTTPS. Fresh BTAuth JWTs must verify under the current exact issuer, signature and required claims before alias lookup. The alias selects the original legacy-issuer account with the same approved subject and corroborating email; it preserves its ID, issuer, access status, roles, records and bootstrap state. It never creates an active account or grants a role. Unknown or unapproved subjects follow normal pending-account registration.

An existing new-issuer duplicate is tolerated only while pending with no roles or business/administrative references. Its sessions, pending access request and login/access audit are retained, without merging or deleting users. Conflicts fail closed. Session reads can resolve an existing pending duplicate session to the original account after checking provider proof and current signing keys; no session row is reassigned. A successful aliased login appends an identity_issuer_alias_used audit event.

Unexpired original sessions can continue only if AUTH_SESSION_SECRET, persisted session rows, provider expiry, subject, signing key ID/thumbprint and current JWKS still validate. Expired/deleted sessions, replaced keys or lost browser cookies require sign-in. The alias does not extend expiry or bypass revocation. Keep the alias configured while legacy account rows and old session proofs depend on it; removing it stops that compatibility. No automatic database migration or cleanup is performed.

This implementation is local only. Enabling it on production is an explicit trust/configuration change requiring review and deployment authorization. It has not been added to the running local preview or previously published HTTPS-only image.
### Explicit whole-realm continuity option (local candidate only)

When the operator explicitly trusts that the migrated BTAuth realm preserves the complete old subject namespace, this alternative avoids maintaining an individual subject list:

```text
BT_AUTH_ISSUER=http://orca.biztechro.com
BT_AUTH_LEGACY_ISSUER=http://auth.biztechro.com
BT_AUTH_LEGACY_REALM_CONFIRMED=true
```

Remove/unset BT_AUTH_LEGACY_SUBJECTS in this mode. Supplying both modes, a missing legacy issuer, or a value other than the exact string true fails closed. The default remains no alias. An array containing * is still invalid.

This is an explicit trust decision: control of a matching subject in the new realm gives access to the corresponding original account and its existing roles. A new realm that reused an old UUID could therefore access that person's original records. The operator must accept continuity of the realm, not infer it from an email address. Four users were reported individually verified; extending to everyone else remains operator-trusted continuity, not independently established evidence.

Matching remains exact subject-to-subject, with email agreement as a conflict check only. Existing pending, disabled and roleless originals retain their status and roles; unknown subjects remain new pending accounts. Harmless pending duplicates are retained and can resolve to the original account. Active, privileged, business-bearing or contradictory duplicates fail closed for review. There is no email lookup, automatic merge, data deletion or role grant. The session, expiry, current-key and fresh-JWT issuer checks described above remain in force.

For a later approved production release: verify a fresh backup, publish/deploy the reviewed candidate, preserve /data and AUTH_SESSION_SECRET, retain the HTTPS endpoints, and explicitly select either subject-list mode or confirmed-realm mode. Do not create a fresh database or change BTAuth's issuer to accommodate this feature. Confirm an old admin opens the original account and existing records, then check the other users. Existing valid sessions may continue; expired, deleted or cryptographically invalid sessions still require login. No production change has been made by preparing this candidate.

### Retired duplicate Accounts visibility (local update)

The normal Accounts list omits only accounts whose issuer is the exact per-account urn:expense-report:retired-duplicate:<user-id> marker and which have a duplicate_identity_retired audit event naming that account. Ordinary disabled accounts remain visible and manageable. Retired accounts are rejected by direct access/status/role updates as well as hidden from the list. Their database rows, access decisions, business references and audit history are preserved. No new schema or production data migration is required.
