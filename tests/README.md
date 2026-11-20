# Portable acceptance tests

The19 focused files in RELEASE-TESTS.json plus transitive fixtures form the database-free default npm test suite (245 accepted cases). Tests use explicitly synthetic records, example hosts/private-address literals and ephemeral secrets; these are not deployment settings or real accounts.

installation-bootstrap-runtime.cjs and installation-approval-concurrency.cjs are additional guarded disposable integration harnesses requiring external configuration and a separately authorized empty database. They are not lounge seed commands. Historical tests requiring archived snapshots/workspace tools remain only in the original workspace.
