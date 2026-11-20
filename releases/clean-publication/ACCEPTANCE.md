# Habibi Lounge POS clean release candidate

Release identifier: habibi-pos-clean-20261120. Proposed repository: EricMWaimiri/habibi-pos (private, main). Publication and Git initialization require explicit owner approval. No previous Git history belongs in this export.

This is one Node/Express/Socket.IO backend serving public/ plain JavaScript, CSS and local branding. PostgreSQL/Prisma provides73 models and31 byte-preserved migrations; four SQL overlays are required. There is no separate frontend build. Dependencies are pinned by package-lock.json.

The nine Back Office sections are Dashboard, Sales, Inventory, Purchases, Expenses, Employees, Payroll, Reports and Settings. Existing Front Office orders/bills, cash/M-Pesa/partial payments, pricing adjustments, returns, stock/recipes, suppliers/receiving, expenses, employee finance, payroll, reports and printing remain in this same application. Secure HttpOnly sessions, CSRF, revocation, current effective/custom permissions and audited approvals remain enabled.

Install from a new empty separately authorized database only. Read scripts/installation/README.md and PROVISIONING.md. Preserve original SQL bytes. Migration16 is prepared using the target-bound bundle procedure, never edited in canonical source or deployed directly to a fresh target. Apply the four reviewed overlays and exact per-object grants. Generate the matching Client locally; supply new secrets through external private configuration. The Windows foreground launcher creates no permanent task/service/network change. Default printing is dry-run.

Business policies: Africa/Nairobi; default proposed business day09:00 to09:00, prospective audited activation; shared Bar/Kitchen stock pool with separate routing; actual calendar-day segmented salary calculation; payroll expense accrual at approval and liability settlement at payment; controlled recoveries, no fabricated collections; manager-permitted discounts through100% and audited pricing/refunds. Statutory deductions and global period closure remain inactive. No inherited customer debts/employee advances are required at launch.

Safety: do not modify existing/protected databases, replay installed migrations, weaken permissions, infer historical provenance, commit secrets, configure network/Tailscale/firewall, deploy or publish without explicit approval. Use disposable synthetic-only environments for integration tests. No production or TEST database contents, credentials or private printer routes are included.

Verification: retained accepted fresh-empty31-migration/four-overlay install, schema diff, secure single-administrator initialization and independent queued approval concurrency evidence. Previous release-only export installed dependencies, generated its own Client, and passed245 focused cases. New clean-export checks are recorded in releases/clean-publication/VERIFICATION.md. These are software-scope results; they do not imply owner visual or operational acceptance.

Remaining gates: owner visual branding/pricing/document/responsive review; independent unauthorized Tailscale identity test; real payment-provider verification; Windows lounge installation, secrets/certificates, tablet LAN/Wi-Fi, remote access policy, physical network/USB/receipt/Bar/Kitchen printers, reboot/recovery, real catalogue/staff/stock/supplier/float setup and operational closeout. No historical business balances may be invented.

Historical raw logs, database inventory, local addresses/identities, failed proposals, screenshots, dumps and old release packages remain in the original workspace only. Their omission from this new repository does not delete them. Maintainers must not use stale local migration scripts against existing installations.
