const prisma = require('../config/prisma');

/** GET /api/products - what can be sold (no cost prices, no stock figures) */
const F = require('../utils/filters');
async function listProducts(req, res) {
  const f=F.filters(req.query);
  const paged=Object.keys(req.query||{}).length>0;
  if(f.range||f.shiftId||f.staffId)throw Object.assign(new Error('This is a current stock/catalogue view. Use the movement ledger for historical date and shift filters.'),{status:400});
  const where={...(f.q?{OR:[{name:F.contains(f.q)},{productCode:F.contains(f.q)}]}:{}),isActive:true,price:{gt:0}};
  const products = await prisma.product.findMany({
    where, ...(paged?{take:f.pageSize,skip:(f.page-1)*f.pageSize}:{}), // price 0 = ingredients like drums: hidden
    select: { id: true, name: true, price: true, categoryId: true },
    orderBy: [{name:'asc'},{id:'asc'}],
  });
  const categories = await prisma.category.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const total=paged?await prisma.product.count({where}):products.length;
  res.json({ categories, products, ...(paged?{pagination:{page:f.page,pageSize:f.pageSize,total,pages:Math.ceil(total/f.pageSize)}}:{}) });
}

module.exports = { listProducts };
