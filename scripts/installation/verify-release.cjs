'use strict';
// Source-only verification. No database connections or application imports.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),a=require('assert/strict');
const root=path.resolve(__dirname,'../..'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'prisma/SOURCE-MANIFEST.json')));
a.equal(manifest.migrations.length,31);a.deepEqual(manifest.migrations.map(x=>x.name),manifest.migrations.map(x=>x.name).sort());
const dirs=fs.readdirSync(path.join(root,'prisma/migrations'),{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort();a.deepEqual(dirs,manifest.migrations.map(x=>x.name));
for(const m of manifest.migrations)a.equal(hash(fs.readFileSync(path.join(root,'prisma/migrations',m.name,'migration.sql'))),m.sha256,m.name);
a.equal(hash(fs.readFileSync(path.join(root,'prisma/schema.prisma'))),manifest.schemaSha256);a.equal((fs.readFileSync(path.join(root,'prisma/schema.prisma'),'utf8').match(/^model /gm)||[]).length,73);
const overlays=JSON.parse(fs.readFileSync(path.join(root,'prisma/OVERLAYS.json')));a.equal(overlays.length,4);for(const o of overlays)a.equal(hash(fs.readFileSync(path.join(root,o.path))),o.sha256,o.path);
a(fs.readFileSync(path.join(root,'.gitattributes'),'utf8').includes('/prisma/migrations/** -text'));
let imports=0;function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(js|cjs)$/.test(e.name)){const text=fs.readFileSync(p,'utf8');for(const m of text.matchAll(/require\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)){require.resolve(path.resolve(path.dirname(p),m[1]));imports++;}}}}
walk(path.join(root,'src'));walk(path.join(root,'scripts/installation'));
console.log(JSON.stringify({status:'PASS',databaseAccess:false,migrations:31,models:73,overlays:4,relativeImports:imports,migration16:'Original bytes retained; use target-bound prepare-installation procedure'}));
