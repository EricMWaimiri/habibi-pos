'use strict';
// Repeatable database-free regression entry point. Never reads deployment credentials.
const cp=require('child_process'),crypto=require('crypto'),path=require('path'),fs=require('fs');
const root=path.resolve(__dirname,'../..'),files=JSON.parse(fs.readFileSync(path.join(root,'tests/RELEASE-TESTS.json')));
const env={...process.env,NODE_ENV:'test',HABIBI_TEST_RUN:'1',JWT_SECRET:crypto.randomBytes(48).toString('hex'),PIN_PEPPER:crypto.randomBytes(48).toString('hex'),JWT_EXPIRES_IN:'1h',DATABASE_URL:'postgresql://not_connected:not_connected@127.0.0.1:1/habibi_pos_phase81_no_database',DOTENV_CONFIG_QUIET:'true'};
for(const key of ['TEST_DATABASE_URL','BASE_URL','TEST_MANAGER_PIN','NODE_OPTIONS','NODE_PATH'])delete env[key];
const result=cp.spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{cwd:root,env,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
if(process.env.POS_TEST_RESULT){const counts={status:result.status===0?'PASS':'FAIL',database:'NONE: unreachable synthetic URL only',files:files.length};for(const key of ['tests','pass','fail','skipped']){const m=(result.stdout||'').match(new RegExp('^# '+key+' (\\d+)','m'));if(m)counts[key]=Number(m[1]);}fs.writeFileSync(process.env.POS_TEST_RESULT,JSON.stringify(counts,null,2)+'\n',{flag:'wx'});}
process.exitCode=result.status===0?0:1;
