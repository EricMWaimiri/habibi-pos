const { Prisma } = require('@prisma/client');

async function lockProducts(tx, ids) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  // Quantity and count-claim changes do not change product keys. This mode
  // serializes writers while allowing SaleItem/ProductComponent FK KEY SHARE.
  const rows = await tx.$queryRaw`SELECT id FROM products WHERE id IN (${Prisma.join(unique)}) ORDER BY id FOR NO KEY UPDATE`;
  if (rows.length !== unique.length) throw Object.assign(new Error('One or more stock products no longer exist.'), { status: 409 });
}
module.exports = { lockProducts };
