'use strict';
// Pure preparation. Not connected to installed TEST29 or legacy purchase posting.
const {Prisma}=require('@prisma/client');
const {quantity}=require('./quantity');
const D=v=>new Prisma.Decimal(v),fail=m=>Object.assign(Error(m),{status:409});
function planLine({ordered,received='0',unitCost,receive}){
 const o=quantity(ordered,{positive:true}),r=quantity(received,{min:0}),n=quantity(receive,{positive:true});
 const c=D(unitCost);if(!c.isFinite()||c.lt(0)||c.decimalPlaces()>2)throw fail('Invalid invoice cost.');
 if(r.gt(o)||r.add(n).gt(o))throw fail('Receipt exceeds the authorized outstanding quantity.');
 // Cumulative rounding gives exactly the original item value, even with tiny partial receipts.
 const amount=r.add(n).mul(c).toDecimalPlaces(2).sub(r.mul(c).toDecimalPlaces(2));
 return {ordered:o.toFixed(6),received:r.add(n).toFixed(6),outstanding:o.sub(r).sub(n).toFixed(6),amount:amount.toFixed(2)};
}
function receiptReplay(existing,hash){if(!/^[a-f0-9]{64}$/.test(hash))throw fail('Invalid receipt fingerprint.');if(!existing)return false;if(existing.request_hash!==hash)throw fail('Request identifier was reused with changed content.');return true;}
module.exports={planLine,receiptReplay};
