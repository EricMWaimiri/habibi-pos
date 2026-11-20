const response = require('../utils/responses');
const prisma = require('../config/prisma');
const F = require('../utils/filters');
const { saleScope, classifyExpenses, collectionEvents } = require('../utils/reporting-scope');
const { z } = require('zod');


const correctionScope=f=>F.and(require('../utils/business-day-context').eventScope(f),f.shiftId?{shiftId:F.id(f.shiftId)}:{},
 {sale:saleScope({...f,range:undefined,shiftId:undefined})});

const delta=(s,key)=>s.financialAdjustments.reduce((n,a)=>n+Number(a[key]),0);

// ---------- helpers ----------

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const DAY_MS = 24 * 60 * 60 * 1000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const { isRealDate, nairobiDayBounds } = require('../utils/accounting');

// From the start of the first day to the end of the last day (Nairobi time)
function nairobiRangeBounds(startStr, endStr) {
  if (!isRealDate(startStr) || !isRealDate(endStr)) throw httpError(400, 'Invalid date');
  if (endStr < startStr) throw httpError(400, 'The end date must not be before the start date');
  const start = nairobiDayBounds(startStr).start;
  const end = nairobiDayBounds(endStr).end;
  if ((end - start) / DAY_MS > 366) throw httpError(400, 'Choose a period of one year or less');
  return { start, end };
}

// Today's date in Nairobi, as YYYY-MM-DD.
function nairobiTodayString() {
  const now = new Date();
  return require('../utils/business-day-context').dateForRow(now,null);
}

// "Record Purchase" also creates an expense. That money is already counted as the
// cost of the goods when they are sold, so it must not be counted twice in the P&L.
// Purchase classification uses immutable links; uncertain legacy amounts stay explicit.

// ---------- validation ----------

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const DAILY_REPORT_SCHEMA = z.object({
  query: z.object({ date: DATE.optional(), balances: z.enum(['cutoff', 'current']).default('cutoff') }),
});

const PNL_REPORT_SCHEMA = z.object({
  query: z.object({ start: DATE.optional(), end: DATE.optional(), date: DATE.optional() }),
});

const COMMISSIONS_SCHEMA = z.object({
  query: z.object({ start: DATE.optional(), end: DATE.optional(), date: DATE.optional() }),
});

// ---------- handlers ----------

async function dailyReportData(req, db) {
  const f=F.filters(req.query,{today:nairobiTodayString()});
  const dateStr = f.date || f.first;
  if (!isRealDate(dateStr)) throw httpError(400, 'Invalid date');
  const { gte:start, lt:end } = f.range;

  const sales = await db.sale.findMany({
    where: {
      status: { notIn: ['CANCELLED', 'MERGED'] },
      ...saleScope(f),
    },
    select: {
      id: true,
      status: true,
      total: true,
      createdAt: true,
      waiter: { select: { id: true, name: true } },
      items: { where: { removedAt: null }, select: { quantity: true, unitCost: true, subtotal: true } },
      accountingDate: true,
      financialAdjustments:{where:req.validated.query.balances==='current'?{}:{createdAt:{lt:end}}},
      payments: { where: req.validated.query.balances === 'current' ? {} : { createdAt: { lt: end } }, select: { method: true, amount: true } },
    },
  });

  let totalSales = 0;
  let totalPaid = 0;
  let cohortOutstanding=0;
  let totalCost = 0;
  let countPaid = 0;
  let countPartial = 0;
  let countUnpaid = 0;

  const waiterBuckets = new Map();

  for (const sale of sales) {
    const orderTotal = Number(sale.total)+delta(sale,'salesDelta');
    const orderCost = sale.items.reduce(
      (sum, it) => sum + Number(it.unitCost) * Number(it.quantity),
      0
    );
    const orderPaid = sale.payments.reduce((sum, p) => sum + Number(p.amount), 0)+delta(sale,'collectionDelta');
    cohortOutstanding+=orderTotal-orderPaid;

    totalSales += Number(sale.total);
    totalPaid += orderPaid;
    totalCost += orderCost;

    if (orderPaid >= orderTotal) countPaid++;
    else if (orderPaid > 0) countPartial++;
    else countUnpaid++;

    const key = sale.waiter ? sale.waiter.id : 'counter';
    const name = sale.waiter ? sale.waiter.name : 'Counter (no waitress)';
    if (!waiterBuckets.has(key)) {
      waiterBuckets.set(key, { userId: key, name, orders: 0, total: 0, paid: 0, cost: 0 });
    }
    const wb = waiterBuckets.get(key);
    wb.orders += 1;
    wb.total += Number(sale.total);
    wb.paid += orderPaid;
    wb.cost += orderCost;
  }

  const periodCorrections=await db.financialAdjustment.findMany({where:correctionScope(f),include:{sale:{select:{waiter:{select:{id:true,name:true}}}}}});
  for(const a of periodCorrections){totalSales+=Number(a.salesDelta);totalCost+=Number(a.costDelta);const w=a.sale.waiter,key=w?.id||'counter';if(!waiterBuckets.has(key))waiterBuckets.set(key,{userId:key,name:w?.name||'Counter (no waitress)',orders:0,total:0,paid:0,cost:0});const bucket=waiterBuckets.get(key);bucket.total+=Number(a.salesDelta);bucket.cost+=Number(a.costDelta);}
  // Money RECEIVED on this day, whichever day the order was taken
  const received = await collectionEvents(db,f);
  const methodBuckets = new Map();
  for (const p of received) {
    methodBuckets.set(p.method, (methodBuckets.get(p.method) || 0) + Number(p.amount));
  }

  const waiters = [...waiterBuckets.values()]
    .map((w) => ({
      userId: w.userId,
      name: w.name,
      orders: w.orders,
      total: round2(w.total),
      paid: round2(w.paid),
      cost: round2(w.cost),
      profit: round2(w.total - w.cost),
    }))
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId));

  // All outstanding bills through the selected cutoff, including older debts.
  // Current balance is an explicit alternate view, never an implicit fallback.
  const debts = await db.sale.findMany({ where: { status: { notIn: ['CANCELLED','MERGED'] }, createdAt: { lt: end }, AND:[saleScope({...f,range:undefined})] },
    select: { total: true, accountingDate: true, financialAdjustments:{where:req.validated.query.balances==='current'?{}:{createdAt:{lt:end}}}, payments: { where: req.validated.query.balances === 'current' ? {} : { createdAt: { lt: end } }, select: { amount: true } } } });
  const outstanding = debts.reduce((sum, s) => sum + Number(s.total)+delta(s,'salesDelta') - s.payments.reduce((n,p) => n + Number(p.amount), 0)-delta(s,'collectionDelta'), 0);
  return response.daily({
    balanceView: req.validated.query.balances || 'cutoff',
    cutoffExclusive: end,
    outstanding: round2(outstanding),
    provenance: { unverifiedSales: sales.filter(s => !s.accountingDate).length, unverifiedOutstandingBills: debts.filter(s => !s.accountingDate).length,
      inconsistentReceiptCount: received.filter(p => ['CANCELLED','MERGED'].includes(p.sale.status)).length },
    unassignedMpesa: round2(received.filter(p => p.method === 'MPESA' && !p.receivedShiftId).reduce((n,p) => n + Number(p.amount), 0)),
    collectionShifts: [...new Set(received.map(p => p.receivedShiftId))].sort((a,b) => String(a ?? '').localeCompare(String(b ?? ''))).map(shiftId => ({ shiftId,
      CASH: round2(received.filter(p => p.receivedShiftId === shiftId && p.method === 'CASH').reduce((n,p) => n + Number(p.amount), 0)),
      MPESA: round2(received.filter(p => p.receivedShiftId === shiftId && p.method === 'MPESA').reduce((n,p) => n + Number(p.amount), 0)) })),
    date: dateStr, period:{start:f.first,end:f.last},
    orders: { total: sales.length, paid: countPaid, partial: countPartial, unpaid: countUnpaid },
    totals: {
      sales: round2(totalSales),
      paid: round2(totalPaid),
      outstanding: round2(cohortOutstanding),
      cost: round2(totalCost),
      profit: round2(totalSales - totalCost),
    },
    waiters,
    payments: {
      CASH: round2(methodBuckets.get('CASH') || 0),
      MPESA: round2(methodBuckets.get('MPESA') || 0),
    },
  }, req.permissions);
}

async function pnlReportData(req, db) {
  const f=F.filters(req.query);
  if(!f.range)throw httpError(400,'Choose a business date or complete date range');
  const start=f.first,end=f.last,range={start:f.range.gte,end:f.range.lt};

  const sales = await db.sale.findMany({
    where: {
      status: { notIn: ['CANCELLED', 'MERGED'] },
      ...saleScope(f),
    },
    select: {
      accountingDate: true,
      total: true,
      items: { where: { removedAt: null }, select: { quantity: true, unitCost: true } },
    },
  });

  let revenue = 0;
  let cogs = 0;
  for (const sale of sales) {
    revenue += Number(sale.total);
    cogs += sale.items.reduce((sum, item) => sum + Number(item.unitCost) * Number(item.quantity), 0);
  }

  const corrections=await db.financialAdjustment.findMany({where:correctionScope(f)});
  for(const a of corrections){revenue+=Number(a.salesDelta);cogs+=Number(a.costDelta);}
  const expenses = await db.expense.findMany({
    where: F.and(F.eventScope(f), f.q?{OR:[{description:F.contains(f.q)},{category:F.contains(f.q)},{expenseNumber:F.contains(f.q)}]}:{}),
    select: { id:true, amount: true, method:true, category: true, categoryKindSnapshot:true, description: true, purchase:{select:{id:true,totalAmount:true,method:true}} },
  });

  const classification=classifyExpenses(expenses);
  const {stockPurchases}=classification;
  const operatingCorrection=await require('../utils/accounting-cash').operatingCorrections(db,f);
  const totalExpenses=Number(require('../utils/accounting-ledger').D(classification.totalExpenses).add(operatingCorrection));

  const grossProfit = revenue - cogs;
  const netProfit = grossProfit - totalExpenses;

  return {
    period: { start, end },
    provenance: { unverifiedSales: sales.filter(s => !s.accountingDate).length },
    revenue: round2(revenue),
    cogs: round2(cogs),
    grossProfit: round2(grossProfit),
    totalExpenses: round2(totalExpenses),
    netProfit: classification.unclassifiedCount ? null : round2(netProfit),
    netProfitBeforeUnclassified:round2(netProfit),
    expenseVerification:classification,
    stockPurchases: round2(stockPurchases), // for information only, NOT subtracted
  };
}

async function commissionsReportData(req, db) {
  const f=F.filters(req.query);
  if(!f.range)throw httpError(400,'Choose a business date or complete date range');
  const start=f.first,end=f.last,range={start:f.range.gte,end:f.range.lt};
  const cohort=saleScope({...f,range:undefined});
  const earned = await db.sale.findMany({ where: { AND:[cohort], waiterId: { not: null }, ...require('../utils/business-day-context').timeScope(f,'commissionEarnedAt'), commissionAmount: { not: null } } });
  // Legacy paid amounts have no authoritative recognition date/rate. Expose the
  // unknown cohort by original sale period; never infer a payout from current rate.
  const legacy = await db.sale.findMany({ where: { AND:[cohort], waiterId: { not: null }, status: 'PAID', commissionRateSnapshot: null,
    OR: [{ createdAt: { gte: range.start, lt: range.end } }, { payments: { some: { createdAt: { gte: range.start, lt: range.end } } } }] } });
  const corrections=await db.financialAdjustment.findMany({where:{AND:[saleScope({...f,range:undefined})?{sale:saleScope({...f,range:undefined})}:{}],...require('../utils/business-day-context').eventScope(f),commissionDelta:{not:0}},include:{sale:{select:{waiterId:true,commissionRateSnapshot:true}}}});
  const users = await db.user.findMany({ where: { OR: [{ id: { in: [...earned, ...legacy,...corrections.map(a=>a.sale)].map(s => s.waiterId) } }, { role: 'WAITER', isActive: true, ...(f.staffId?{id:F.id(f.staffId)}:{}), ...(f.q?{name:F.contains(f.q)}:{}) }] }, select: { id: true, name: true, isActive: true } });
  const waitresses = users.map(w => {
    const adjustments=corrections.filter(a=>a.sale.waiterId===w.id);const sales = earned.filter(s => s.waiterId === w.id), unknown = legacy.filter(s => s.waiterId === w.id);
    const rates = [...new Set(sales.map(s => String(s.commissionRateSnapshot)))];
    return { userId: w.id, name: w.isActive ? w.name : w.name + ' (inactive)', commissionRate: rates.length === 1 ? Number(rates[0]) : null,
      orders: sales.length, totalSales: round2(sales.reduce((n,s) => n + Number(s.total), 0)),
      commissionAmount: round2(sales.reduce((n,s) => n + Number(s.commissionAmount), 0)+adjustments.reduce((n,a)=>n+Number(a.commissionDelta),0)),
      correctionAmount:round2(adjustments.reduce((n,a)=>n+Number(a.commissionDelta),0)),
      unverifiedOrders: unknown.length, unverifiedSales: round2(unknown.reduce((n,s) => n + Number(s.total), 0)), unverifiedCommissionAmount: null };
  });
  waitresses.sort((a,b) => b.commissionAmount - a.commissionAmount || a.userId.localeCompare(b.userId));
  return { period: { start, end }, recognition: 'final-settlement', legacyBasis: 'original sale or collection in selected period; recognition unverified', waitresses,
    unverifiedOrders: legacy.length, grandTotalCommission: round2(waitresses.reduce((n,w) => n + w.commissionAmount, 0)) };
}

// One reporting snapshot prevents totals and collections seeing different commits.
const report = fn => async (req, res) => res.json(await prisma.$transaction(tx => fn(req, tx), { isolationLevel: 'RepeatableRead', timeout: 15000 }));
const dailyReport = report(dailyReportData);
async function dailyReportCsv(req,res){const data=await prisma.$transaction(tx=>dailyReportData(req,tx),{isolationLevel:'RepeatableRead',timeout:15000});res.set('Cache-Control','no-store');res.set('Content-Type','text/csv; charset=utf-8');res.set('Content-Disposition','attachment; filename=habibi-sales-'+data.period.start+'-to-'+data.period.end+'.csv');res.send(require('../utils/daily-report-csv').dailyCsv(data));}
const pnlReport = report(pnlReportData);
const commissionsReport = report(commissionsReportData);

module.exports = {
  dailyReportData,pnlReportData,commissionsReportData,
  dailyReport,dailyReportCsv,
  pnlReport,
  commissionsReport,
  DAILY_REPORT_SCHEMA,
  PNL_REPORT_SCHEMA,
  COMMISSIONS_SCHEMA,
};
