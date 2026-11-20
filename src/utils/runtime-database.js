"use strict";
// Runtime access is deliberately separate from schema ownership/migration access.
const fail=()=>Object.assign(new Error('Database runtime security verification failed.'),{code:'RUNTIME_DATABASE_SECURITY'});
function configuration(env=process.env){
 try{const u=new URL(env.DATABASE_URL);if(!env.POS_DATABASE_NAME||!env.POS_RUNTIME_ROLE||!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1'].includes(u.hostname)||(!/^[1-9][0-9]{0,4}$/.test(String(env.POS_DATABASE_PORT||'5432'))||Number(env.POS_DATABASE_PORT||5432)>65535||Number(u.port||5432)!==Number(env.POS_DATABASE_PORT||5432))||u.pathname!=='/'+env.POS_DATABASE_NAME||decodeURIComponent(u.username)!==env.POS_RUNTIME_ROLE||decodeURIComponent(u.password).length<32||u.hash||![...u.searchParams.keys()].every(k=>['schema','connection_limit','pool_timeout','connect_timeout'].includes(k))||(u.searchParams.has('schema')&&u.searchParams.get('schema')!=='public')||[...u.searchParams.entries()].some(([k,v])=>k!=='schema'&&(!/^[1-9][0-9]*$/.test(v)||Number(v)>(k==='connection_limit'?8:10)))||!/^habibi_pos(?:_test|_phase81_[a-z0-9_]+|_employee_finance_(?:dev|test)_20261112_a1|_business_day_rehearsal_20261118_a1)?$/.test(env.POS_DATABASE_NAME)||!/^habibi_pos_runtime_[a-z0-9_]+$/.test(env.POS_RUNTIME_ROLE))throw fail();return{database:env.POS_DATABASE_NAME,role:env.POS_RUNTIME_ROLE};}catch{throw fail();}
}
async function verifyRuntimeDatabase(client,env=process.env){
 const c=configuration(env);
 try{
 const rows=await client.$queryRawUnsafe(`SELECT current_database() AS database,current_user AS role,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolcanlogin,
 (SELECT count(*)::int FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships,
 has_schema_privilege(current_user,'public','CREATE') AS schema_create,
 has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
 has_database_privilege(current_user,current_database(),'TEMP') AS temporary,
 (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=pg_roles.oid) AS owned,
 (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') AND (has_table_privilege(current_user,pg_class.oid,'DELETE') OR has_table_privilege(current_user,pg_class.oid,'TRUNCATE') OR has_table_privilege(current_user,pg_class.oid,'TRIGGER'))) AS dangerous
 FROM pg_roles WHERE rolname=current_user`);
 const r=rows[0];if(rows.length!==1||r.database!==c.database||r.role!==c.role||!r.rolcanlogin||['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','rolinherit','schema_create','database_create','temporary'].some(k=>r[k]!==false)||r.memberships!==0||r.owned!==0||r.dangerous!==0)throw fail();
 const locks=await client.$queryRawUnsafe("SELECT t.tgname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.stock_movements'::regclass AND t.tgname='immutable_stock_movement_id' AND t.tgenabled='O' AND p.proname='phase5_append_only'");if(locks.length!==1)throw fail();
 return{database:r.database,role:r.role,verified:true};
 }catch{throw fail();}
}
module.exports={configuration,verifyRuntimeDatabase};
