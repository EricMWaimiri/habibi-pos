const pad = (n, size) => String(n).padStart(size, '0');

function todayParts() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
  return { startOfDay, ymd };
}

// Numbers like EXP-20261023-0004 (reset each day)
async function makeExpenseNumber(tx) {
  const { startOfDay, ymd } = todayParts();
  const count = await tx.expense.count({ where: { createdAt: { gte: startOfDay } } });
  return `EXP-${ymd}-${pad(count + 1, 4)}`;
}

// Numbers like PUR-20261023-0002 (reset each day)
async function makePurchaseNumber(tx) {
  const { startOfDay, ymd } = todayParts();
  const count = await tx.purchase.count({ where: { createdAt: { gte: startOfDay } } });
  return `PUR-${ymd}-${pad(count + 1, 4)}`;
}

// If two requests got the same number at the same moment, try again with the next one
async function retryOnDuplicate(work, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (err.code === 'P2002' && attempt < tries) continue;
      throw err;
    }
  }
}

module.exports = { makeExpenseNumber, makePurchaseNumber, retryOnDuplicate };