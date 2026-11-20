"use strict";
// Fixed local assets. Branding is presentation, never an authorization source.
function brandMark(variant='compact'){
 const full=variant==='full';return h('span',{class:'brand-mark brand-'+variant},h('img',{src:'/assets/branding/'+(full?'habibi-full.webp':'habibi-compact.webp'),alt:'Habibi Lounge logo',width:full?144:40,height:full?144:40,decoding:'async'}),h('span',{class:'brand-wordmark'},'HABIBI',h('small',{},'LOUNGE')));
}
