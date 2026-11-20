'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createPrinter } = require('./fixtures/printing');
const sale = { saleNumber: 'PRINT-FIXTURE', createdAt: new Date(), total: 600 };
const items = [{ quantity: 2, unitPrice: 300, subtotal: 600, product: { name: 'Fixture bottle' } }];

test('receipts: fresh server authorization permits customer receipt and independent preparation docket', async () => {
  const p = createPrinter(); let checks = 0;
  await p.printOrder(sale, items, 'Fixture', 'actor', { authorizeReceipt: async () => { checks++; return true; } });
  assert.equal(checks, 1); assert.equal(p.receipts().length, 1); assert.equal(p.dockets().length, 1);
  assert.match(p.receipts()[0].data, /KSh 600.00/); assert.doesNotMatch(p.dockets()[0].data, /KSh|TOTAL|Receipt/);
  assert.equal(p.attempts.length, 0);
});
for (const [label, options] of [
  ['legacy missing authorization', {}], ['denied authorization', { authorizeReceipt: async () => false }],
  ['truthy untrusted value', { authorizeReceipt: async () => 'true' }],
  ['untrusted enable flag', { receipt: true, authorizeReceipt: true }],
  ['failed primary authorization', { authorizeReceipt: async () => { throw Error('Private driver details'); } }],
]) test('receipts: ' + label + ' generates only a preparation docket', async () => {
  const p = createPrinter();
  await p.printOrder(sale, items, 'Fixture', 'actor', options);
  assert.equal(p.receipts().length, 0); assert.equal(p.dockets().length, 1); assert.equal(p.files.length, 2);
  assert.doesNotMatch(JSON.stringify(p.errors), /Private driver/);
});
test('receipts: repeated printing rechecks authorization; revocation cannot reuse a prior grant', async () => {
  const p = createPrinter(); let allowed = true, checks = 0;
  const options = { authorizeReceipt: async () => { checks++; return allowed; } };
  await p.printOrder(sale, items, 'Fixture', 'actor', options); allowed = false;
  await p.printOrder(sale, items, 'Fixture', 'actor', options);
  assert.equal(checks, 2); assert.equal(p.receipts().length, 1); assert.equal(p.dockets().length, 2);
});
test('receipts: waiting receipt authorization does not delay the preparation docket', async () => {
  const p = createPrinter(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = p.printOrder(sale, items, 'Fixture', 'actor', { authorizeReceipt: () => gate });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.dockets().length, 1); assert.equal(p.receipts().length, 0);
  } finally { release(false); await pending; }
});
test('receipts: addition docket contains only added items and authorized receipt contains whole bill', async () => {
  const p = createPrinter(), added = [{ quantity: 1, product: { name: 'New ingredient' } }];
  await p.printOrder(sale, items, 'Fixture', 'actor', { added, authorizeReceipt: async () => true });
  assert.match(p.dockets()[0].data, /ADDITION|New ingredient/); assert.doesNotMatch(p.dockets()[0].data, /Fixture bottle/);
  assert.match(p.receipts()[0].data, /Fixture bottle/);
});
test('receipts: physical transport is mocked; both failures retain fallback tickets', async () => {
  const p = createPrinter(); p.config.DRY_RUN = false;
  await p.printOrder(sale, items, 'Fixture', 'actor', { authorizeReceipt: async () => true });
  assert.equal(p.attempts.length, 2); assert.equal(p.files.length, 4);
  assert(p.files.every(f => f.name.includes('_FAILED.')));
});
for (const failed of ['receipt', 'docket']) test('receipts: ' + failed + ' storage failure cannot prevent the other ticket', async () => {
  const p = createPrinter(); p.state.failSave = failed;
  await p.printOrder(sale, items, 'Fixture', 'actor', { authorizeReceipt: async () => true });
  assert.equal(failed === 'receipt' ? p.dockets().length : p.receipts().length, 1);
});
test('receipts: frontend has no manual print/reprint/receipt-preview transport or browser-print bypass', () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  assert.doesNotMatch(source, /window\.print\s*\(|\/receipt(?:s)?(?:\/|['"`])|\/reprint(?:\/|['"`])/);
  assert.match(source, /sessionGeneration/); assert.match(source, /res\.status === 403/);
});


test('branded receipt and docket preserve amounts without asserting unverified tax treatment',()=>{
 const p=createPrinter(),sale={saleNumber:'SYNTHETIC',createdAt:new Date(),total:300},items=[{quantity:3,unitPrice:100,subtotal:300,product:{name:'Long synthetic product'}}];
 const receipt=p.toPreview(p.receiptRows(sale,items,'Synthetic'));assert.match(receipt,/300\.00/);assert.match(receipt,/Amounts in KSh/);assert.doesNotMatch(receipt,/include VAT/);
 const docket=p.docketRows(sale,items,'Synthetic',false);assert(docket.some(r=>r.brandRaster));assert.match(p.toPreview(docket),/HABIBI LOUNGE/);assert.match(p.toPreview(docket),/3 x Long synthetic product/);
});


test('receipt layout displays included discounts and long multi-item bills without changing totals',()=>{
 const p=createPrinter(),items=Array.from({length:30},(_,i)=>({quantity:2,unitPrice:100,discount:10,subtotal:190,product:{name:'Synthetic very long product name '+i}}));
 const rows=p.receiptRows({saleNumber:'LONG-SYNTHETIC',createdAt:new Date(),total:5690,discount:10},items,'Synthetic');const text=p.toPreview(rows);
 assert.equal((text.match(/Discount included/g)||[]).length,30);assert.match(text,/Bill discount included/);assert.match(text,/5,690\.00/);assert.equal(items.length,30);assert(p.toBuffer(rows).length>1000);
});


test('long preparation names and notes wrap without losing kitchen/bar instructions',()=>{
 const p=createPrinter(),name='Synthetic kitchen preparation with separately packed garnish and special allergy instructions',note='Synthetic operational instruction '.repeat(6),items=[{quantity:2,unitPrice:100,subtotal:200,product:{name}}],sale={saleNumber:'SYNTHETIC',createdAt:new Date(),total:200,notes:note};
 for(const rows of [p.receiptRows(sale,items,'Synthetic'),p.docketRows(sale,items,'Synthetic',false)]){assert(rows.every(r=>r.t.length<=48));assert(rows.map(r=>r.t).join('').includes(name));assert(rows.map(r=>r.t).join('').includes(note.trim()));}
});

test('receipt reflects audited pricing deltas while retaining original line evidence',()=>{const p=createPrinter(),sale={saleNumber:'SYNTHETIC',createdAt:new Date(),total:300,financialAdjustments:[{kind:'SALE_DISCOUNT',salesDelta:-30}]},rows=p.receiptRows(sale,[{quantity:3,unitPrice:100,subtotal:300,product:{name:'Synthetic original product'}}],'Synthetic'),text=rows.map(r=>r.t).join('\n');assert(text.includes('Original bill'));assert(text.includes('Audited corrections'));assert(text.includes('270.00'));assert(text.includes('300.00'));});
