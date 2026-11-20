"use strict";
// Recheck the originating user's CURRENT authority in the deciding transaction.
// A prior request, JWT role or base-role grant is not a continuing capability.
const {resolveUserPermissions}=require('./custom-role-policy');
const denied=()=>Object.assign(Error('Requester no longer holds the originating permission; reject or prepare a new request.'),{status:409});
async function requireApprovalRequester(tx,userId,permission){
 const user=await tx.user.findUnique({where:{id:userId},select:{id:true,isActive:true,role:true}});
 if(!user?.isActive||!permission)throw denied();
 const permissions=await resolveUserPermissions(tx,user);
 if(!permissions.includes(permission))throw denied();
 return user;
}
module.exports={requireApprovalRequester};
