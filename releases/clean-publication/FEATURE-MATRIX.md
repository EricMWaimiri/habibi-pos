# Functional source and acceptance matrix

This clean repository contains the accepted application implementation. Retained passing evidence is software-scoped; owner visual and physical/operational gates remain distinct.

| Area | Included functionality | Source | Evidence |
|---|---|---|---|
| Login/security | PIN, HttpOnly sessions, CSRF, revocation, effective/custom RBAC, audited approvals | src/controllers/auth.controller.js, src/middlewares/, src/utils/ | Focused session/socket tests and retained real HTTPS acceptance |
| Front Office/Sales | Product/cart/orders/bills, Cash/M-Pesa, partial allocation, discount/override/return/correction, receipt/invoice | public/app.js, src/controllers/, src/routes/ | Retained backend/browser/pricing acceptance plus focused245 suite |
| Dashboard/Reports | KPIs, accounting periods, reports, CSV, staff/product/category summaries | public/app.js, src/controllers/, src/utils/ | Retained financial reconciliation and desktop/responsive acceptance |
| Inventory | Shared stock pool, recipes, counts/movements, Bar/Kitchen classifications/routing | src/controllers/, src/utils/ | Retained stock/COGS/concurrency acceptance |
| Purchases | Suppliers, full invoice liability, independent partial goods receipts, payments/credits/returns | src/controllers/, prisma/ | Retained clean accounting/receiving acceptance |
| Expenses | Controlled categories, idempotency, approval/correction, audit | src/controllers/, prisma/ | Retained accounting acceptance |
| Employees | Payroll-only employees, profiles/history, dated attendance, bills/tips/advances/commissions | src/controllers/, src/utils/ | Retained employee/core integration and focused salary/allocation tests |
| Payroll | Calendar-day segments, accrual approval, corrections, deductions/recoveries, partial payments, payslips | src/controllers/, src/utils/, prisma/ | Retained integration/reconciliation plus focused calculation/document tests |
| Settings | Existing nine-section navigation, custom-role permissions, printing/branding preview, prospective shifts/business day | public/app.js, src/controllers/ | Retained browser/authorization/business-day tests |
| Printing/branding | Local full/compact/icons/monochrome, receipts/invoices/payslips/reports, dry-run dockets | public/assets/branding/, src/utils/ | Focused assets/print/payslip tests; physical output and final logo appearance pending |
| Installation |31 migrations/73 models/four overlays, target-bound16, restricted grants, one-time admin, foreground start, backup | prisma/, scripts/installation/ | Prior empty DB installation; independent export checks in VERIFICATION.md |

No standalone purchase-order system, separate Bar/Kitchen stock balances, statutory calculations or activated global closure is claimed. No new financial policies introduced. Review contextual API actions and approved business rules before extending behavior.
