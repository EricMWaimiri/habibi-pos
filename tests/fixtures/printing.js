'use strict';
// Actual printer service in a VM: no physical network or filesystem output.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
function createPrinter() {
  const files = [], attempts = [], errors = [];
  const config = { DRY_RUN: true, PORT: 9100, COUNTER: { name: 'Fixture counter', ip: 'unused' }, DEFAULT_WAITER: { name: 'Fixture waiter', ip: 'unused' } };
  const state = { failSave: null, settings:null, settingsError:false };
  class OfflineSocket extends EventEmitter {
    connect(port, ip) { attempts.push({ port, ip }); queueMicrotask(() => this.emit('error', Error('Fixture printer offline'))); }
    destroy() {}
  }
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/utils/print.js'), 'utf8'), {
    module: mod, Buffer, process: { cwd: () => '/virtual-test' }, setTimeout, clearTimeout,
    console: { log() {}, error: message => errors.push(message) },
    require: id => ({ '@prisma/client':require('@prisma/client'), './branding':require('../../src/utils/branding'),'./docket-routing':require('../../src/utils/docket-routing'), net: { Socket: OfflineSocket }, path, './settings': {documentSettings:async()=>{if(state.settingsError)throw Error('Fixture settings unavailable');return state.settings;}}, './printer-config': {load:()=>config}, '../../config/printers': config,
      fs: { existsSync: () => true, writeFileSync(name, data) {
        if (state.failSave && name.includes('_' + state.failSave + '_')) throw Error('Fixture storage failure');
        files.push({ name, data });
      } } })[id],
  });
  return { ...mod.exports, files, attempts, errors, config, state,
    receipts: () => files.filter(f => f.name.includes('_receipt_') && f.name.endsWith('.txt')),
    dockets: () => files.filter(f => f.name.includes('_docket_') && f.name.endsWith('.txt')) };
}
module.exports = { createPrinter };
