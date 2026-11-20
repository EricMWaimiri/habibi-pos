'use strict';
// Operational labels only; this module never reads or changes stock balances.
const fail=message=>Object.assign(Error(message),{status:409});
function docketGroups(items,config){const groups=new Map();for(const item of items){const location=item.operationalLocation??null;if(location!==null&&!['BAR','KITCHEN'].includes(location))throw fail('Unsupported product printer location.');const key=location||'DEFAULT',target=location?config[location]:config.COUNTER;if(!target||typeof target.name!=='string'||!target.ip)throw fail('Printer destination is not configured for '+key+'.');if(!groups.has(key))groups.set(key,{location:key,target,items:[]});groups.get(key).items.push(item);}return[...groups.values()];}
function docketPlan(sale,items,waiterName,config,addition,render){
 return (items.length?docketGroups(items,config):[{location:'DEFAULT',target:config.COUNTER,items:[]}]).map(g=>({label:g.location==='DEFAULT'?'docket':'docket-'+g.location.toLowerCase(),target:g.target,rows:render(sale,g.items,waiterName,Boolean(addition)),location:g.location}));
}
function routeConfig(printers,settings){const p=settings?.printers||{};return {...printers,COUNTER:{...printers.COUNTER,ip:p.counterIp||printers.COUNTER.ip},DEFAULT_WAITER:{...printers.DEFAULT_WAITER,ip:p.defaultWaiterIp||printers.DEFAULT_WAITER.ip},PORT:p.port||printers.PORT,...(p.barIp?{BAR:{name:'Bar docket',ip:p.barIp}}:{}),...(p.kitchenIp?{KITCHEN:{name:'Kitchen docket',ip:p.kitchenIp}}:{})};}
module.exports={docketGroups,docketPlan,routeConfig};
