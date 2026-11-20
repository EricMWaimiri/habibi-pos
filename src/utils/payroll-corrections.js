'use strict';
// Append-only correction orchestration. Monetary entries use the existing
// accounting_adjustments journal; snapshots and independent events authorize it.
const {randomUUID}=require('node:crypto'),{z}=require('zod');
const L=require('./accounting-ledger'),A=require('./accounting'),T=require('./shift-transactions'),Storage=require('./payroll-storage');
const S=require('./employee-finance-service'),{correctionPreview}=require('./payroll-correction-preview');
const D=L.D,q=(tx,sql,...args)=>tx.$queryRawUnsafe(sql,...args),uid=()=>randomUUID();
const reason=z.string().trim().min(3).max(200),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/),amount=z.union([z.string(),z.number()]).transform(v=>L.money(v).toFixed(2));
const target=z.strictObject({expense:amount,tips:amount,bills:amount,advances:amount,otherDeductions:amount});
const request=z.strictObject({requestId:z.uuid(),payrollId:z.uuid(),mode:z.enum(['REVERSE_UNPAID','REPLACE_UNPAID','ADJUST']),replacementPayrollId:z.uuid().optional(),expectedVersion:z.number().int().min(0),accountingDate:date,reason,tipSources:z.array(z.strictObject({sourceKey:z.string().regex(/^TIP:[a-f0-9-]{36}$/i),amount})).max(1000).optional(),recovery:z.strictObject({claimId:z.uuid(),amount,method:z.enum(['CASH','MPESA','PAYROLL_AUTHORIZED']),reference:z.string().max(100).optional(),recoveryPayrollId:z.uuid().optional(),authorizationReference:z.string().trim().min(3).max(200)}).optional(),bills:z.array(z.strictObject({saleId:z.string().min(1).max(100),amount})).max(1000).optional(),advances:z.array(z.strictObject({advanceId:z.uuid(),amount})).max(1000).optional(),target:target.optional(),previewFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional()});
function parse(schema,input){const r=schema.safeParse(input);if(!r.success)throw L.error(400,'Invalid payroll correction input.');return r.data;}
function permit(ctx,...keys){if(ctx.actor.role!=='MANAGER'||keys.some(k=>!ctx.permissions.includes(k)))throw L.error(403,'Payroll correction permission denied.');}
async function facts(tx,id,allowReversed=false){
 await Storage.verify(tx);await q(tx,'SELECT public.payroll_lock($1::uuid)',id);
 const row=await S.payroll(tx,id);
 if(['DRAFT','REVIEW','CANCEL','SUPERSEDED'].includes(row.status)||row.status==='REVERSED'&&!allowReversed)throw L.error(409,'Choose a current approved payroll.');
 const journals=await q(tx,'SELECT * FROM accounting_adjustments WHERE payroll_id IS NOT NULL AND public.payroll_root(payroll_id)=$1::uuid ORDER BY created_at,id',row.rootId);
 const sum=key=>journals.reduce((n,j)=>n.add(j[key]||0),D(0));
 const sources=await q(tx,'SELECT s.*,s.amount-coalesce((SELECT sum(r.amount) FROM payroll_source_releases r WHERE r.source_id=s.id),0) remaining FROM employee_payroll_sources s WHERE public.payroll_root(s.draft_id)=$1::uuid ORDER BY s.created_at,s.id',row.rootId);
 const bills=await q(tx,'SELECT l.*,a."collectionDelta" amount FROM employee_settlement_links l JOIN financial_adjustments a ON a.id=l.adjustment_id WHERE l.draft_id IS NOT NULL AND public.payroll_root(l.draft_id)=$1::uuid',row.rootId);
 const advances=await q(tx,'SELECT r.*,r.amount-coalesce((SELECT sum(v.amount) FROM payroll_advance_reversals v WHERE v.recovery_id=r.id),0) remaining FROM employee_advance_recoveries r WHERE public.payroll_root(r.draft_id)=$1::uuid ORDER BY r.created_at,r.id',row.rootId);
 const claims=await q(tx,'SELECT c.*,c.amount+coalesce((SELECT sum(a.amount) FROM payroll_overpayment_claim_adjustments a WHERE a.claim_id=c.id),0)-coalesce((SELECT sum(r.amount) FROM payroll_overpayment_recoveries r WHERE r.claim_id=c.id),0) remaining FROM payroll_overpayment_claims c WHERE c.root_draft_id=$1::uuid ORDER BY c.created_at,c.id',row.rootId);
 const [recovered]=await q(tx,'SELECT coalesce(sum(r.amount),0)::text amount FROM payroll_overpayment_recoveries r JOIN payroll_overpayment_claims c ON c.id=r.claim_id WHERE c.root_draft_id=$1::uuid',row.rootId);
 const [futureRecoveries]=await q(tx,'SELECT coalesce(sum(r.amount),0)::text amount FROM payroll_overpayment_recoveries r WHERE r.recovery_draft_id IS NOT NULL AND public.payroll_root(r.recovery_draft_id)=$1::uuid',row.rootId);
 const confirmed=row.events.some(e=>e.status==='CONFIRM_DEDUCTIONS');
 const current={rootId:row.rootId,employeeId:row.employee_id,version:row.correctionVersion,closed:false,expense:sum('operating_expense_delta').toFixed(2),tips:sources.filter(s=>s.kind==='TIP').reduce((n,s)=>n.add(s.remaining),D(0)).toFixed(2),bills:bills.reduce((n,b)=>n.add(b.amount),D(0)).toFixed(2),advances:advances.reduce((n,a)=>n.add(a.remaining),D(0)).toFixed(2),otherDeductions:(confirmed?D(row.snapshot.input.deductions):D(0)).add(sum('other_recovery_liability_delta')).add(futureRecoveries.amount).toFixed(2),liability:sum('payable_delta').toFixed(2),actualPaid:sum('cash_delta').neg().add(recovered.amount).toFixed(2),overpaymentOutstanding:claims.reduce((n,c)=>n.add(c.remaining),D(0)).toFixed(2),overpaymentRecovered:recovered.amount};
 // Source fingerprint includes every relevant immutable ledger row, not only totals.
 current.sourceFingerprint=S.hash({journals,sources,bills,advances,claims,futureRecoveries});
 return{row,current,journals,sources,bills,advances,claims,futureRecoveries};
}
function futureRecoveriesNotEditable(f){return D(f.futureRecoveries?.amount||0);}
async function previewIn(tx,ctx,r){
 permit(ctx,'payroll.view','payroll.manage','accounting.correct');
 const f=await facts(tx,r.payrollId,r.mode==='REPLACE_UNPAID');
 if(f.current.version!==r.expectedVersion)throw L.error(409,'Payroll correction version changed; refresh the preview.');
 if(require('./business-day-runtime').active()&&r.accountingDate>await require('./business-day-runtime').dateForShift(tx,await A.databaseInstant(tx),null))throw L.error(409,'The selected accounting business day has not started.');
 await q(tx,'SELECT true FROM public.payroll_open_date($1::date)',r.accountingDate);
 let desired=r.target;
 if(r.mode==='REPLACE_UNPAID'){
  if(!r.replacementPayrollId)throw L.error(400,'Select a reviewed replacement draft.');const fresh=await S.payroll(tx,r.replacementPayrollId);
  if(fresh.status!=='DRAFT'||fresh.events.length||fresh.employee_id!==f.row.employee_id||fresh.payroll_year!==f.row.payroll_year||fresh.payroll_month!==f.row.payroll_month||fresh.id===f.row.id)throw L.error(409,'Replacement must be a fresh draft for the same employee and payroll month.');
 }else if(r.replacementPayrollId)throw L.error(400,'Replacement draft is only valid when replacing an unpaid approval.');
 if(['REVERSE_UNPAID','REPLACE_UNPAID'].includes(r.mode)){
  if(f.row.events.some(e=>['CONFIRM_DEDUCTIONS','PARTIALLY_PAID','RECORD_PAYMENT','COMPLETE'].includes(e.status))||!D(f.current.actualPaid).isZero())throw L.error(409,'Confirmed deductions or payments require a full correction.');
  desired={expense:'0',tips:'0',bills:'0',advances:'0',otherDeductions:'0'};
 }else if(!desired)throw L.error(400,'Review explicit correction target amounts.');
 // Changes to asset recoveries require explicit item-level selections. They are
 // deliberately not inferred from aggregate amounts or old draft reservations.
 const confirmed=f.row.events.some(e=>e.status==='CONFIRM_DEDUCTIONS');
 if(!D(desired.bills).eq(f.current.bills)){
  permit(ctx,'receivables.correct','payroll.confirm');
  if(!confirmed||!Array.isArray(r.bills)||new Set(r.bills.map(b=>b.saleId)).size!==r.bills.length||!r.bills.reduce((n,b)=>n.add(b.amount),D(0)).eq(desired.bills))throw L.error(409,'Select explicit bill amounts matching the correction target.');
  for(const b of r.bills){if(D(b.amount).lte(0))throw L.error(400,'Select positive bill deduction amounts.');const sale=await tx.sale.findUnique({where:{id:b.saleId}});const credited=f.bills.filter(l=>l.sale_id===b.saleId).reduce((n,l)=>n.add(l.amount),D(0));if(!sale||sale.waiterId!==f.row.employee_id||['CANCELLED','MERGED'].includes(sale.status)||D(b.amount).gt(D(sale.balance).add(credited)))throw L.error(409,'Selected bill does not have sufficient employee-attributed balance.');}
 }else if(r.bills!==undefined)throw L.error(400,'Omit unchanged bill selections.');
 if(!D(desired.advances).eq(f.current.advances)){
  permit(ctx,'employee_advances.manage','payroll.confirm');
  if(!confirmed||!Array.isArray(r.advances)||new Set(r.advances.map(a=>a.advanceId)).size!==r.advances.length||!r.advances.reduce((n,a)=>n.add(a.amount),D(0)).eq(desired.advances))throw L.error(409,'Select explicit advance amounts matching the correction target.');
  for(const a of r.advances){const [v]=await q(tx,'SELECT a.employee_id,a.amount-(SELECT coalesce(sum(amount),0) FROM employee_advance_recoveries WHERE advance_id=a.id)+(SELECT coalesce(sum(v.amount),0) FROM payroll_advance_reversals v JOIN employee_advance_recoveries r ON r.id=v.recovery_id WHERE r.advance_id=a.id) remaining FROM employee_salary_advances a WHERE a.id=$1::uuid',a.advanceId);const restored=f.advances.filter(x=>x.advance_id===a.advanceId).reduce((n,x)=>n.add(x.remaining),D(0));if(!v||v.employee_id!==f.row.employee_id||D(a.amount).lte(0)||D(a.amount).gt(D(v.remaining).add(restored)))throw L.error(409,'Selected advance has insufficient recoverable balance.');}
 }else if(r.advances!==undefined)throw L.error(400,'Omit unchanged advance selections.');
 if(D(desired.otherDeductions).lt(futureRecoveriesNotEditable(f)))throw L.error(409,'A confirmed overpayment recovery cannot be undone by editing ordinary deductions.');
 if(!D(desired.otherDeductions).eq(f.current.otherDeductions)&&!confirmed)throw L.error(409,'Confirm deductions before correcting recorded deduction amounts.');
 if(!D(desired.tips).eq(f.current.tips)&&!['REVERSE_UNPAID','REPLACE_UNPAID'].includes(r.mode)){
  permit(ctx,'tips.allocate');if(!Array.isArray(r.tipSources)||new Set(r.tipSources.map(s=>s.sourceKey)).size!==r.tipSources.length||!r.tipSources.reduce((n,s)=>n.add(s.amount),D(0)).eq(desired.tips))throw L.error(409,'Select exact verified tip sources matching the corrected total.');
  for(const source of r.tipSources){const [allocation]=await q(tx,'SELECT created_at FROM employee_finance_allocations WHERE id=$1::uuid',source.sourceKey.slice(4));if(!allocation||!A.nairobiDate(allocation.created_at).startsWith(String(f.row.payroll_year)+'-'+String(f.row.payroll_month).padStart(2,'0')+'-'))throw L.error(409,'Tip source is outside the payroll allocation month.');const [row]=await q(tx,'SELECT public.payroll_source_capacity($1,$2)::text capacity,(SELECT coalesce(sum(s.amount),0)-coalesce((SELECT sum(r.amount) FROM payroll_source_releases r JOIN employee_payroll_sources x ON x.id=r.source_id WHERE x.source_key=$1),0) FROM employee_payroll_sources s WHERE s.source_key=$1)::text claimed',source.sourceKey,f.row.employee_id);const own=f.sources.filter(s=>s.source_key===source.sourceKey).reduce((n,s)=>n.add(s.remaining),D(0));if(D(source.amount).lte(0)||D(source.amount).gt(D(row.capacity).sub(row.claimed).add(own)))throw L.error(409,'Tip source belongs to another employee, is reversed, or is already reserved.');}
 }else if(r.tipSources!==undefined)throw L.error(400,'Omit unchanged tip selections.');
 if(r.mode==='ADJUST'&&!r.recovery&&['expense','tips','bills','advances','otherDeductions'].every(k=>D(desired[k]).eq(f.current[k])))throw L.error(400,'The proposed correction has no changes.');
 let preview=correctionPreview(ctx,f.current,desired,r.accountingDate);
 preview.authorizedRecoveryBasis=f.futureRecoveries?.amount||'0';delete preview.fingerprint;preview.fingerprint=S.hash(preview);
 if(r.mode==='REPLACE_UNPAID'){const fresh=await S.payroll(tx,r.replacementPayrollId);preview.replacement={id:fresh.id,fingerprint:fresh.fingerprint,net:String(fresh.net_before_statutory),requiresFreshReviewAndApproval:true};delete preview.fingerprint;preview.fingerprint=S.hash(preview);}
 if(r.recovery){
  permit(ctx,'payroll.confirm');const recovery=r.recovery,claim=f.claims.find(c=>c.id===recovery.claimId);
  if(r.mode!=='ADJUST'||Object.keys(desired).some(k=>!D(desired[k]).eq(f.current[k]))||!claim||D(recovery.amount).lte(0)||D(recovery.amount).gt(claim.remaining))throw L.error(409,'Select an outstanding claim and an exact recovery amount; keep earnings unchanged.');
  if(recovery.method==='PAYROLL_AUTHORIZED'){
   if(!recovery.recoveryPayrollId||recovery.recoveryPayrollId===f.row.id)throw L.error(409,'Select the explicitly authorized later payroll.');
   const future=await S.payroll(tx,recovery.recoveryPayrollId);
   if(future.employee_id!==f.row.employee_id||!['CONFIRM_DEDUCTIONS','PARTIALLY_PAID','PAYMENT_DUE'].includes(future.status)||(future.payroll_year*12+future.payroll_month)<=(f.row.payroll_year*12+f.row.payroll_month)||D(recovery.amount).gt(await Storage.liability(tx,future.id)))throw L.error(409,'The later payroll cannot support this explicit recovery.');
   preview.recoveryPayrollVersion=future.correctionVersion;preview.recoveryPayrollLiability=(await Storage.liability(tx,future.id)).toFixed(2);
  }else if(recovery.recoveryPayrollId)throw L.error(400,'Cash recovery must not name another payroll.');
  preview={...preview,recovery:{...recovery},afterOverpaymentOutstanding:D(preview.afterOverpaymentOutstanding).sub(recovery.amount).toFixed(2),cashReceived:recovery.method==='PAYROLL_AUTHORIZED'?'0.00':recovery.amount,automaticFutureRecovery:false};
  delete preview.fingerprint;preview.fingerprint=S.hash(preview);
 }
 return{...f,preview};
}
async function preview(db,auth,input){const r=parse(request,input);return T.withShiftTransaction(db,async tx=>{const ctx=await S.readContext(tx,auth);return(await previewIn(tx,ctx,r)).preview;});}
async function event(tx,ctx,c,status,requestId){const prior=await tx.payroll_correction_events.findMany({where:{correction_id:c.id},orderBy:{sequence:'asc'}});return tx.payroll_correction_events.create({data:{id:uid(),request_id:requestId,correction_id:c.id,sequence:prior.length+1,status,actor_id:ctx.actor.id,reason:ctx.reason,preview_fingerprint:c.preview_fingerprint}});}
async function create(db,auth,input){const r=parse(request,input);return T.withShiftTransaction(db,async tx=>{
 await q(tx,'SELECT true FROM pg_advisory_xact_lock(180030,hashtext($1))',r.requestId);
 await q(tx,'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',auth.id);const ctx=await S.readContext(tx,auth);ctx.reason=r.reason;permit(ctx,'payroll.view','payroll.manage','accounting.correct');
 const prior=await tx.payroll_corrections.findUnique({where:{request_id:r.requestId}});
 if(prior){if(prior.actor_id!==ctx.actor.id||prior.snapshot.requestFingerprint!==S.hash(r))throw L.error(409,'Request UUID was used for another correction.');return{correctionId:prior.id,replayed:true};}
 const f=await previewIn(tx,ctx,r);
 if(!r.previewFingerprint||f.preview.fingerprint!==r.previewFingerprint)throw L.error(409,'Review the current correction preview before confirmation.');
 const c=await tx.payroll_corrections.create({data:{id:uid(),request_id:r.requestId,root_draft_id:f.row.rootId,basis_draft_id:f.row.id,replacement_draft_id:r.replacementPayrollId||null,expected_version:r.expectedVersion,mode:r.mode,actor_id:ctx.actor.id,accounting_date:new Date(r.accountingDate+'T00:00:00Z'),preview_fingerprint:f.preview.fingerprint,snapshot:{preview:f.preview,request:r,requestFingerprint:S.hash(r)},reason:r.reason}});
 await event(tx,ctx,c,'REQUESTED',uid());return{correctionId:c.id,replayed:false};
 });}
async function journal(tx,ctx,c,row,kind,deltas,extra={}){
 const data={id:uid(),kind,payroll_id:row.id,payroll_correction_id:c.id,operating_expense_delta:'0',payable_delta:'0',cash_delta:'0',employee_receivable_delta:'0',employee_advance_delta:'0',employee_overpayment_delta:'0',employee_tip_liability_delta:'0',other_recovery_liability_delta:'0',posting_date:c.accounting_date,shift_id:ctx.shift.id,actor_id:ctx.actor.id,approved_by_id:ctx.actor.id,reason:ctx.reason,metadata:{correctionId:c.id,requesterId:c.actor_id,statutoryApplied:false},...deltas,...extra};
 const j=await tx.accounting_adjustments.create({data});await tx.employee_payroll_postings.create({data:{id:uid(),draft_id:row.id,accounting_adjustment_id:j.id,kind,payroll_correction_id:c.id}});return j;
}
async function apply(db,auth,input){const r=parse(z.strictObject({requestId:z.uuid(),correctionId:z.uuid(),shiftId:z.string().min(1),reason}),input);return T.withShiftTransaction(db,async tx=>{
 await Storage.verify(tx);await q(tx,'SELECT true FROM pg_advisory_xact_lock(180030,hashtext($1))',r.requestId);
 await q(tx,'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',auth.id);const ctx=await S.readContext(tx,auth);ctx.reason=r.reason;permit(ctx,'payroll.approve','payroll.manage','payroll.view','accounting.correct');
 const c=await tx.payroll_corrections.findUnique({where:{id:r.correctionId}});if(!c)throw L.error(404,'Correction not found.');
 await q(tx,'SELECT public.payroll_lock($1::uuid)',c.root_draft_id);
 const prior=await tx.payroll_correction_events.findUnique({where:{request_id:r.requestId}});
 if(prior){if(prior.correction_id!==c.id||prior.actor_id!==ctx.actor.id||prior.status!=='APPLIED'||prior.reason!==r.reason)throw L.error(409,'Request UUID was used for another correction action.');return{correctionId:c.id,replayed:true};}
 if(ctx.actor.id===c.actor_id)throw L.error(403,'A different authorized manager must approve this correction.');
 const requester=await tx.user.findUnique({where:{id:c.actor_id}});if(!requester?.isActive)throw L.error(403,'Correction requester is no longer active.');const requesterContext={actor:requester,permissions:await require('./custom-role-policy').resolveUserPermissions(tx,requester)};await previewIn(tx,requesterContext,c.snapshot.request);
 const f=await previewIn(tx,ctx,c.snapshot.request);
 if(f.preview.fingerprint!==c.preview_fingerprint)throw L.error(409,'Payroll facts changed after the preview; prepare a fresh correction.');
 const events=await tx.payroll_correction_events.findMany({where:{correction_id:c.id},orderBy:{sequence:'asc'}});if(events.at(-1)?.status!=='REQUESTED')throw L.error(409,'Correction request is no longer awaiting approval.');
 ctx.shift=await T.lockOpenShift(tx,ctx.actor.id,r.shiftId,'CASH');
 await event(tx,ctx,c,'APPROVED',uid());
 if(['REVERSE_UNPAID','REPLACE_UNPAID'].includes(c.mode)){
  const original=f.journals.find(j=>j.kind==='PAYROLL_ACCRUAL');if(!original||f.journals.filter(j=>j.kind==='PAYROLL_ACCRUAL').length!==1)throw L.error(409,'Original approval accrual cannot be verified.');
  if(!D(f.current.expense).isZero()||!D(f.current.tips).isZero())await journal(tx,ctx,c,f.row,'PAYROLL_ACCRUAL_REVERSAL',{operating_expense_delta:D(original.operating_expense_delta).neg(),payable_delta:D(original.payable_delta).neg(),employee_tip_liability_delta:D(f.current.tips)},{reverses_adjustment_id:original.id});
  for(const source of f.sources)if(!D(source.remaining).isZero())await tx.payroll_source_releases.create({data:{id:uid(),source_id:source.id,correction_id:c.id,amount:source.remaining}});
 }else{
  ctx.instant=await A.databaseInstant(tx);
  const I=S.correctionInternals;
  if(!D(f.preview.target.bills).eq(f.current.bills)){
   const reversed=new Set(f.bills.map(b=>b.reversal_of).filter(Boolean)),active=f.bills.filter(b=>D(b.amount).gt(0)&&!reversed.has(b.adjustment_id));
   const ids=[...new Set([...active.map(b=>b.sale_id),...c.snapshot.request.bills.map(b=>b.saleId)])];
   const sales=ids.length?await I.lockedSales(tx,ctx,ids):new Map();
   for(const bill of active){await I.settlement(tx,ctx,sales.get(bill.sale_id),D(bill.amount).neg(),'PAYROLL_DEDUCTION_REVERSAL',{draft_id:f.row.id,payroll_correction_id:c.id,reversal_of:bill.adjustment_id});sales.set(bill.sale_id,await tx.sale.findUnique({where:{id:bill.sale_id}}));}
   for(const bill of c.snapshot.request.bills){await I.settlement(tx,ctx,sales.get(bill.saleId),D(bill.amount),'PAYROLL_DEDUCTION',{draft_id:f.row.id,payroll_correction_id:c.id});sales.set(bill.saleId,await tx.sale.findUnique({where:{id:bill.saleId}}));}
   const restored=D(f.current.bills),selected=D(f.preview.target.bills);
   if(restored.gt(0))await journal(tx,ctx,c,f.row,'PAYROLL_RECOVERY_REVERSAL',{employee_receivable_delta:restored,payable_delta:restored});
   if(selected.gt(0))await journal(tx,ctx,c,f.row,'PAYROLL_CORRECTION_RECOVERY',{employee_receivable_delta:selected.neg(),payable_delta:selected.neg()});
  }
  if(!D(f.preview.target.advances).eq(f.current.advances)){
   const restored=D(f.current.advances),selected=D(f.preview.target.advances);
   if(restored.gt(0)){const j=await journal(tx,ctx,c,f.row,'PAYROLL_RECOVERY_REVERSAL',{employee_advance_delta:restored,payable_delta:restored});for(const a of f.advances)if(D(a.remaining).gt(0))await tx.payroll_advance_reversals.create({data:{id:uid(),recovery_id:a.id,correction_id:c.id,accounting_adjustment_id:j.id,amount:a.remaining}});}
   for(const a of c.snapshot.request.advances)await tx.employee_advance_recoveries.create({data:{id:uid(),advance_id:a.advanceId,draft_id:f.row.id,actor_id:ctx.actor.id,amount:a.amount,payroll_correction_id:c.id}});
   if(selected.gt(0))await journal(tx,ctx,c,f.row,'PAYROLL_CORRECTION_RECOVERY',{employee_advance_delta:selected.neg(),payable_delta:selected.neg()});
  }
  const other=D(f.preview.effects.otherRecoveryLiability);if(!other.isZero())await journal(tx,ctx,c,f.row,other.gt(0)?'PAYROLL_CORRECTION_RECOVERY':'PAYROLL_RECOVERY_REVERSAL',{other_recovery_liability_delta:other,payable_delta:other.neg()});
  if(!D(f.preview.target.tips).eq(f.current.tips)){
   for(const source of f.sources.filter(s=>s.kind==='TIP'))if(!D(source.remaining).isZero())await tx.payroll_source_releases.create({data:{id:uid(),source_id:source.id,correction_id:c.id,amount:source.remaining}});
   for(const source of c.snapshot.request.tipSources)await tx.employee_payroll_sources.create({data:{id:uid(),draft_id:f.row.id,source_key:source.sourceKey,kind:'TIP',amount:source.amount,payroll_correction_id:c.id}});
   const delta=D(f.preview.target.tips).sub(f.current.tips);await journal(tx,ctx,c,f.row,'PAYROLL_CORRECTION',{payable_delta:delta,employee_tip_liability_delta:delta.neg()});
  }
  if(c.snapshot.request.recovery){
   const recovery=c.snapshot.request.recovery,amount=D(recovery.amount),future=recovery.method==='PAYROLL_AUTHORIZED'?await S.payroll(tx,recovery.recoveryPayrollId):f.row;
   const reference=recovery.method==='MPESA'?(recovery.reference||'').trim().toUpperCase():recovery.reference||null;
   if(recovery.method==='MPESA'&&!/^[A-Z0-9]{10}$/.test(reference))throw L.error(400,'Enter the actual ten-character M-Pesa reference.');
   if(recovery.method!=='PAYROLL_AUTHORIZED')S.requirePermission(ctx,recovery.method==='CASH'?'pay.cash':'pay.mpesa');
   const j=await journal(tx,ctx,c,future,'PAYROLL_OVERPAYMENT_RECOVERY',{employee_overpayment_delta:amount.neg(),payable_delta:recovery.method==='PAYROLL_AUTHORIZED'?amount.neg():'0',cash_delta:recovery.method==='PAYROLL_AUTHORIZED'?'0':amount,payment_method:recovery.method==='PAYROLL_AUTHORIZED'?null:recovery.method});
   const record=await tx.payroll_overpayment_recoveries.create({data:{id:uid(),request_id:c.request_id,claim_id:recovery.claimId,accounting_adjustment_id:j.id,amount,method:recovery.method,recovery_draft_id:recovery.recoveryPayrollId||null,actor_id:c.actor_id,approved_by_id:ctx.actor.id,authorization_reference:recovery.authorizationReference,reason:c.reason}});
   if(recovery.method!=='PAYROLL_AUTHORIZED')await tx.employee_finance_cash.create({data:{id:uid(),accounting_adjustment_id:j.id,request_id:c.request_id,employee_id:f.row.employee_id,actor_id:ctx.actor.id,shift_id:ctx.shift.id,overpayment_recovery_id:record.id,direction:'IN',method:recovery.method,reference,amount,reason:c.reason}});
  }
  const delta=D(f.preview.effects.operatingExpense);if(!delta.isZero())await journal(tx,ctx,c,f.row,'PAYROLL_CORRECTION',{operating_expense_delta:delta,payable_delta:delta});
  let change=D(f.preview.effects.overpaymentAsset);
  if(change.gt(0)){const j=await journal(tx,ctx,c,f.row,'PAYROLL_OVERPAYMENT',{employee_overpayment_delta:change,payable_delta:change});await tx.payroll_overpayment_claims.create({data:{id:uid(),correction_id:c.id,root_draft_id:f.row.rootId,employee_id:f.row.employee_id,accounting_adjustment_id:j.id,amount:change}});}
  if(change.lt(0)){let remaining=change.neg();for(const claim of f.claims){const value=D(0).constructor.min(D(claim.remaining),remaining);if(value.lte(0))continue;const j=await journal(tx,ctx,c,f.row,'PAYROLL_OVERPAYMENT_ADJUSTMENT',{employee_overpayment_delta:value.neg(),payable_delta:value.neg()});await tx.payroll_overpayment_claim_adjustments.create({data:{id:uid(),claim_id:claim.id,correction_id:c.id,accounting_adjustment_id:j.id,amount:value.neg()}});remaining=remaining.sub(value);}if(!remaining.isZero())throw L.error(409,'Overpayment claim capacity changed.');}
 }
 await tx.payroll_correction_applications.create({data:{correction_id:c.id,root_draft_id:c.root_draft_id,effective_draft_id:c.mode==='REPLACE_UNPAID'?c.replacement_draft_id:c.basis_draft_id,version:c.expected_version+1,actor_id:ctx.actor.id}});
 await tx.accounting_audit_events.create({data:{id:uid(),actor_id:ctx.actor.id,action:'PAYROLL_CORRECTION_APPLIED',target_type:'EMPLOYEE_FINANCE',target_id:c.id,reason:ctx.reason,metadata:{preview:c.snapshot.preview,independentApproval:true}}});
 await event(tx,ctx,c,'APPLIED',r.requestId);
 return{correctionId:c.id,payrollId:f.row.id,version:c.expected_version+1,replayed:false};
 },30000);}
async function decide(db,auth,input){const r=parse(z.strictObject({requestId:z.uuid(),correctionId:z.uuid(),status:z.enum(['REJECTED','CANCELLED']),reason}),input);return T.withShiftTransaction(db,async tx=>{
 await Storage.verify(tx);await q(tx,'SELECT true FROM pg_advisory_xact_lock(180030,hashtext($1))',r.requestId);await q(tx,'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',auth.id);const ctx=await S.readContext(tx,auth);ctx.reason=r.reason;permit(ctx,'payroll.manage','accounting.correct');const c=await tx.payroll_corrections.findUnique({where:{id:r.correctionId}});if(!c)throw L.error(404,'Correction not found.');await q(tx,'SELECT public.payroll_lock($1::uuid)',c.root_draft_id);
 const prior=await tx.payroll_correction_events.findUnique({where:{request_id:r.requestId}});if(prior){if(prior.correction_id!==c.id||prior.actor_id!==ctx.actor.id||prior.status!==r.status||prior.reason!==r.reason)throw L.error(409,'Request UUID was used for different input.');return{correctionId:c.id,status:r.status,replayed:true};}
 const events=await tx.payroll_correction_events.findMany({where:{correction_id:c.id},orderBy:{sequence:'asc'}}),last=events.at(-1)?.status;if(!['REQUESTED','APPROVED'].includes(last)||r.status==='REJECTED'&&last!=='REQUESTED')throw L.error(409,'Correction is no longer available for that decision.');if(r.status==='REJECTED'){permit(ctx,'payroll.approve');if(ctx.actor.id===c.actor_id)throw L.error(403,'Cancel your own request instead of approving or rejecting it.');}else if(ctx.actor.id!==c.actor_id)permit(ctx,'payroll.approve');await event(tx,ctx,c,r.status,r.requestId);return{correctionId:c.id,status:r.status,replayed:false};
 });}
async function history(db,auth,id){const ctx=await S.readContext(db,auth);permit(ctx,'payroll.view');await Storage.verify(db);const row=await S.payroll(db,id);const rows=await db.payroll_corrections.findMany({where:{root_draft_id:row.rootId},orderBy:{created_at:'asc'}});return Promise.all(rows.map(async c=>({...c,events:await db.payroll_correction_events.findMany({where:{correction_id:c.id},orderBy:{sequence:'asc'}})})));}
async function context(db,auth,id){return T.withShiftTransaction(db,async tx=>{const ctx=await S.readContext(tx,auth);permit(ctx,'payroll.view','payroll.manage','accounting.correct');const f=await facts(tx,id,true);const bills=await tx.sale.findMany({where:{waiterId:f.row.employee_id,status:{notIn:['CANCELLED','MERGED']}},select:{id:true,saleNumber:true,balance:true},take:1000});const advances=await q(tx,'SELECT a.id,a.created_at,a.amount-(SELECT coalesce(sum(amount),0) FROM employee_advance_recoveries WHERE advance_id=a.id)+(SELECT coalesce(sum(v.amount),0) FROM payroll_advance_reversals v JOIN employee_advance_recoveries r ON r.id=v.recovery_id WHERE r.advance_id=a.id) remaining FROM employee_salary_advances a WHERE a.employee_id=$1 ORDER BY a.created_at,a.id',f.row.employee_id);const tips=await q(tx,"SELECT a.id,a.amount,a.created_at FROM employee_finance_allocations a WHERE a.employee_id=$1 AND a.kind='TIP' AND NOT EXISTS(SELECT 1 FROM employee_finance_allocations r WHERE r.reversal_of=a.id) ORDER BY a.created_at,a.id",f.row.employee_id);return{current:f.current,bills:bills.map(b=>({...b,selected:f.bills.filter(x=>x.sale_id===b.id).reduce((n,x)=>n.add(x.amount),D(0)).toFixed(2)})),advances:advances.map(a=>({...a,selected:f.advances.filter(x=>x.advance_id===a.id).reduce((n,x)=>n.add(x.remaining),D(0)).toFixed(2)})),tips:tips.filter(t=>A.nairobiDate(t.created_at).startsWith(String(f.row.payroll_year)+'-'+String(f.row.payroll_month).padStart(2,'0')+'-')).map(t=>({...t,sourceKey:'TIP:'+t.id,selected:f.sources.filter(s=>s.source_key==='TIP:'+t.id).reduce((n,s)=>n.add(s.remaining),D(0)).toFixed(2)})),claims:f.claims.map(c=>({id:c.id,amount:c.amount,remaining:c.remaining})),replacementDrafts:await q(tx,'SELECT id,created_at,adjusted_basic FROM employee_payroll_drafts d WHERE employee_id=$1 AND payroll_year=$2 AND payroll_month=$3 AND NOT EXISTS(SELECT 1 FROM employee_payroll_events e WHERE e.draft_id=d.id) AND NOT EXISTS(SELECT 1 FROM payroll_draft_revisions r WHERE r.original_draft_id=d.id) ORDER BY created_at,id LIMIT 100',f.row.employee_id,f.row.payroll_year,f.row.payroll_month),futurePayrolls:await q(tx,"SELECT d.id,d.payroll_year,d.payroll_month,e.status FROM employee_payroll_drafts d JOIN LATERAL(SELECT status FROM employee_payroll_events e WHERE e.draft_id=d.id ORDER BY sequence DESC LIMIT 1)e ON true WHERE d.employee_id=$1 AND (d.payroll_year*12+d.payroll_month)>$2 AND e.status IN ('CONFIRM_DEDUCTIONS','PARTIALLY_PAID') ORDER BY d.payroll_year,d.payroll_month,d.id",f.row.employee_id,f.row.payroll_year*12+f.row.payroll_month)};});}
module.exports={preview,create,apply,history,facts,context,decide};
