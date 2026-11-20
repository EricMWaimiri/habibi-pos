# Controlled fresh Windows installation

This guide prepares a NEW empty database only. It is not permission to install, change shared HBA, run migrations against DEV/TEST, or deploy. Never transfer demonstration users, credentials, transactions or generated clients. Keep original migration source bytes and the installation manifest permanently with the backup records.

## Prerequisites and review

Use the proposed release manifest; Node24.22/npm11.19 and PostgreSQL18.4 were tested with lockfile Prisma6.19.3. Install PostgreSQL client tools/psql and verify vendor binaries. Owner approves exact new DB, migration/runtime roles, loopback port, cluster/OID and any authentication/service configuration separately. SCRAM only; no trust/broad access. Roles LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS, no memberships. Migration role owns its public schema/objects only. Runtime must not own objects or receive CREATE/TEMP/DELETE/TRUNCATE/immutable journal UPDATE. Revoke PUBLIC database CONNECT/TEMP only on the newly authorized database as reviewed. The migration identity needs narrowly scoped EXECUTE on pg_catalog.pg_control_system() in this new DB to verify the cluster; runtime does not.

Before any write verify current_database(), current_user, pg_database.oid, inet_server_addr()/port and pg_control_system().system_identifier against the separately reviewed target. Capture an empty/schema baseline. Use pg_dump -Fc to a NEW private file and pg_restore --list plus a full decode to a private SQL file; verify successful exit and SHA256, disk space and documented restore command. Never overwrite an existing backup. No automatic restore/drop is permitted on failure.

## Prepare files (no SQL execution)

Create a non-secret external target.json containing database, role (migration identity), runtimeRole, oid, cluster (decimal string), port. Examples in test receipts identify only a disposable target, not lounge credentials. From the release root:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
node scripts/installation/prepare-installation.cjs prisma C:\HabibiInstall\prepared C:\HabibiInstall\target.json
```

Destination must not exist. Review every prepared migration, grants SQL and INSTALLATION-MANIFEST.json. Exactly31 original source entries; only migration16's historical database/role condition is rebound to exact database/role/OID/cluster. Thirty other files remain byte-exact. Original source16 checksum stays in SOURCE-MANIFEST; Prisma records actual executed16 checksum. Do not relabel it with the original hash or alter installed history. Prepared bundle is pinned to its database OID/cluster and cannot be copied to another target without preparing/reviewing anew.

## Controlled execution after separate authorization

Configure DATABASE_URL for the migration identity privately in the current process; never type credentials into a logged command/transcript or commit an environment file. PSQL_PATH may specify the full PostgreSQL psql.exe location. Review and authorize the following before executing:

```powershell
$env:POS_FRESH_INSTALL_APPROVED='YES'
node scripts/installation/deploy-prepared.cjs C:\HabibiInstall\prepared
Remove-Item Env:POS_FRESH_INSTALL_APPROVED
```

The wrapper verifies all31 executed bytes/schema, URL identity/port and empty public objects, role flags and actual cluster/OID before Prisma deploy. It refuses an existing installation; do not use it for upgrades or repairs. Save complete stdout/stderr in private diagnostics without connection secrets. Verify31 successful Prisma rows/checksums, no unresolved rows, expected73 tables/schema objects and zero business data. Run `prisma migrate diff --from-url`/`--to-schema-datamodel` with private connection handling appropriate to the installed CLI; do not expose a URL in process arguments. A generated small Node/Prisma driver or externally provided datasources avoids credential-bearing command lines.

Apply the four reviewed overlay files through psql with `-X -v ON_ERROR_STOP=1 --single-transaction -f <file>` after31 and before runtime use, in this order:

1. releases/core-functionality/ADVANCE-GUARD-FIX.sql
2. releases/core-functionality/PAYROLL-SOURCE-GUARD-FIX.sql
3. releases/core-functionality/receiving-business-day/RECEIPT-GUARD-FIX.sql
4. releases/core-functionality/receiving-business-day/SHIFT-UTC-GUARD-FIX.sql

Use separately configured PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD or a protected pgpass file, never password arguments. Verify each overlay SHA256 against RELEASE-INVENTORY and function definitions/ownership/invoker rights afterwards. Review then apply prepared grants/0 through6 in numeric order using the same whole-file transactional psql runner. No grants are implied by preparing files. Recheck object privileges and negative runtime operations, wrong/missing password and unrelated database rejection.

```powershell
node node_modules/prisma/build/index.js generate --schema C:\HabibiInstall\prepared\schema.prisma
```

Generate locally, do not ship node_modules/.prisma. Verify the73-model schema diff is empty. Generate only the accepted73-model Client for this31-migration installation.

## Secure first administrator

Before any business/user data exists, keep migration DATABASE_URL private and set a newly generated PIN_PEPPER externally. Securely retain this pepper for runtime/recovery; changing it invalidates PIN verification. Use the same generated Client. The manifest must include reviewed target cluster/role/port/OID:

```powershell
powershell -NoProfile -File scripts/installation/initialize-admin.ps1 -Manifest C:\HabibiInstall\prepared\INSTALLATION-MANIFEST.json
```

The display name and six-digit PIN are prompted locally; PIN confirmation is hidden and passed through anonymous stdin. No hardcoded PIN, public endpoint, secret logs or temporary plaintext file. It pins identity/history, locks initialization, refuses nonempty business tables and creates one audited MANAGER. Repeated/concurrent calls cannot silently add another administrator. Do not reuse demonstration PINs. Remove migration access from the application process after bootstrap; preserve it offline for authorized maintenance. Server initializes permission definitions without overwriting existing grants; manager reviews feature permissions through existing Settings. No role-default expansion is automatic.

## Runtime, printing and smoke

Fill .env.example externally with NEW private secrets, restricted runtime URL and matching POS_DATABASE_NAME/POS_RUNTIME_ROLE/POS_DATABASE_PORT. Set only valid approved HTTPS origins; omit unused origin variables rather than leaving blank. Use existing hardened HTTPS gateway/proxy procedure, not public forwarding. Keep backend loopback. Global closure/statutory deductions and business-day activation remain inactive until approved operational setup.

```powershell
powershell -NoProfile -File scripts/installation/Start-POS.ps1 -ConfigFile C:\HabibiPrivate\runtime.env
```

Foreground startup creates no task/service/firewall rule. It launches existing src/server.js; frontend is served by Express, no separate frontend build. No missing private printer config blocks startup: default is DRY_RUN. Optional POS_PRINTER_CONFIG points to an absolute external JSON based on printers.json.example. Existing legacy config/printers.js remains supported but must never enter Git. Validate actual device routes separately before setting DRY_RUN false. Physical/raster compatibility still requires onsite tests.

Verify anonymous401, CSRF403, Secure HttpOnly login, auth/RBAC, logout/replay401, exact assets, reports/financial reconciliation, synthetic sale/payment/stock and delegated approvals in an authorized disposable environment first. Reusable independent race tests require explicit POS_DISPOSABLE_ACCEPTANCE=YES and external POS_ACCEPTANCE_HOME/CLIENT; they are not production seed scripts. No synthetic data is imported into the lounge DB. Browser rendering/owner visual/hardware/setup remain distinct acceptance gates.

## Recovery

Stop on identity, hash, SQL, privilege, schema or reconciliation failure. Preserve originating PostgreSQL/Prisma output and installed history; never automatically retry, resolve, reset, drop or restore. For a reviewed restore, stop only the new application, verify backup SHA/source/target and authorization, then use pg_restore against the exact separately authorized recovery target. Do not overwrite any preserved database. A failed migration requires an evidence-based supported Prisma recovery plan; no manual _prisma_migrations edits. Keep manifests/overlays/roles/grants/config recovery material with private backups, including encrypted secret recovery, and test restore before operational launch.

Reusable tests/installation-bootstrap-runtime.cjs requires POS_DISPOSABLE_BOOTSTRAP_ACCEPTANCE=YES, POS_ACCEPTANCE_HOME, POS_ACCEPTANCE_CLIENT and an external private.json (database, oid, cluster, port, migrationRole/migrationPassword, runtimeRole/runtimePassword, newly generated pin and pepper). Place the reviewed INSTALLATION-MANIFEST.json alongside it. It refuses the shared cluster and requires an EMPTY disposable target. It creates only synthetic acceptance records; never run on a lounge installation.


This clean export is self-contained; root prisma is the accepted installation source. No original development workspace is needed.
