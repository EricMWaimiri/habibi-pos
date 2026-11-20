'use strict';
// Credentials/session internals never enter this explicit metadata projection.
async function record(tx,actorId,before,after,credentialAction){
 const changed=['name','role','isActive','commissionRate'].filter(k=>!before||String(before[k])!==String(after[k]));
 if(!changed.length&&!credentialAction)return;
 const view=u=>u?{targetId:u.id,role:u.role,isActive:u.isActive}:{};
 return tx.administrationEvent.create({data:{actorId,targetUserId:after.id,scope:'USERS',categories:['staff'],
  reason:!before?'Staff account created':credentialAction?'Staff credentials changed':'Staff account updated',
  before:view(before),after:{...view(after),changedFields:changed,credentialChanged:!!credentialAction,
   ...(credentialAction?{credentialAction}:{})}}});
}
module.exports={record};
