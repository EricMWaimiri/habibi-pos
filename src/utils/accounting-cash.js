'use strict';
const {D}=require('./accounting-ledger');
// Positive delta is returned cash. Original and correction periods remain separate.
async function shiftOutflow(tx,shiftId){
 const [row]=await tx.$queryRaw`SELECT
 coalesce((SELECT sum(amount) FROM expenses WHERE "shiftId"=${shiftId} AND method='CASH' AND "paymentStatus"='PAID'),0)
 +coalesce((SELECT sum(amount) FROM accounting_expense_settlements WHERE shift_id=${shiftId} AND method='CASH'),0)
 -coalesce((SELECT sum(CASE WHEN metadata ? 'cashByMethod' THEN (metadata->'cashByMethod'->>'CASH')::numeric WHEN payment_method='CASH' THEN cash_delta ELSE 0 END) FROM accounting_adjustments WHERE shift_id=${shiftId}),0) AS amount`;
 return D(row.amount);
}
async function operatingCorrections(tx,f){
 const rows=await tx.accounting_adjustments.findMany({where:{...(f.range?{posting_date:{gte:new Date(f.first||require('./accounting').nairobiDate(f.range.gte)),lte:new Date(f.last||require('./accounting').nairobiDate(new Date(+f.range.lt-1)))}}:{}),...(f.shiftId?{shift_id:f.shiftId==='unassigned'?null:f.shiftId}:{}),...(f.staffId?{actor_id:f.staffId}:{})},select:{operating_expense_delta:true}});
 return rows.reduce((s,a)=>s.add(a.operating_expense_delta),D(0));
}
module.exports={shiftOutflow,operatingCorrections};
