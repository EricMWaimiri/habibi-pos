'use strict';
const policy=require('./settings-policy');
function fallback(){return policy.defaults(require('./printer-config').load(),require('./stock-counts').leaseMinutes());}
async function read(db){const base=fallback(),record=await db.posSettings.findUnique({where:{id:'global'}});if(record&&Object.keys(record.data).some(k=>!Object.hasOwn(policy.categories,k)))throw policy.error(503,'Stored settings require administrator review.');const data={...base,...record?.data};for(const [key,schema]of Object.entries(policy.categories))if(!schema.safeParse(data[key]).success)throw policy.error(503,'Stored settings require administrator review.');return{version:record?.version||0,data,updatedAt:record?.updatedAt||null};}
async function documentSettings(db){const settings=await read(db||require('../config/prisma'));return{general:settings.data.general,documents:settings.data.documents,printers:settings.data.printers};}
async function audit(tx,{actorId,scope,reason,before,after,revision=null}){return tx.administrationEvent.create({data:{actorId,scope,reason,before,after,revision,categories:scope==='SETTINGS'?Object.keys(after):['permissions']}});}
module.exports={read,documentSettings,audit,fallback};
