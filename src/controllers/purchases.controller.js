'use strict';
const prisma=require('../config/prisma'),{z}=require('zod');
const {quantitySchema}=require('../utils/quantity'),{isRealDate,nairobiDate}=require('../utils/accounting');
const {SHIFT_CONTEXT_SCHEMA}=require('../utils/shift-transactions');
const CREATE_PURCHASE_SCHEMA=z.object({body:z.object({
 supplierName:z.string().trim().min(2).max(160).optional(),supplierId:z.string().min(1).optional(),
 invoiceNumber:z.string().trim().min(1).max(100),invoiceDate:z.string().refine(isRealDate).optional(),dueDate:z.string().refine(isRealDate).optional(),
 clientRequestId:z.uuid(),method:z.enum(['CASH','MPESA']).default('CASH'),shiftId:SHIFT_CONTEXT_SCHEMA,
 categoryId:z.string().min(1).optional(),reference:z.string().trim().max(100).optional(),settlementMode:z.enum(['PAID_AT_ENTRY','ON_ACCOUNT']).default('PAID_AT_ENTRY'),reason:z.string().trim().min(3).max(300).optional(),
 items:z.array(z.object({productId:z.string().min(1),quantity:quantitySchema({positive:true,max:1000000}),unitCost:z.union([z.string(),z.number()])})).min(1).max(100),
})});
async function createPurchase(req,res){
 const p=req.validated.body,S=require('../utils/accounting-service');let supplierId=p.supplierId;
 if(!supplierId&&p.supplierName){const matches=await prisma.suppliers.findMany({where:{name:{equals:p.supplierName,mode:'insensitive'},is_active:true},select:{id:true},take:2});if(matches.length===1)supplierId=matches[0].id;}
 if(!supplierId)throw Object.assign(new Error('Choose a controlled supplier account; no historical relationship is inferred.'),{status:400});
 const invoiceDate=p.invoiceDate||nairobiDate(new Date()),supplier=await prisma.suppliers.findUnique({where:{id:supplierId}});if(!supplier)throw Object.assign(new Error('Supplier not found'),{status:404});
 const due=new Date(invoiceDate+'T00:00:00Z');due.setUTCDate(due.getUTCDate()+(supplier.details?.creditDays||0));
 const result=await S.mutate(prisma,req.auth,{requestId:p.clientRequestId,action:'PURCHASE_POST',shiftId:p.shiftId,reason:p.reason||'Record supplier invoice '+p.invoiceNumber,payload:{document:{supplierId,invoiceNumber:p.invoiceNumber,invoiceDate,dueDate:p.dueDate||due.toISOString().slice(0,10),settlementMode:p.settlementMode,method:p.method,...(p.categoryId?{categoryId:p.categoryId}:{}),...(p.reference?{reference:p.reference}:{}),items:p.items.map(i=>({productId:i.productId,quantity:String(i.quantity),unitCost:String(i.unitCost)}))}}});
 if(result.status==='PENDING')return res.status(202).json({message:'Purchase submitted for manager approval',...result});
 const purchase=await prisma.purchase.findUnique({where:{id:result.purchaseId},select:{id:true,purchaseNumber:true,invoiceNumber:true,invoiceDate:true,shiftId:true}});
 res.status(result.replayed?200:201).json({message:result.replayed?'Purchase already recorded; no duplicate stock or payable':'Purchase recorded',purchase,replayed:result.replayed});
}
module.exports={createPurchase,CREATE_PURCHASE_SCHEMA};
