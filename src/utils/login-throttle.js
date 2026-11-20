'use strict';
const {createHmac}=require('node:crypto');
const {isIP}=require('node:net');
const {ipKeyGenerator}=require('express-rate-limit');
const loopback=ip=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip);
function clientKey(req,env=process.env){
 const peer=req.socket?.remoteAddress||'';
 // Never enable Express trust proxy. Only the final address appended/overwritten
 // by ONE approved loopback gateway is eligible, not the attacker-controlled left.
 if(env.POS_PROXY_CLIENT_IP==='rightmost'&&loopback(peer)){
  const origins=[env.POS_LAN_ORIGIN,env.POS_REMOTE_ORIGIN,env.POS_PUBLIC_ORIGIN].filter(Boolean);
  if(origins.some(o=>{try{return new URL(o).protocol==='https:'&&new URL(o).host===req.headers.host;}catch{return false;}})){
   const raw=req.headers['x-forwarded-for'];if(typeof raw==='string'&&raw.length<=1024){const value=raw.split(',').at(-1).trim();if(isIP(value))return 'gateway:'+ipKeyGenerator(value);}
   // Missing/malformed gateway evidence shares a protected fallback, never a
   // caller-controlled/random key or an exemption from the limiter.
   return 'gateway:unverified';
  }
 }
 return 'direct:'+ipKeyGenerator(isIP(peer)?peer:'127.0.0.1');
}
function loginLimiters(env=process.env){
 if(env.POS_PROXY_CLIENT_IP!==undefined&&env.POS_PROXY_CLIENT_IP!=='rightmost')throw Error('Invalid proxy client-address configuration');
 if([env.POS_LAN_ORIGIN,env.POS_REMOTE_ORIGIN,env.POS_PUBLIC_ORIGIN].some(Boolean)&&env.POS_PROXY_CLIENT_IP!=='rightmost')throw Error('Explicit gateway client-address policy is required');
 const {rateLimit}=require('express-rate-limit');
 const common={windowMs:60000,skipSuccessfulRequests:true,message:{message:'Too many login attempts. Try again later.'},standardHeaders:true,legacyHeaders:false,validate:{keyGeneratorIpFallback:false}};
 // Per-client original five-failure budget plus a cross-client ceiling; PIN
 // digests cap repeated credential probing without retaining/logging raw PINs.
 return [rateLimit({...common,limit:50,keyGenerator:()=> 'all-login-failures'}),rateLimit({...common,limit:5,keyGenerator:req=>clientKey(req,env)}),rateLimit({...common,limit:5,keyGenerator:req=>createHmac('sha256',env.JWT_SECRET).update('login-budget\0'+String(req.body?.pin||'')).digest('hex')})];
}
module.exports={clientKey,loginLimiters};
