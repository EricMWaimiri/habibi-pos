'use strict';
// Single permission catalog/default source; no database or application config.
const { Role } = require('@prisma/client');

const PERMISSIONS = [
  { key: 'sales.make', label: 'Make sales', category: 'Sales' },
  { key: 'sales.view_all', label: 'View all sales', category: 'Sales' },
  { key: 'sales.merge', label: 'Merge bills', category: 'Sales' },
  { key: 'sales.split', label: 'Split bills', category: 'Sales' },
  { key: 'sales.discount', label: 'Apply discounts', category: 'Sales' },
  { key: 'sales.change_price', label: 'Change prices', category: 'Sales' },
  { key: 'sales.complimentary', label: 'Mark complimentary', category: 'Sales' },
  { key: 'sales.void', label: 'Void sales', category: 'Sales' },
  { key: 'sales.remove_item', label: 'Remove sale items', category: 'Sales' },
  { key: 'sales.return', label: 'Process returns', category: 'Sales' },
  { key: 'receipt.print', label: 'Print receipts', category: 'Receipts' },
  { key: 'receipt.reprint', label: 'Reprint receipts', category: 'Receipts' },
  { key: 'pay.mpesa', label: 'Receive M-Pesa', category: 'Payments' },
  { key: 'pay.cash', label: 'Receive cash', category: 'Payments' },
  { key: 'pay.void', label: 'Void payments', category: 'Payments' },
  { key: 'pos.summary', label: 'View POS summary', category: 'POS' },
  { key: 'pos.see_stock', label: 'See stock in POS', category: 'POS' },
  { key: 'stock.view', label: 'View stock', category: 'Inventory' },
  { key: 'stock.receive', label: 'Receive stock', category: 'Inventory' },
  { key: 'stock.adjust', label: 'Adjust stock', category: 'Inventory' },
  { key: 'stock.adjust_approve', label: 'Approve stock adjustments', category: 'Inventory' },
  { key: 'stock.count', label: 'Perform stock counts', category: 'Inventory' },
  { key: 'stock.count_approve', label: 'Approve stock counts', category: 'Inventory' },
  { key: 'purchases.manage', label: 'Manage purchases', category: 'Purchases' },
  { key: 'purchases.void', label: 'Void purchases', category: 'Purchases' },
  { key: 'expenses.manage', label: 'Manage expenses', category: 'Expenses' },
  { key: 'expenses.approve', label: 'Approve expenses', category: 'Expenses' },
  { key: 'expenses.void', label: 'Void expenses', category: 'Expenses' },
  { key: 'expense_categories.manage', label: 'Manage expense categories', category: 'Expenses' },
  { key: 'products.manage', label: 'Manage products', category: 'Products' },
  { key: 'users.manage', label: 'Manage staff', category: 'Staff' },
  { key: 'permissions.manage', label: 'Manage permissions', category: 'Staff' },
  { key: 'commissions.manage', label: 'Manage commissions', category: 'Staff' },
  { key: 'commissions.void', label: 'Void commissions', category: 'Staff' },
  { key: 'shifts.manage', label: 'Manage shifts', category: 'Shifts' },
  { key: 'settings.manage', label: 'Manage settings', category: 'Settings' },
  { key: 'printers.manage', label: 'Manage printers', category: 'Settings' },
  { key: 'dashboard.view', label: 'View dashboard', category: 'Reports' },
  { key: 'reports.sales', label: 'View sales reports', category: 'Reports' },
  { key: 'reports.inventory', label: 'View inventory reports', category: 'Reports' },
  { key: 'reports.financial', label: 'View financial reports', category: 'Reports' },
  { key: 'payments.view_collected', label: 'View collected payments', category: 'Payments' },
];

// Descriptive availability only. Never use this metadata to resolve grants or
// gate routes: stored keys, defaults and effective authorization stay intact.
const CAPABILITIES = {
  'sales.make': ['available', 'New order and add items, subject to ownership and current bill eligibility.'],
  'sales.view_all': ['available', 'Browse all orders; mutation and sensitive-data grants remain separate.'],
  'sales.merge': ['available', 'Merge compatible unpaid bills from the same open shift and current accounting date.'],
  'sales.split': ['available', 'Split selected whole unpaid lines in the same current open originating shift; paid/partial bills are rejected. Discounts, commission entitlement and original stock provenance are preserved.'],
  'sales.discount': ['partial', 'Audited fixed/percentage bill and item pricing preview implemented; posting requires reviewed pricing storage and TEST integration acceptance. Manager with this grant needs no independent approver.'],
  'sales.change_price': ['partial', 'Audited item-price preview with explicit zero-price acknowledgement; posting requires reviewed pricing storage and TEST integration acceptance.'],
  'sales.complimentary': ['planned', 'Unavailable: no complimentary-sale workflow.'],
  'sales.void': ['available', 'Cancel verified unpaid bills with reason, explicit open shift and manager/delegate approval policy; paid bills use separate returns.'],
  'sales.remove_item': ['available', 'Remove a whole verified unpaid line with reason, open recording shift and approval policy; retain at least one active item.'],
  'sales.return': ['available', 'Original-value partial paid returns with exact stock restoration, explicit recording shift and required manager approval. M-Pesa payouts are handled externally.'],
  'receipt.print': ['available', 'Automatic customer receipts during order creation and item addition; order authorization is also required.'],
  'receipt.reprint': ['partial', 'Sales and purchase invoice document reprints are permission checked. Payment receipt reprints remain unavailable; no print counter or financial posting is inferred.'],
  'pay.mpesa': ['available', 'Receive M-Pesa with unique references and an explicit receiving-shift choice.'],
  'pay.cash': ['available', 'Receive cash against an explicitly selected open shift.'],
  'pay.void': ['available', 'Audited recorded-payment reversals with explicit open shift, approval, retained original records and duplicate protection. No external refund is sent.'],
  'pos.summary': ['planned', 'Unavailable: no separate POS summary. Order totals follow authorized order access.'],
  'pos.see_stock': ['planned', 'Unavailable: no stock-quantity display in New order. Inventory access is separate.'],
  'stock.view': ['available', 'Inventory quantities; unit costs additionally require reports.financial.'],
  'stock.receive': ['available', 'Receive stock using the Inventory action and product selector.'],
  'stock.adjust': ['available', 'Record a stock adjustment with a reason, subject to counting pauses.'],
  'stock.adjust_approve': ['planned', 'Unavailable: no separate stock-adjustment approval workflow.'],
  'stock.count': ['available', 'Physical counting sessions, explicit quantities, submission, extension and discard; no financial grant needed.'],
  'stock.count_approve': ['available', 'Review submitted counts and approve their fixed variance once.'],
  'purchases.manage': ['partial', 'Audited supplier invoices, drafts, statements, payments, credits and controlled corrections are implemented. Separate partial goods receiving requires the reviewed receiving storage and feature configuration. Historical records are not rewritten.'],
  'purchases.void': ['available', 'Audited corrections or eligible unallocated invoice cancellation and verified stock receipt reversal; consumed stock requires a controlled partial return.'],
  'expenses.manage': ['available', 'Record and list outgoing expenses; cash requires an explicit open receiving shift.'],
  'expenses.approve': ['planned', 'Unavailable: no expense approval workflow.'],
  'expenses.void': ['available', 'Audited operating expense reversal, with explicit current shift and manager/delegate approval; legacy unclassified purchase expenses require review.'],
  'expense_categories.manage': ['available', 'Create, edit and deactivate controlled expense categories. Used classifications and historical expense snapshots are preserved.'],
  'products.manage': ['partial', 'Catalog reads and permission-controlled product/category/recipe administration are implemented. Editing requires the reviewed Core Administration storage and enabled configuration; stock balances use the separate inventory controls.'],
  'users.manage': ['available', 'Staff administration under protected-account, delegation and self-edit restrictions.'],
  'permissions.manage': ['available', 'Manager-only role permission matrix. Mandatory manager grants cannot be disabled.'],
  'commissions.manage': ['partial', 'Commission reports and earned snapshots preserve original sale attribution. Staff-rate editing uses users.manage; selected verified commissions integrate with the approved payroll lifecycle and explicit payroll permissions.'],
  'commissions.void': ['available', 'Required in addition to financial action grants for event-based commission corrections on eligible voids/returns; original earned snapshots remain immutable.'],
  'shifts.manage': ['available', 'Shift history and closing other staff shifts. Own-close payment grants do not authorize closing others.'],
  'settings.manage': ['available', 'Back Office business/document preferences, new stock-count session duration and scoped audit history. Does not grant printer targets, staff administration or permission changes.'],
  'printers.manage': ['partial', 'Audited private-network receipt/docket destination configuration on raw TCP 9100. Physical printing activation and waitress-specific mappings remain deployment managed; no printer test job.'],
  'dashboard.view': ['available', 'Management dashboard entry; each section additionally requires its existing sales, financial, collection, commission, shift or inventory grants.'],
  'reports.sales': ['available', 'Daily Sales and outstanding balances; collections and costs require their separate grants.'],
  'reports.inventory': ['partial', 'Current quantities and dated movement summaries additionally require stock.view or stock.count. Historical valuation and inferred shifts remain unavailable.'],
  'reports.financial': ['available', 'Profit and loss. Daily Sales costs also need reports.sales; inventory costs also need inventory access.'],
  'payments.view_collected': ['available', 'Searchable, paginated collection history by actual date/receiving shift; payment details in authorized sale responses. Daily Sales collections additionally require reports.sales.'],
};
const ACCOUNTING_PERMISSIONS=[["purchases.view","View purchase invoices"],["purchases.approve","Approve purchase invoices"],["suppliers.view","View suppliers"],["suppliers.manage","Manage suppliers"],["supplier_payments.manage","Record and allocate supplier payments"],["supplier_payments.void","Reverse supplier payments"],["supplier_credits.manage","Manage supplier credits"],["supplier_returns.approve","Approve supplier stock returns"],["accounting.view","View accounting reports and audit"],["accounting.export","Export financial data"],["accounting.approve","Approve accounting requests"],["accounting.correct","Correct accounting records and allocations"],["accounting.opening","Record authorized supplier opening balances"],["accounting.documents","Manage accounting drafts"],["accounting.settings","Manage accounting settings"]];
for(const [key,label]of ACCOUNTING_PERMISSIONS){PERMISSIONS.push({key,label,category:'Accounting',disabledByDefault:true});CAPABILITIES[key]=['available','Audited supplier/accounting workflow; backend permission, current explicit shift and approval rules remain mandatory. New grants are disabled by default.'];}
const EMPLOYEE_FINANCE_PERMISSIONS=[['receivables.view','View employee receivables','Receivables'],['receivables.manage','Allocate incoming receipts and clear bills','Receivables'],['receivables.correct','Reverse employee payment allocations','Receivables'],['tips.allocate','Allocate employee tips','Payments'],['employee_reconciliation.view','View employee reconciliation','Employees'],['employee_finance.export','Export employee finance','Employees'],['employee_advances.manage','Record employee advances','Payroll'],['payroll.view','View payroll','Payroll'],['payroll.manage','Create payroll drafts','Payroll'],['payroll.review','Review payroll','Payroll'],['payroll.approve','Independently approve payroll','Payroll'],['payroll.confirm','Confirm payroll deductions','Payroll'],['payroll.pay','Record and complete payroll payouts','Payroll']];
for(const [key,label,category] of EMPLOYEE_FINANCE_PERMISSIONS){PERMISSIONS.push({key,label,category,disabledByDefault:true});CAPABILITIES[key]=['partial','Audited employee-finance and payroll workflows are implemented with reviewed storage and feature configuration. Fresh explicit grants, current-session checks and independent approvals remain mandatory. Disabled by default.'];}
for (const permission of PERMISSIONS) {
  const [status, description] = CAPABILITIES[permission.key];
  permission.capability = Object.freeze({ status, description });
}

const DEFAULTS = {
  WAITER: [],
  CASHIER: [],
  MANAGER: PERMISSIONS.filter(permission=>!permission.disabledByDefault).map((permission) => permission.key),
};

const ROLE_VALUES = Object.values(Role);
const MANDATORY_MANAGER_PERMISSIONS = Object.freeze(['permissions.manage', 'users.manage']);

module.exports = { PERMISSIONS, DEFAULTS, ROLE_VALUES, MANDATORY_MANAGER_PERMISSIONS };
