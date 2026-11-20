'use strict';
const {Decimal}=require('@prisma/client').Prisma;
const D=v=>new Decimal(v||0);
function entitlement(sale){return sale.commissionCapSnapshot==null?D(sale.total).mul(sale.commissionRateSnapshot||0).div(100).toDecimalPlaces(2):D(sale.commissionCapSnapshot);}
function resized(sale,total){if(sale.commissionCapSnapshot==null)return undefined;const old=D(sale.total),next=D(total);return next.gte(old)?entitlement(sale).add(next.sub(old).mul(sale.commissionRateSnapshot||0).div(100).toDecimalPlaces(2)):old.isZero()?D(0):entitlement(sale).mul(next).div(old).toDecimalPlaces(2);}
module.exports={entitlement,resized};
