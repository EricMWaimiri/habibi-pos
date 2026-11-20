'use strict';
// Never return error messages, stacks, metadata or query/configuration values.
const types=new Set(['Error','PrismaClientKnownRequestError','PrismaClientUnknownRequestError',
  'PrismaClientInitializationError','PrismaClientRustPanicError','PrismaClientValidationError','ZodError']);
module.exports=error=>({
  type:types.has(error?.name)?error.name:'Error',
  code:typeof error?.code==='string'&&/^P\d{4}$/.test(error.code)?error.code:'UNEXPECTED',
});
