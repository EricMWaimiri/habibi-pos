'use strict';
const a=require('assert/strict'),crypto=require('crypto');
async function bootstrap(db,{database,oid,cluster,role,port,name,pin,pepper,expectedMigrations}){
 a(/^[a-z][a-z0-9_]+$/.test(database)&&Number.isInteger(oid));a(/^[0-9]+$/.test(cluster)&&/^[a-z][a-z0-9_]+$/.test(role)&&Number.isInteger(port)&&port>0&&port<=65535);a(typeof name==='string'&&name.trim().length>=2);a(typeof pepper==='string'&&pepper.length>=32);a(/^\d{6}$/.test(pin),'Use a six-digit private PIN');a.equal(expectedMigrations.length,31);
 return db.$transaction(async tx=>{
 await tx.$queryRawUnsafe('SELECT true locked FROM pg_advisory_xact_lock(180023,991001)');
 const [id]=await tx.$queryRawUnsafe('SELECT current_database() name,(SELECT oid::int FROM pg_database WHERE datname=current_database()) oid,current_user role,inet_server_port() port,(SELECT system_identifier::text FROM pg_control_system()) cluster');a.equal(id.name,database);a.equal(id.oid,oid);a.equal(id.cluster,cluster);a.equal(id.role,role);a.equal(id.port,port);
 const history=await tx.$queryRawUnsafe('SELECT migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name');a.equal(history.length,31);for(let i=0;i<31;i++){a.equal(history[i].migration_name,expectedMigrations[i].name);a.equal(history[i].checksum,expectedMigrations[i].executedSha256);}
 // All application tables except permission definitions must be empty before first bootstrap.
 const tables=await tx.$queryRawUnsafe("SELECT tablename name FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('_prisma_migrations','role_permissions') ORDER BY tablename");
 for(const {name:t} of tables){a(/^[a-z_]+$/.test(t));const[n]=await tx.$queryRawUnsafe('SELECT count(*)::int n FROM public."'+t+'"');a.equal(n.n,0,'Bootstrap refuses an initialized/nonempty database: '+t);}
 const user=await tx.user.create({data:{id:crypto.randomUUID(),name:name.trim(),role:'MANAGER',pinHash:require('../../src/utils/pin').hashPin(pin,pepper),isActive:true}});
 await require('../../src/utils/staff-audit').record(tx,user.id,null,user,'FIRST_ADMIN_BOOTSTRAP');return{id:user.id,role:user.role};
 },{timeout:60000,isolationLevel:'ReadCommitted'});
}
// Production wrapper reads secrets from inherited anonymous stdin only; no argv/env PIN, file or stdout secret.
if(require.main===module){let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{text+=chunk;if(text.length>65536)process.exit(1);});process.stdin.on('end',async()=>{let db;try{const input=JSON.parse(text);text='';const {PrismaClient}=require('@prisma/client');db=new PrismaClient();await bootstrap(db,input);console.log('First administrator initialized.');}catch{console.error('Administrator initialization refused; no credentials reported.');process.exitCode=1;}finally{if(db)await db.$disconnect();}});}
module.exports={bootstrap};
