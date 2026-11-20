'use strict';
const fs=require('fs'),path=require('path'),a=require('assert/strict'),crypto=require('crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function prepare(source,destination,expected,target){
 a(/^[a-z][a-z0-9_]+$/.test(target.database));a(/^[a-z][a-z0-9_]+$/.test(target.role));a(Number.isInteger(target.oid)&&target.oid>0);a(/^\d+$/.test(target.cluster));a.equal(expected.length,31);a(!fs.existsSync(destination),'Destination must be new');
 a.equal(new Set(expected.map(e=>e.name)).size,31);a.deepEqual(expected.map(e=>e.name),expected.map(e=>e.name).sort());for(const e of expected)a(/^[0-9]{14}_[a-z0-9_]+$/.test(e.name));const planned=[];
 for(const entry of expected){const p=path.join(source,'migrations',entry.name,'migration.sql'),bytes=fs.readFileSync(p);a.equal(hash(bytes),entry.sha256,'Approved source mismatch '+entry.name);let executed=bytes;
 if(entry.name==='20261029000500_accounting_integrity'){
 const original="IF current_database() <> 'habibi_pos_test' OR current_user <> 'habibi_pos_test' THEN";const sql=bytes.toString('utf8');a.equal(sql.split(original).length,2);
 const guard=`IF current_database() IS DISTINCT FROM '${target.database}' OR current_user IS DISTINCT FROM '${target.role}' OR (SELECT oid::integer FROM pg_database WHERE datname=current_database()) IS DISTINCT FROM ${target.oid} OR (SELECT system_identifier::text FROM pg_control_system()) IS DISTINCT FROM '${target.cluster}' THEN`;
 executed=Buffer.from(sql.replace(original,guard));
 }
 planned.push({name:entry.name,sourceSha256:hash(bytes),executedSha256:hash(executed),bytes:executed});}
 fs.mkdirSync(destination,{recursive:false});fs.mkdirSync(path.join(destination,'migrations'));for(const row of planned){const dir=path.join(destination,'migrations',row.name);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'migration.sql'),row.bytes,{flag:'wx'});}
 fs.copyFileSync(path.join(source,'schema.prisma'),path.join(destination,'schema.prisma'));fs.writeFileSync(path.join(destination,'migrations','migration_lock.toml'),'provider = "postgresql"\n',{flag:'wx'});
 const manifest={target,schemaSha256:hash(fs.readFileSync(path.join(source,'schema.prisma'))),migrations:planned.map(({bytes,...rest})=>rest)};fs.writeFileSync(path.join(destination,'INSTALLATION-MANIFEST.json'),JSON.stringify(manifest,null,2),{flag:'wx'});return manifest;
}
module.exports={prepare};
