"use strict";
const fs=require('fs'),path=require('path'),base=path.resolve(__dirname,'../../public/assets/branding');
const read=name=>{try{return fs.readFileSync(path.join(base,name));}catch{return null;}};
const png=read('habibi-print.png');let raster=null;try{const r=JSON.parse(read('thermal-raster.json'));if(r.width===128&&r.height===128&&r.widthBytes===16&&Buffer.from(r.data,'base64').length===2048)raster=Object.freeze(r);}catch{}
function documentLogo(note=''){return png?'<div class="document-brand" style="display:flex;align-items:center;gap:12px;margin-bottom:12px"><img alt="Habibi Lounge logo" width="88" height="88" style="object-fit:contain;max-width:24mm;max-height:24mm" src="data:image/png;base64,'+png.toString('base64')+'"/>'+(note?'<small>Internal purchase record · supplier invoice attribution retained</small>':'')+'</div>':'';}
function receiptLogoRows(){return raster?[{t:'[Habibi Lounge logo]',align:'center',brandRaster:raster}]:[];}
module.exports={documentLogo,receiptLogoRows};
