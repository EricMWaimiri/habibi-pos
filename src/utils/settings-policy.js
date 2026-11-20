'use strict';
// Explicit non-secret configuration contract. No connection/authentication values.
const {z}=require('zod');
const text=max=>z.string().trim().max(max).refine(s=>!/[\x00-\x1f\x7f]/.test(s),'Control characters are not permitted');
const privateIp=z.string().refine(s=>{const n=s.split('.');return n.length===4&&n.every(p=>/^(0|[1-9]\d{0,2})$/.test(p)&&Number(p)<=255)&&(n[0]==='10'||n[0]==='192'&&n[1]==='168'||n[0]==='172'&&Number(n[1])>=16&&Number(n[1])<=31);},'Use a private IPv4 printer address');
const categories={
 accounting:z.object({defaultCreditDays:z.number().int().min(0).max(365),secondManagerThreshold:z.string().regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/),reportingBasis:z.literal('POSTING_DATE'),numbering:z.literal('EXISTING'),paymentMethods:z.tuple([z.literal('CASH'),z.literal('MPESA')])}).strict(),
 general:z.object({name:text(60).min(1),address:text(120),phone:text(40)}).strict(),
 documents:z.object({receiptFooter:text(96),receiptShowStaff:z.boolean(),receiptShowNotes:z.boolean(),invoiceFooter:text(200),invoiceShowStaff:z.boolean()}).strict(),
 inventory:z.object({countSessionMinutes:z.number().int().min(1).max(60)}).strict(),
 printers:z.object({counterIp:privateIp,defaultWaiterIp:privateIp,port:z.literal(9100),barIp:privateIp.nullable().optional(),kitchenIp:privateIp.nullable().optional()}).strict(),
};
const update=z.object({version:z.number().int().min(0).max(2147483646),reason:text(200).min(3),changes:z.object(Object.fromEntries(Object.entries(categories).map(([k,v])=>[k,v.optional()]))).strict().refine(v=>Object.keys(v).length>0,'Choose at least one category')}).strict();
const error=(status,message)=>Object.assign(new Error(message),{status});
function validate(body){const parsed=update.safeParse(body);if(!parsed.success)throw error(400,'Invalid settings: use supported categories, complete fields and a reason.');return parsed.data;}
const allowed=(key,permissions)=>Object.hasOwn(categories,key)&&permissions.includes(key==='printers'?'printers.manage':key==='accounting'?'accounting.settings':'settings.manage');
function authorize(changes,permissions){if(!Array.isArray(permissions)||Object.keys(changes).some(k=>!allowed(k,permissions)))throw error(403,'Settings change is not permitted.');}
function defaults(printers,minutes){return{accounting:{defaultCreditDays:0,secondManagerThreshold:'0',reportingBasis:'POSTING_DATE',numbering:'EXISTING',paymentMethods:['CASH','MPESA']},general:{name:'Habibi Lounge',address:'',phone:''},documents:{receiptFooter:'Thank you!',receiptShowStaff:true,receiptShowNotes:true,invoiceFooter:'',invoiceShowStaff:true},inventory:{countSessionMinutes:minutes},printers:{counterIp:printers.COUNTER.ip,defaultWaiterIp:printers.DEFAULT_WAITER.ip,port:printers.PORT}};}
function project(data,permissions){return Object.fromEntries(Object.entries(data).filter(([key])=>allowed(key,permissions)));}
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
module.exports={equal,categories,validate,authorize,defaults,project,allowed,error};
