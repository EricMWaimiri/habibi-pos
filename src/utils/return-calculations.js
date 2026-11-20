'use strict';
const {Prisma}=require('@prisma/client');
const {quantity}=require('./quantity');
const D=v=>new Prisma.Decimal(v);
const error=message=>Object.assign(new Error(message),{status:409});
function money(value){let d;try{d=D(value);}catch{throw error('Invalid monetary amount.');}if(!d.isFinite()||d.decimalPlaces()>2||d.abs().gt('9999999999.99'))throw error('Money must be exactly representable to two decimal places.');return d;}
// Largest-remainder allocation preserves the original whole-bill discount to
// the cent. Stable item-ID tie breaks; never reprice from today's catalogue.
function allocateNet(sale,items){
 const total=BigInt(money(sale.total).mul(100).toFixed(0)),subtotal=items.reduce((n,i)=>n+BigInt(money(i.subtotal).mul(100).toFixed(0)),0n);
 if(total<0n||total>subtotal||!money(sale.subtotal).eq(D(subtotal.toString()).div(100)))throw error('Original bill values require manual review.');
 if(subtotal===0n)return new Map(items.map(i=>[i.id,D(0)]));
 const rows=items.map(i=>{const w=BigInt(money(i.subtotal).mul(100).toFixed(0));return{id:i.id,cents:total*w/subtotal,remainder:total*w%subtotal};});
 let left=total-rows.reduce((n,r)=>n+r.cents,0n);rows.sort((a,b)=>a.remainder===b.remainder?a.id.localeCompare(b.id):a.remainder>b.remainder?-1:1);
 for(const row of rows)if(left>0n){row.cents++;left--;}
 return new Map(rows.map(r=>[r.id,D(r.cents.toString()).div(100)]));
}
function returnAmounts(sale,items,item,rawQuantity,previous){
 const q=quantity(rawQuantity,{positive:true}),original=quantity(item.quantity,{positive:true,status:409});
 const used=previous.reduce((n,r)=>n.add(r.quantity),D(0)),cumulative=quantity(used.add(q),{positive:true,status:409});
 if(cumulative.gt(original))throw error('Quantity exceeds the original unreturned quantity.');
 const line=allocateNet(sale,items).get(item.id);if(line===undefined)throw error('Original line cannot be verified.');
 const amount=line.mul(cumulative).div(original).toDecimalPlaces(2).sub(previous.reduce((n,r)=>n.sub(r.salesDelta),D(0)));
 const cost=money(D(item.unitCost).mul(cumulative).toDecimalPlaces(2).sub(previous.reduce((n,r)=>n.sub(r.costDelta),D(0))));
 if(amount.lt(0)||cost.lt(0))throw error('Prior returns cannot be reconciled. Manual review required.');
 return{quantity:q,cumulative,original,amount,cost};
}
module.exports={D,money,allocateNet,returnAmounts,error};
