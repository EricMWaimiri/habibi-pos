'use strict';
// Use the project's already installed, server-shipped browser client bundle.
// Native Node WebSocket exercises the same Engine.IO/Socket.IO protocol.
const {EventEmitter}=require('node:events');
const WebSocket=require('ws');
function socketClient(base, token) {
  // Test-side Engine.IO client with real Cookie headers. No production bearer
  // fallback: the only handshake auth field is the cookie-bound CSRF proof.
  const claims=token?require('jsonwebtoken').decode(token):null,host=claims?.aud||new URL(base).host;
  const cookie=token?'__Host-habibi_session='+encodeURIComponent(token):'';
  const proof=require('../src/utils/web-session').proof({headers:{host,cookie}});
  const socket=new EventEmitter();socket.connected=false;socket.auth=token===undefined?{}:{csrfToken:proof};socket.io={opts:{query:undefined}};
  let ws,ended=false;
  const deliver=(name,...values)=>EventEmitter.prototype.emit.call(socket,name,...values);
  socket.connect=()=>{const url=new URL(base);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/socket.io/';url.search='EIO=4&transport=websocket';for(const[k,v]of Object.entries(socket.io.opts.query||{}))url.searchParams.set(k,v);ws=new WebSocket(url,{headers:{Host:host,Origin:'https://'+host,...(cookie?{Cookie:cookie}:{})}});ws.on('message',buffer=>{const text=String(buffer);if(text.startsWith('0'))ws.send('40'+JSON.stringify(socket.auth));else if(text==='2')ws.send('3');else if(text.startsWith('40')){socket.connected=true;socket.id=JSON.parse(text.slice(2)).sid;deliver('connect');}else if(text.startsWith('44')){const data=JSON.parse(text.slice(2));deliver('connect_error',Object.assign(Error(data.message),{data:data.data}));}else if(text==='41'){socket.connected=false;ended=true;deliver('disconnect','io server disconnect');ws.close();}else if(text.startsWith('42')){const[name,...args]=JSON.parse(text.slice(2));deliver(name,...args);}});ws.on('error',()=>deliver('connect_error',Error('Socket transport failed')));ws.on('close',()=>{if(!ended&&socket.connected){socket.connected=false;deliver('disconnect','transport close');}});return socket;};
  socket.emit=(name,...args)=>{if(ws?.readyState===WebSocket.OPEN)ws.send('42'+JSON.stringify([name,...args]));return socket;};
  socket.close=socket.disconnect=()=>{ended=true;if(ws?.readyState===WebSocket.OPEN)ws.close();else ws?.terminate();socket.connected=false;return socket;};return socket;
}
function event(socket, name, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, receive); reject(Error('Socket checkpoint timed out: ' + name)); }, timeout);
    function receive(value) { clearTimeout(timer); resolve(value); }
    socket.once(name, receive);
  });
}
async function connected(socket) { const ready = event(socket, 'connect', 4500); socket.connect(); await ready; return socket; }
module.exports = { socketClient, event, connected };
