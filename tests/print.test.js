'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { receiptRows, docketRows, toPreview } = require('../src/utils/print');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');

test('print: receipt totals, docket privacy and addition formatting without I/O', () => {
  const sale = {saleNumber:'HAB-TEST',createdAt:new Date('2026-10-29T12:00:00Z'),total:2100};
  const items = [
    {quantity:2,unitPrice:300,subtotal:600,product:{name:'Test bottle'}},
    {quantity:1,unitPrice:1500,subtotal:1500,product:{name:'A very long product name that must be cut to fit on one line'}},
  ];
  const receipt = toPreview(receiptRows(sale,items,'Fixture'));
  const docket = toPreview(docketRows(sale,items,'Fixture',false));
  assert.match(receipt,/KSh 2,100.00/); assert.doesNotMatch(receipt,/Prices include VAT/);
  assert.match(docket,/2 x Test bottle/); assert.doesNotMatch(docket,/KSh/);
  assert([...receipt.split('\n'),...docket.split('\n')].every(line=>line.length<=48));
  const added = toPreview(docketRows(sale,[items[0]],'Fixture',true));
  assert.match(added,/ADDITION/); assert.doesNotMatch(added,/A very long/);
});

test('print: dry-run and failed-printer fallback preserve both tickets without network/filesystem I/O', async () => {
  const saved = new Map(), errors = [];
  let attempts = 0;
  class FailedSocket extends EventEmitter {
    connect() { attempts++; queueMicrotask(()=>this.emit('error',new Error('simulated offline printer'))); }
    destroy() {}
  }
  const config = {DRY_RUN:true,PORT:9100,COUNTER:{name:'Test counter',ip:'unused'},DEFAULT_WAITER:{name:'Test waiter',ip:'unused'}};
  const fakeFs = {existsSync:()=>true,writeFileSync:(name,data)=>saved.set(name,data)};
  const mod = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/utils/print.js'),'utf8'),{
    module:mod,Buffer,process:{cwd:()=>'/virtual-test'},setTimeout,clearTimeout,
    console:{log:()=>{},error:message=>errors.push(message)},
    require:id=>({'@prisma/client':require('@prisma/client'),'./branding':require('../src/utils/branding'),'./docket-routing':require('../src/utils/docket-routing'),'net':{Socket:FailedSocket},'fs':fakeFs,'path':path,'./settings':{documentSettings:async()=>null},'./printer-config':{load:()=>config},'../../config/printers':config})[id],
  });
  const sale = {saleNumber:'TEST',createdAt:new Date(),total:300};
  const items = [{quantity:1,unitPrice:300,subtotal:300,product:{name:'Test item'}}];
  await mod.exports.printOrder(sale,items,'Fixture','test', { authorizeReceipt: async () => true });
  assert.equal(attempts,0); assert.equal(saved.size,4,'two text and two binary tickets');
  saved.clear(); config.DRY_RUN = false;
  await mod.exports.printOrder(sale,items,'Fixture','test', { authorizeReceipt: async () => true });
  assert.equal(attempts,2); assert.equal(saved.size,4); assert.equal(errors.length,2);
  assert([...saved.keys()].every(name=>name.includes('_FAILED.')));
});
