'use strict';
const prisma=require('../config/prisma'),{dashboardData,inventoryData}=require('../utils/dashboard-data'),F=require('../utils/filters');
async function dashboard(req,res){res.set('Cache-Control','no-store');res.json(await prisma.$transaction(tx=>dashboardData(req,tx),{isolationLevel:'RepeatableRead',timeout:20000}));}
async function inventory(req,res){if(!req.permissions.some(p=>['stock.view','stock.count'].includes(p)))return res.status(403).json({message:'Inventory authorization is also required.'});const f=F.filters(req.query);f.movementPage=F.filters({...req.query,page:req.query.movementPage||'1'}).page;if(f.status||f.method||f.type||f.balances)throw Object.assign(Error('Unsupported inventory-summary filter; use the movement list for types.'),{status:400});res.json(await prisma.$transaction(tx=>inventoryData(tx,f),{isolationLevel:'RepeatableRead',timeout:15000}));}
module.exports={dashboard,inventory};
