'use strict';
// Generates reviewed target-specific files only. Never connects or executes SQL.
const fs=require('fs'),path=require('path'),a=require('assert/strict'),{prepare}=require('./prepare-bundle.cjs');
if(process.argv.length!==5)throw Error('Usage: node prepare-installation.cjs SOURCE DESTINATION TARGET_JSON');
const source=path.resolve(process.argv[2]),dest=path.resolve(process.argv[3]),target=JSON.parse(fs.readFileSync(process.argv[4]));
a(/^[a-z][a-z0-9_]+$/.test(target.runtimeRole));a(Number.isInteger(target.port)&&target.port>0&&target.port<=65535);a.notEqual(target.role,target.runtimeRole);
const expected=JSON.parse(fs.readFileSync(path.join(source,'SOURCE-MANIFEST.json')));
a.equal(require('crypto').createHash('sha256').update(fs.readFileSync(path.join(source,'schema.prisma'))).digest('hex'),expected.schemaSha256);const manifest=prepare(source,dest,expected.migrations,target),grants=path.join(dest,'grants');fs.mkdirSync(grants);
for(const name of fs.readdirSync(path.join(__dirname,'grants')).sort()){
 let text=fs.readFileSync(path.join(__dirname,'grants',name),'utf8');
 const values={DATABASE:target.database,MIGRATION_ROLE:target.role,RUNTIME_ROLE:target.runtimeRole,OID:target.oid,CLUSTER:target.cluster,PORT:target.port};
 for(const[k,v]of Object.entries(values))text=text.replaceAll('{{'+k+'}}',String(v));a(!text.includes('{{'));
 fs.writeFileSync(path.join(grants,name.replace('.template','')),text,{flag:'wx'});
}
console.log('Prepared target-bound migration bundle and per-object grants. Review manifest and SQL before execution.');
