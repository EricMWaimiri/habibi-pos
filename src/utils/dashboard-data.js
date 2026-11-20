'use strict';
const F=require('./filters'),{D,allocateNet}=require('./return-calculations'),{saleScope,collectionEvents,collectionSummary}=require('./reporting-scope');
const {dailyReportData,pnlReportData,commissionsReportData}=require('../controllers/reports.controller');
const num=v=>Number(D(v).toDecimalPlaces(2));
const margin=(sales,profit)=>D(sales).gt(0)?num(D(profit).mul(100).div(sales)):null;
async function dashboardTrend(db,f,grants){
 const rows=new Map();
 for(let day=new Date(f.first+'T00:00:00Z');day<=new Date(f.last+'T00:00:00Z');day.setUTCDate(day.getUTCDate()+1)){const date=day.toISOString().slice(0,10);rows.set(date,{date,...(grants.includes('reports.sales')?{sales:D(0)}:{}),...(grants.includes('payments.view_collected')?{collections:D(0)}:{})});}
 const localDate=value=>new Date(+new Date(value)+10800000).toISOString().slice(0,10);
 const add=(date,key,value)=>{if(rows.has(date))rows.get(date)[key]=rows.get(date)[key].add(value);};
 if(grants.includes('reports.sales')){
  const sales=await db.sale.findMany({where:F.and({status:{notIn:['CANCELLED','MERGED']}},saleScope(f)),select:{accountingDate:true,createdAt:true,total:true}});
  for(const s of sales)add(s.accountingDate?new Date(s.accountingDate).toISOString().slice(0,10):localDate(s.createdAt),'sales',s.total);
  const corrections=await db.financialAdjustment.findMany({where:F.and(require('./business-day-context').eventScope(f),f.shiftId?{shiftId:F.id(f.shiftId)}:{},{sale:saleScope({...f,range:undefined,shiftId:undefined})}),select:{createdAt:true,shiftId:true,salesDelta:true}});
  for(const a of corrections)add(require('./business-day-context').dateForRow(a.createdAt,a.shiftId),'sales',a.salesDelta);
 }
 if(grants.includes('payments.view_collected'))for(const e of await collectionEvents(db,f))add(require('./business-day-context').dateForRow(e.createdAt,e.receivedShiftId),'collections',e.amount);
 return [...rows.values()].map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,k==='date'?v:num(v)])));
}
// Display allocation only: conserve the unchanged report-level rounded COGS,
// even for legacy fractional item quantities. Never update captured costs.
function displayCostCents(rows){
 const parts=rows.map(row=>{const exact=row.cost.mul(100),floor=exact.floor();return{row,cents:floor,remainder:exact.sub(floor)};});
 let left=rows.reduce((n,r)=>n.add(r.cost),D(0)).mul(100).toDecimalPlaces(0).sub(parts.reduce((n,p)=>n.add(p.cents),D(0))).toNumber();
 parts.sort((a,b)=>b.remainder.comparedTo(a.remainder)||a.row.productId.localeCompare(b.row.productId));
 for(const p of parts){if(left>0){p.cents=p.cents.add(1);left--;}p.row.cost=p.cents.div(100);}
}
async function productSales(db,f,financial){
 const sales=await db.sale.findMany({where:F.and({status:{notIn:['CANCELLED','MERGED']}},saleScope(f)),include:{items:{where:{removedAt:null},include:{product:{include:{category:true}}}}}});
 const adjustments=await db.financialAdjustment.findMany({where:F.and(require('./business-day-context').eventScope(f),f.shiftId?{shiftId:F.id(f.shiftId)}:{},{kind:{in:['RETURN','SALE_DISCOUNT','SALE_PRICE_CHANGE']},sale:saleScope({...f,range:undefined,shiftId:undefined})}),include:{saleItem:{include:{product:{include:{category:true}}}},request:true,sale:{include:{items:{where:{removedAt:null},include:{product:{include:{category:true}}}}}}}});
 const products=new Map(),categories=new Map();let unverifiedAllocations=0;
 function add(product,quantity,sales,cost){const id=product.id;let row=products.get(id);if(!row){row={productId:id,name:product.name,categoryId:product.categoryId??null,category:product.category?.name||'Unclassified',quantity:D(0),sales:D(0),cost:D(0)};products.set(id,row);}row.quantity=row.quantity.add(quantity);row.sales=row.sales.add(sales);row.cost=row.cost.add(cost);}
 for(const sale of sales){let allocation;try{allocation=allocateNet(sale,sale.items);}catch(e){unverifiedAllocations++;continue;}for(const item of sale.items)add(item.product,item.quantity,allocation.get(item.id),D(item.unitCost).mul(item.quantity));}
 for(const a of adjustments){
  if(require('./pricing-calculations').isPricing(a.kind)){
   const snap=a.request?.payload?.pricingSnapshot;
   if(!snap||!D(snap.after.reduce((n,r)=>n.add(r.amount),D(0))).sub(snap.before.reduce((n,r)=>n.add(r.amount),D(0))).eq(a.salesDelta)){unverifiedAllocations++;continue;}
   for(const row of snap.after){const item=a.sale.items.find(i=>i.id===row.id),old=snap.before.find(i=>i.id===row.id);if(!item||!old){unverifiedAllocations++;continue;}add(item.product,D(0),D(row.amount).sub(old.amount),D(0));}
  }else{if(!a.saleItem){unverifiedAllocations++;continue;}add(a.saleItem.product,D(a.quantity).negated(),a.salesDelta,a.costDelta);}
 }
 displayCostCents([...products.values()]);
 for(const row of products.values()){const key=row.categoryId||'unclassified';if(!categories.has(key))categories.set(key,{categoryId:row.categoryId,name:row.category,sales:D(0),cost:D(0)});const category=categories.get(key);category.sales=category.sales.add(row.sales);category.cost=category.cost.add(row.cost);}
 const project=r=>({...r,sales:num(r.sales),...(financial?{cost:num(r.cost),profit:num(r.sales.sub(r.cost)),marginPercent:margin(r.sales,r.sales.sub(r.cost))}:{} )});
 const all=[...products.values()].sort((a,b)=>b.sales.comparedTo(a.sales)||a.productId.localeCompare(b.productId));
 const rows=all.slice((f.page-1)*f.pageSize,f.page*f.pageSize).map(r=>{const {cost,...row}=r;return project({...row,cost,quantity:String(r.quantity)});}).map(r=>{if(!financial)delete r.cost;return r;});
 const categoryRows=[...categories.values()].map(r=>{const out=project(r);if(!financial)delete out.cost;return out;}).sort((a,b)=>b.sales-a.sales||String(a.categoryId).localeCompare(String(b.categoryId)));
 return {products:rows,topProducts:all.slice(0,6).map(r=>{const out=project({...r,quantity:String(r.quantity)});if(!financial)delete out.cost;return out;}),categories:categoryRows,totals:{sales:num(all.reduce((n,r)=>n.add(r.sales),D(0))),...(financial?{cost:num(all.reduce((n,r)=>n.add(r.cost),D(0)))}:{})},pagination:{page:f.page,pageSize:f.pageSize,total:all.length,pages:Math.ceil(all.length/f.pageSize)},unverifiedAllocations,categoryBasis:'CURRENT_CATALOG_CLASSIFICATION',basis:'Original discounted bill allocations plus separately dated return and audited pricing deltas; quantities are per product, not summed across unlike units. Display COGS cents are allocated deterministically to conserve the unchanged report total.'};
}
async function inventoryData(db,f){
 const where=F.and({isActive:true,type:'simple'},f.q?{OR:[{name:F.contains(f.q)},{productCode:F.contains(f.q)}]}:{});
 const {rows,pagination}=await F.page(db,'product',{where,select:{id:true,name:true,quantity:true,unitOfMeasure:true},orderBy:[{name:'asc'},{id:'asc'}]},f);
 let shift={};if(f.shiftId){const sales=await db.sale.findMany({where:{shiftId:f.shiftId==='unassigned'?{not:null}:f.shiftId},select:{id:true}}),ids=sales.map(s=>s.id);shift=f.shiftId==='unassigned'?{AND:[{OR:[{saleId:null},{saleId:{notIn:ids}}]},{OR:[{purchaseItemId:null},{purchaseItem:{purchase:{shiftId:null}}}]}]}:{OR:[{saleId:{in:ids}},{purchaseItem:{purchase:{shiftId:f.shiftId}}}]};}
 const movementWhere=F.and(require('./business-day-context').timeScope(f),f.staffId?{userId:F.id(f.staffId)}:{},f.q?{product:{OR:[{name:F.contains(f.q)},{productCode:F.contains(f.q)}]}}:{},shift);
 const groups=await db.stockMovement.groupBy({by:['productId','type'],where:movementWhere,_sum:{quantityChange:true},_count:{_all:true},orderBy:[{productId:'asc'},{type:'asc'}]});
 const movementPage=f.movementPage||f.page,movements=groups.slice((movementPage-1)*f.pageSize,movementPage*f.pageSize);
 const names=await db.product.findMany({where:{id:{in:[...new Set(movements.map(m=>m.productId))]}},select:{id:true,name:true,unitOfMeasure:true}}),lookup=new Map(names.map(p=>[p.id,p]));
 return {currentStock:rows,stockStatus:{tracked:await db.product.count({where:{isActive:true,type:"simple"}}),outOfStock:await db.product.count({where:{isActive:true,type:"simple",quantity:{lte:0}}}),lowStockThresholdAvailable:false},pagination,movements:movements.map(m=>({productId:m.productId,product:lookup.get(m.productId),type:m.type,quantityChange:String(m._sum.quantityChange||0),movements:m._count._all})),movementPagination:{page:movementPage,pageSize:f.pageSize,total:groups.length,pages:Math.ceil(groups.length/f.pageSize)},movementLimit:f.pageSize,movementPage,basis:'Stock quantities are CURRENT (date/shift/staff do not change them). Movement groups use actual movement dates, actor and explicit sale/purchase origin shift. Groups are paged, not totals of all stock units.',unavailable:'Historical inventory valuation and shift attribution for manual/count movements are unavailable. No quantities from unlike units are added together.'};
}
async function shiftData(db,f,permissions=[],collections){
 const where=F.and(require('./business-day-context').eventScope(f,'id','openedAt'),f.shiftId?{id:F.id(f.shiftId)}:{},f.staffId?{openedById:F.id(f.staffId)}:{});
 const result=await F.page(db,'shift',{where,orderBy:[{openedAt:'desc'},{id:'desc'}],select:{id:true,name:true,status:true,openedById:true,openedAt:true,closedAt:true,openingCash:true,closingCash:true,expectedCash:true}},f);
 const revenue=new Map(),expenses=new Map(),add=(map,id,value)=>map.set(id,(map.get(id)||D(0)).add(value));
 if(permissions.includes('reports.sales')){
  const sales=await db.sale.findMany({where:F.and({status:{notIn:['CANCELLED','MERGED']}},saleScope(f)),select:{shiftId:true,total:true}});for(const s of sales)add(revenue,s.shiftId,s.total);
  const corrections=await db.financialAdjustment.findMany({where:F.and(require('./business-day-context').eventScope(f),f.shiftId?{shiftId:F.id(f.shiftId)}:{},{sale:saleScope({...f,range:undefined,shiftId:undefined})}),select:{shiftId:true,salesDelta:true}});for(const a of corrections)add(revenue,a.shiftId,a.salesDelta);
 }
 if(permissions.includes('reports.financial')){const rows=await db.expense.findMany({where:F.and(F.eventScope(f),f.q?{OR:[{description:F.contains(f.q)},{category:F.contains(f.q)},{expenseNumber:F.contains(f.q)}]}:{}),select:{shiftId:true,amount:true}});for(const e of rows)add(expenses,e.shiftId,e.amount);}
 return {shifts:result.rows.map(s=>({...s,variance:s.closingCash==null||s.expectedCash==null?null:num(D(s.closingCash).sub(s.expectedCash)),...(permissions.includes('reports.sales')?{periodSales:num(revenue.get(s.id)||0)}:{}),...(collections?{periodCollections:collections.shifts.find(c=>c.shiftId===s.id)||{CASH:0,MPESA:0}}:{}),...(permissions.includes('reports.financial')?{periodExpenseOutflow:num(expenses.get(s.id)||0)}:{})})),pagination:result.pagination,basis:'Shifts OPENED in selected period, opening owner. Period sales use origin/correction shift; collections use receiving/correction shift; expense outflow includes stock purchases and uses recording shift. Staff filters retain those different roles. Closed expected/count/variance are stored reconciliation, never recalculated.'};
}
async function dashboardData(req,db){
 if(!req.permissions?.includes('dashboard.view'))throw Object.assign(Error('Dashboard permission required.'),{status:403});
 const f=F.filters(req.query,{today:require('./business-day-context').dateForRow(new Date(),null)});
 if(f.method||f.status||f.type||f.productId)throw Object.assign(Error('Use the module report for method, status, type or product filters.'),{status:400});
 const query={...req.query,...(!req.query.date&&!req.query.start?{date:f.date}:{})};
 const context={...req,query,validated:{query:{balances:f.balances||'cutoff'}}};const grants=req.permissions||[],has=p=>grants.includes(p);
 const result={period:{start:f.first,end:f.last},cutoffExclusive:f.range.lt,balanceView:f.balances||'cutoff',generatedAt:new Date().toISOString(),notes:['Sales origin, collections, expenses and corrections retain distinct date/shift/staff bases.','M-Pesa confirmation/refunds are not provided by this dashboard.']};
 if(has('reports.sales')){result.sales=await dailyReportData(context,db);result.breakdowns=await productSales(db,f,has('reports.financial'));result.breakdowns.reconciliation={salesDifference:num(D(result.breakdowns.totals.sales).sub(result.sales.totals.sales)),...(has('reports.financial')?{costDifference:num(D(result.breakdowns.totals.cost).sub(result.sales.totals.cost))}:{})};}
 if(has('payments.view_collected'))result.collections=collectionSummary(await collectionEvents(db,f));
 if(has('reports.financial')){result.financial=await pnlReportData(context,db);result.financial.grossMargin=margin(result.financial.revenue,result.financial.grossProfit);result.financial.marginUnavailable=result.financial.grossMargin===null?'Net sales are zero or negative.':null;if(result.sales)result.financial.reconciliation={salesDifference:num(D(result.financial.revenue).sub(result.sales.totals.sales)),costDifference:num(D(result.financial.cogs).sub(result.sales.totals.cost))};}
 if(has('commissions.manage'))result.commissions=await commissionsReportData(context,db);
 if(has('shifts.manage'))result.shiftPerformance=await shiftData(db,f,grants,result.collections);
 if(has('reports.inventory')&&(has('stock.view')||has('stock.count'))){result.inventory=await inventoryData(db,{...f,q:undefined});result.inventory.basis+=' Dashboard bill/reference search is not applied to inventory; use Inventory report for product search.';}
 if(has('reports.sales')||has('payments.view_collected'))result.trend=await dashboardTrend(db,f,grants);
 if(has('accounting.view')&&has('reports.financial'))result.accounting=await require('./accounting-read').overview(db,context);
 return result;
}
module.exports={margin,productSales,inventoryData,shiftData,dashboardData,dashboardTrend};
