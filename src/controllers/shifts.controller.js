const response = require('../utils/responses');
const { databaseInstant } = require('../utils/accounting');
const prisma = require('../config/prisma');
const { z } = require('zod');
const { getPermissionsForUser } = require('../utils/permissions');
const { withShiftTransaction, lockShiftOwner, lockOpenShift } = require('../utils/shift-transactions');

const round2 = (value) => Math.round(Number(value) * 100) / 100;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const OPEN_SCHEMA = z.object({
  openingCash: z.coerce.number().finite().min(0).default(0),
  notes: z.string().trim().max(500).optional(),
});

const CLOSE_SCHEMA = z.object({
  closingCash: z.coerce.number().finite().min(0),
  notes: z.string().trim().max(500).optional(),
});

const ID_SCHEMA = z.object({ id: z.string().min(1) });

async function getOpenShift(req, res) {
  const shift = await prisma.shift.findFirst({
    where: { openedById: req.user.id, status: 'OPEN' },
    include: {
      openedBy: { select: { id: true, name: true, role: true } },
    },
    orderBy: { openedAt: 'desc' },
  });
  res.json({ shift: response.shift(shift),businessDayDate:await require('../utils/business-day-runtime').dateForShift(prisma,await databaseInstant(prisma),shift?.id,{allowClosedPeriod:true}) });
}

async function openShift(req, res) {
  const parsed = OPEN_SCHEMA.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ message: 'Enter a valid opening cash amount' });
  }
  const input = parsed.data;

  const shift = await withShiftTransaction(prisma, async (tx) => {
    await lockShiftOwner(tx, req.user.id);

    const existing = await tx.shift.findFirst({
      where: { openedById: req.user.id, status: 'OPEN' },
    });

    if (existing) {
      throw httpError(409, 'You already have an open shift.');
    }

    const openedAt=await databaseInstant(tx),periodId=await require('../utils/business-day-runtime').capture(tx,openedAt);
    return tx.shift.create({
      data: {
        openedAt,
        ...(periodId?{businessDayPeriodId:periodId}:{}),
        openedById: req.user.id,
        openingCash: round2(input.openingCash),
        notes: input.notes || null,
        assignments: {
          create: { userId: req.user.id },
        },
      },
      include: {
        openedBy: { select: { id: true, name: true, role: true } },
      },
    });
  });

  res.status(201).json({ message: 'Shift opened', shift: response.shift(shift) });
}

async function closeShift(req, res) {
  const idParsed = ID_SCHEMA.safeParse(req.params);
  const inputParsed = CLOSE_SCHEMA.safeParse(req.body || {});
  if (!idParsed.success || !inputParsed.success) {
    return res.status(400).json({ message: 'Enter the cash counted in the drawer' });
  }
  const { id } = idParsed.data;
  const input = inputParsed.data;

  // You may close your own shift. Someone with "Manage shifts" may close any shift.
  const myPermissions = await getPermissionsForUser(req.user);
  const canCloseOthers = myPermissions.includes('shifts.manage');

  const shift = await withShiftTransaction(prisma, async (tx) => {
    // Discover/authorize the owner without locking the shift first.
    const intended = await tx.shift.findUnique({ where: { id }, select: { openedById: true } });
    if (!intended) throw httpError(404, 'Shift not found');
    if (intended.openedById !== req.user.id && !canCloseOthers) {
      throw httpError(403, 'You can only close your own shift.');
    }
    const current = await lockOpenShift(tx, intended.openedById, id, 'CASH',{allowExpired:true});

    // 1. Sum CASH payments received during this shift
    const payments = await tx.payment.aggregate({
      where: { receivedShiftId: id, method: 'CASH' },
      _sum: { amount: true },
    });
    const corrections=await tx.adjustmentCashEntry.aggregate({where:{method:'CASH',adjustment:{shiftId:id}},_sum:{amount:true}});
    const incoming=await tx.employee_finance_receipts.aggregate({where:{shift_id:id,method:'CASH'},_sum:{amount:true}});
    const cashCollected = Number(payments._sum.amount || 0)+Number(corrections._sum.amount||0)+Number(incoming._sum.amount||0);

    // 2. Sum CASH expenses paid during this shift
    const expenses = await tx.expense.aggregate({
      where: { shiftId: id, method: 'CASH', paymentStatus:'PAID' },
      _sum: { amount: true },
    });
    const cashSpent = Number(await require('../utils/accounting-cash').shiftOutflow(tx,id));

    // 3. Calculate expected cash
    // Expected = Opening Float + Cash Received - Cash Paid Out
    const expectedCash = round2(Number(current.openingCash) + cashCollected - cashSpent);

    return tx.shift.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closingCash: round2(input.closingCash),
        expectedCash,
        closedById: req.user.id,
        closedAt: await databaseInstant(tx),
        ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
      },
      include: {
        openedBy: { select: { id: true, name: true, role: true } },
        closedBy: { select: { id: true, name: true, role: true } },
      },
    });
  });

  res.json({
    message: 'Shift closed',
    shift: response.shift(shift),
    cashVariance: round2(Number(shift.closingCash) - Number(shift.expectedCash)),
  });
}

module.exports = { getOpenShift, openShift, closeShift };
