const response = require('../utils/responses');
const prisma = require('../config/prisma');
const { z } = require('zod');
const { SHIFT_CONTEXT_SCHEMA } = require('../utils/shift-transactions');


const CREATE_EXPENSE_SCHEMA = z.object({
  body: z.object({
    amount: z.number().positive().max(10000000),
    category: z.string().min(2).max(80).optional(),
    categoryId: z.string().min(1).optional(),
    clientRequestId: z.string().uuid(),
    reference: z.string().trim().max(100).optional(),
    description: z.string().min(2).max(200),
    method: z.enum(['CASH', 'MPESA']).default('CASH'),
    shiftId: SHIFT_CONTEXT_SCHEMA,
  }),
});

const F = require('../utils/filters');
async function getExpenses(req, res) {
  const f=F.filters(req.query); const where=F.and(F.eventScope(f),f.q?{OR:[{expenseNumber:F.contains(f.q)},{description:F.contains(f.q)},{category:F.contains(f.q)}]}:{});
  const {expenses,total}=await prisma.$transaction(async tx=>{
  const expenses = await tx.expense.findMany({
    where, orderBy: [{ createdAt: 'desc' },{ id: 'desc' }],
    take: f.pageSize, skip:(f.page-1)*f.pageSize,
    include: {
      recordedBy: { select: { name: true } },
      shift: { select: { id: true } },
    },
  });
  const total=await tx.expense.count({where});return{expenses,total};
  },{isolationLevel:'RepeatableRead',timeout:15000});
  res.json({ expenses: expenses.map(response.expense), pagination:{page:f.page,pageSize:f.pageSize,total,pages:Math.ceil(total/f.pageSize)} });
}

async function createExpense(req, res) {
  return createControlledExpense(req,res);
}


module.exports = { getExpenses, createExpense, CREATE_EXPENSE_SCHEMA };

async function createControlledExpense(req,res){const p=req.validated.body;let categoryId=p.categoryId;if(!categoryId&&p.category){const matches=await prisma.expense_categories.findMany({where:{name:p.category,is_active:true,kind:'OPERATING'},select:{id:true},take:2});if(matches.length===1)categoryId=matches[0].id;}if(!categoryId)throw Object.assign(new Error('Choose an active controlled operating expense category; use purchases for stock acquisitions.'),{status:400});const result=await require('../utils/accounting-service').mutate(prisma,req.auth,{requestId:p.clientRequestId,action:'EXPENSE_POST',shiftId:p.shiftId,reason:p.description,payload:{document:{amount:String(p.amount),categoryId,description:p.description,method:p.method,paymentStatus:'PAID',...(p.reference?{reference:p.reference}:{})}}});const expense=await prisma.expense.findUnique({where:{id:result.expenseId}});res.status(result.replayed?200:201).json({message:result.replayed?'Expense already recorded':'Expense recorded',expense:response.expense(expense),replayed:result.replayed});}
