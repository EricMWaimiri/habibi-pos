# New database and role provisioning

This is a reviewed setup procedure, not execution authorization. Choose NEW database, migration-role and runtime-role names on the lounge PC; verify they do not exist and approve the cluster, server port and authentication policy first. Never reuse DEV, TEST or rehearsal roles/data. Keep the DBA connection out of the application.

In an interactive `psql -X -v ON_ERROR_STOP=1` DBA session, set the three **non-secret** psql variables `database`, `migration_role`, and `runtime_role` to the approved lowercase SQL identifiers. Verify `SELECT system_identifier FROM pg_control_system();`, the server address/port and existing `pg_database`/`pg_roles` metadata before proceeding. Stop on any mismatch or existing object. Create only the new objects:

```sql
CREATE ROLE :"migration_role" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"runtime_role" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE :"database" OWNER :"migration_role" ENCODING 'UTF8' TEMPLATE template0;
REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO :"migration_role", :"runtime_role";
```

Set both passwords with psql's interactive `\password` command for each approved role, which prompts privately. Confirm server `password_encryption` is `scram-sha-256`; never put passwords in SQL files, command arguments, Git, transcripts or chat. Role creation and CREATE DATABASE cannot be treated as one rollback-able transaction: stop on failure, preserve newly created objects and diagnose; never automatically drop/recreate them.

Connect the DBA explicitly to the new database, reverify database name/OID and cluster, then establish only its migration ownership and identity-check access:

```sql
ALTER SCHEMA public OWNER TO :"migration_role";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO :"migration_role";
```

Record the new database OID. Build target.json from this actual identity with database, role, runtimeRole, oid, cluster and port. Back up and verify the empty database before approved installation, then follow README.md to prepare31 migrations, inspect SQL, install, apply four exact overlays and seven reviewed per-object grant files. Runtime never receives schema ownership/CREATE, database CREATE/TEMP, memberships, broad DELETE/TRUNCATE or mutable-journal rights. Verify the complete effective privilege matrix afterwards, including column grants and function invoker rights.

HBA configuration is a separate owner approval. The minimal model is database-and-two-role-specific loopback SCRAM entries for IPv4/IPv6, followed by IPv4/IPv6 rejects for those two roles on every other database. They must precede broader matching entries. Use exact actual identifiers, back up the active HBA bytes/hash, inspect includes/order, validate and reload without a restart only after authorization. On failure restore the exact approved HBA backup; do not automatically delete roles/databases. No shared development HBA modification is needed or authorized by this guide.

Verify correct/wrong/missing password behavior; cross-database rejection; runtime CREATE/ownership/immutable-write rejection; required per-table operations and existing connection preservation. Do not test access to protected databases by authenticating with administrative roles. Generate the matching73-model Client locally, bootstrap the first manager once via the secure prompt, then remove migration credentials from the runtime process.

Backup uses the portable `Backup-Database.ps1` with explicit database/OID/cluster, loopback PG environment and a new private destination. The legacy hardcoded backup/provisioning/repair scripts are not the current installation procedure. Recovery always requires a verified backup and explicit target/recovery authorization; no automatic restore/reset or manual Prisma-history edits.
