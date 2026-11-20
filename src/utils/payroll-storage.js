'use strict';
// Optional migration29 adapter. Older accepted environments retain their existing
// Client and behavior. Enabling this requires an independently verified deployment.
const {randomUUID}=require('node:crypto');
const {D,money,error}=require('./accounting-ledger');
const A=require('./accounting');
const enabled=()=>process.env.CORE_PAYROLL_CORRECTIONS_ENABLED==='true';
const q=(tx,sql,...args)=>tx.$queryRawUnsafe(sql,...args);
async function verify(tx){
 if(!enabled())throw error(409,'Payroll storage corrections are not enabled in this environment.');
 // Migration checksums belong to the privileged deployment preflight. Runtime
 // deliberately has no access to Prisma history; do not widen its grants.
 const [state]=await q(tx,"SELECT to_regprocedure('public.payroll_root(uuid)') IS NOT NULL AND to_regprocedure('public.payroll_lock(uuid)') IS NOT NULL AND (SELECT count(*)=4 FROM information_schema.columns WHERE table_schema='public' AND table_name='employee_payroll_drafts' AND column_name IN ('eligible_days','salary_segments','manual_basic_adjustment','attendance_snapshot')) installed");
 if(state?.installed!==true)throw error(409,'The reviewed payroll storage installation cannot be verified.');
}
async function draftFields(tx,profile){
 if(!enabled()||!profile)return{};
 await verify(tx);
 const c=profile.calculation;
 if(c.salaryBasis!=='DAILY_EFFECTIVE_SEGMENTS'||!Array.isArray(c.segments)||!c.segments.length)throw error(409,'Verified daily salary segments are required.');
 return{eligible_days:c.segments.reduce((n,s)=>n.add(s.eligibleDays),D(0)),salary_segments:c.segments,manual_basic_adjustment:D(c.manualBasicAdjustment||0),attendance_snapshot:profile.salaryProfileSnapshot.attendance||null};
}
async function project(tx,row){
 if(!enabled())return row;
 await verify(tx);
 const [revision]=await q(tx,'SELECT replacement_draft_id FROM payroll_draft_revisions WHERE original_draft_id=$1::uuid',row.id);
 const [root]=await q(tx,'SELECT public.payroll_root($1::uuid) id',row.id);
 const [application]=await q(tx,'SELECT a.*,c.mode FROM payroll_correction_applications a JOIN payroll_corrections c ON c.id=a.correction_id WHERE a.root_draft_id=$1::uuid ORDER BY a.version DESC LIMIT 1',root.id);
 const due=application?.mode==='ADJUST'&&['RECORD_PAYMENT','COMPLETE'].includes(row.status)&&application.version>Number(row.events.at(-1)?.metadata?.correctionVersion||0)&&(await liability(tx,row.id)).gt(0);
 return{...row,eventStatus:row.status,...(due?{status:'PAYMENT_DUE'}:{}),rootId:root.id,correctionVersion:application?.version||0,...(revision?{status:'SUPERSEDED',replacementId:revision.replacement_draft_id}:application?.effective_draft_id!==undefined&&application.effective_draft_id!==row.id?{status:'SUPERSEDED',replacementId:application.effective_draft_id}:application?.mode==='REVERSE_UNPAID'?{status:'REVERSED'}:{})};
}
async function liability(tx,id){
 const [row]=await q(tx,'SELECT coalesce(sum(payable_delta),0)::text amount FROM accounting_adjustments WHERE payroll_id IS NOT NULL AND public.payroll_root(payroll_id)=public.payroll_root($1::uuid)',id);
 return D(row.amount);
}
async function payInstallment(tx,ctx,row,input,helpers){
 await verify(tx);
 await q(tx,'SELECT public.payroll_lock($1::uuid)',row.id);
 if(!input.method)throw error(400,'Select the actual payout method.');
 const approval=row.events.find(x=>x.status==='APPROVE');
 if(approval?.metadata?.expenseBasis!=='APPROVAL')throw error(409,'Approved accrual policy cannot be verified.');
 // A completed payroll can reopen only after an applied correction version.
 if(['RECORD_PAYMENT','COMPLETE'].includes(row.eventStatus||row.status)&&row.correctionVersion<=Number(row.events.at(-1)?.metadata?.correctionVersion||0))throw error(409,'No newly approved salary adjustment is available for payment.');
 const available=await liability(tx,row.id),amount=input.amount===undefined?available:money(input.amount,{positive:true});
 if(amount.lte(0)||amount.gt(available))throw error(409,'Payout exceeds the verified outstanding salary liability.');
 const reference=await helpers.outgoingReference(tx,input.method,input.reference),id=randomUUID();
 const date=A.nairobiDate(ctx.instant);
 await q(tx,`INSERT INTO accounting_adjustments(id,kind,payroll_id,operating_expense_delta,payable_delta,cash_delta,payment_method,reason,posting_date,shift_id,actor_id,approved_by_id,metadata,created_at,employee_receivable_delta,employee_advance_delta,employee_overpayment_delta,employee_tip_liability_delta,other_recovery_liability_delta)
 VALUES($1,'PAYROLL_INSTALLMENT',$2::uuid,0,$3,$3,$4::"PaymentMethod",$5,$6::date,$7,$8,$8,$9::jsonb,$10,0,0,0,0,0)`,id,row.id,amount.neg(),input.method,ctx.reason,date,ctx.shift.id,ctx.actor.id,JSON.stringify({reference,providerConfirmed:false,correctionVersion:row.correctionVersion||0,expenseRecognition:'NONE'}),ctx.instant);
 await helpers.insert(tx,'employee_payroll_postings',{id:randomUUID(),draft_id:row.id,accounting_adjustment_id:id,kind:'PAYROLL_INSTALLMENT',created_at:ctx.instant});
 await helpers.insert(tx,'employee_finance_cash',{id:randomUUID(),accounting_adjustment_id:id,request_id:ctx.requestId,employee_id:row.employee_id,actor_id:ctx.actor.id,shift_id:ctx.shift.id,draft_id:row.id,method:input.method,reference,amount,reason:ctx.reason,created_at:ctx.instant});
 return{status:available.eq(amount)?'RECORD_PAYMENT':'PARTIALLY_PAID',amount:amount.toFixed(2)};
}
module.exports={enabled,verify,draftFields,project,liability,payInstallment};
