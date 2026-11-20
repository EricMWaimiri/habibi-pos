'use strict';
const prisma=require('../config/prisma'),F=require('../utils/filters'),{Prisma}=require('@prisma/client'),documents=require('../utils/invoice-documents');
const bad=m=>Object.assign(new Error(m),{status:400});
const own=req=>req.permissions.includes('sales.view_all')?{}:{OR:[{waiterId:req.user.id},{createdById:req.user.id}]};
const saleInclude={items:{include:{product:{select:{id:true,name:true}}}},payments:true,financialAdjustments:{include:{cashEntries:true}},waiter:{select:{id:true,name:true}},createdBy:{select:{id:true,name:true}},shift:{select:{id:true,name:true,status:true}}};
const purchaseInclude={items:{include:{product:{select:{id:true,name:true}},stockMovement:true}},expense:true,recordedBy:{select:{id:true,name:true}},shift:{select:{id:true,name:true,status:true}}};
async function saleList(req,res){
 const f=F.filters({pageSize:'25',...req.query},{statuses:['UNPAID','PARTIAL','PAID','CANCELLED','MERGED']});if(f.balances&&f.balances!=='current')throw bad('Invoices show current balances. Use Reports for historical cutoff balances.');
 const q=f.q?.replace(/^INV-/i,''),where=F.and(own(req),F.salePeriod(f),f.shiftId?{shiftId:F.id(f.shiftId)}:{},f.staffId?{waiterId:F.id(f.staffId)}:{},f.status?{status:f.status}:{},q?{saleNumber:F.contains(q)}:{});
 const data=await prisma.$transaction(async db=>{const page=await F.page(db,'sale',{where,include:saleInclude,orderBy:[{createdAt:'desc'},{id:'desc'}]},f);return{invoices:await Promise.all(page.rows.map(s=>documents.salesDocument(db,s,req.permissions))),pagination:page.pagination};},{isolationLevel:'RepeatableRead',timeout:30000});
 res.json({...data,attribution:'Original sale date/shift; current net collections and outstanding. Corrections retain their own dates/shifts. Customer details were not captured by the existing POS.'});
}
function purchaseFilters(req){
 const f=F.filters({pageSize:'25',...req.query},{statuses:['RECORDED_PAID','UNVERIFIED','PAID','PARTIAL','UNPAID','OVERDUE','CANCELLED']});for(const k of ['supplier','dateBasis'])if(req.query[k]!==undefined&&(typeof req.query[k]!=='string'||req.query[k].length>100))throw bad('Invalid '+k);const supplier=req.query.supplier?.trim(),basis=req.query.dateBasis||'recorded';if(!['recorded','invoice'].includes(basis))throw bad('Invalid date basis');
 const range=f.range?(basis==='recorded'?{createdAt:f.range}:{invoiceDate:{gte:new Date(f.first+'T00:00:00Z'),lte:new Date(f.last+'T00:00:00Z')}}):{};
 // UNVERIFIED means no verified immutable expense link; legacy links are never inferred.
 const where=F.and(range,f.shiftId?{shiftId:F.id(f.shiftId)}:{},f.staffId?{recordedById:F.id(f.staffId)}:{},f.method?{method:f.method}:{},supplier?{supplierName:F.contains(supplier)}:{},f.q?{OR:[{purchaseNumber:F.contains(f.q)},{invoiceNumber:F.contains(f.q)},{supplierName:F.contains(f.q)}]}:{});return{f,where};
}
async function purchaseDocumentPage(db,where,f,permissions){
 const orderBy=[{createdAt:'desc'},{id:'desc'}];
 if(!f.status){const result=await F.page(db,'purchase',{where,include:purchaseInclude,orderBy},f);return{purchases:await Promise.all(result.rows.map(p=>purchaseProjection(db,p,permissions))),pagination:result.pagination};}
 // Status is the existing full document verification result, not FK presence.
 // Bounded-memory scan inside the caller's snapshot preserves exact totals and
 // page boundaries even when linked legacy rows fail stock/expense validation.
 const purchases=[],start=(f.page-1)*f.pageSize;let total=0,skip=0;
 for(;;){const batch=await db.purchase.findMany({where,include:purchaseInclude,orderBy,skip,take:200});
  for(const row of batch){const document=await purchaseProjection(db,row,permissions);if(document.paymentStatus!==f.status&&!(f.status==='OVERDUE'&&document.overdue))continue;if(total>=start&&purchases.length<f.pageSize)purchases.push(document);total++;}
  if(batch.length<200)break;skip+=batch.length;
 }
 return{purchases,pagination:{page:f.page,pageSize:f.pageSize,total,pages:Math.ceil(total/f.pageSize)}};
}
async function purchaseList(req,res){const {f,where}=purchaseFilters(req);const result=await prisma.$transaction(tx=>purchaseDocumentPage(tx,where,f,req.permissions),{isolationLevel:'RepeatableRead',timeout:30000});res.json({...result,attribution:'Recording date by default; invoice date only when explicitly captured. Historical missing links stay unverified. Recorded paid is an outgoing expense, not provider confirmation.'});}
async function document(req,res){const sales=req.params.kind==='sales',printing=!!req.invoicePrint;
 const result=await prisma.$transaction(async db=>{const row=sales?await db.sale.findFirst({where:F.and({id:req.params.id},own(req)),include:saleInclude}):await db.purchase.findUnique({where:{id:req.params.id},include:purchaseInclude});if(!row)throw Object.assign(new Error('Invoice not found or access denied'),{status:404});return sales?documents.salesDocument(db,row,req.permissions,true):purchaseProjection(db,row,req.permissions,true);},{isolationLevel:'RepeatableRead',timeout:30000});
 res.set('Cache-Control','no-store');if(printing)return res.type('html').send(documents.printable(result,req.invoicePrint==='reprint',await require('../utils/settings').documentSettings(prisma)));res.json({invoice:result});
}
module.exports={saleList,purchaseList,document,purchaseFilters,purchaseDocumentPage};

async function purchaseProjection(db,row,permissions,detail=false){if(row.supplierId&&row.settlementMode){const state=await require('../utils/accounting-service').ledger(db,row.supplierId);const accountingSummary=state.invoices.find(i=>i.purchase_id===row.id);return documents.purchaseDocument({...row,accountingSummary},permissions,detail);}return documents.purchaseDocument(row,permissions,detail);}
