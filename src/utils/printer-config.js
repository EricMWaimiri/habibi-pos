'use strict';
const fs=require('fs'),path=require('path');
function load(env=process.env,{legacy=path.resolve(__dirname,'../../config/printers.js'),exists=fs.existsSync,read=fs.readFileSync,legacyRequire=require}={}){
 let config;
 if(env.POS_PRINTER_CONFIG){if(!path.isAbsolute(env.POS_PRINTER_CONFIG))throw Error('Printer configuration requires an absolute private JSON path');try{config=JSON.parse(read(env.POS_PRINTER_CONFIG,'utf8'));}catch{throw Error('Private printer configuration could not be validated');}}
 else if(exists(legacy))config=legacyRequire(legacy);
 else return{DRY_RUN:true,PORT:9100,COUNTER:{name:'Unconfigured receipt preview'},WAITER_PRINTERS:{},DEFAULT_WAITER:{name:'Unconfigured docket preview'}};
 if(!config||typeof config.DRY_RUN!=='boolean'||!Number.isInteger(config.PORT)||config.PORT<1||config.PORT>65535)throw Error('Private printer configuration is invalid');
 return config;
}
module.exports={load};
