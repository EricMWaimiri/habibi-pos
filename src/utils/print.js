// src/utils/print.js
// Builds receipts and dockets and sends them to the printers (or saves them in prints/ in DRY_RUN mode).
// A printer problem must NEVER stop an order, and one failing printer must not stop the other ticket.
const net = require('net');
const fs = require('fs');
const path = require('path');
const printers = require('./printer-config').load();

const COLS = 48; // characters per line on 80 mm paper (double-size text holds half of that)

// ---------- small helpers ----------
const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?'); // the printer only understands plain characters

function money(n) {
  return 'KSh ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const nairobi = { timeZone: 'Africa/Nairobi' };
const dateText = (d) => new Date(d).toLocaleString('en-GB', nairobi);
const timeText = (d) => new Date(d).toLocaleTimeString('en-GB', nairobi);

// A ticket is a list of rows. Each row: { t: text, align, bold, big, tall }
const row = (t, opts = {}) => ({ t: ascii(t), ...opts });
const rule = (ch = '-') => row(ch.repeat(COLS));
const wrapped=(text,opts={})=>(ascii(text).match(new RegExp('.{1,'+(opts.big?COLS/2:COLS)+'}','g'))||[]).map(line=>row(line,opts));

// "left            right" on one line
function pair(left, right, opts = {}) {
  const cols = opts.big ? COLS / 2 : COLS;
  left = ascii(left);
  right = ascii(right);
  if (left.length > cols - right.length - 1) left = left.slice(0, cols - right.length - 1);
  return row(left + ' '.repeat(cols - left.length - right.length) + right, opts);
}

// ---------- the two tickets ----------
function receiptRows(sale, items, waiterName, settings = null) {
  const general=settings?.general,documents=settings?.documents;
  const rows = [
    ...require('./branding').receiptLogoRows(),
    ...wrapped((general?.name||'Habibi Lounge').toUpperCase(), { align: 'center', big: true, bold: true }),
    ...(general?.address?wrapped(general.address,{align:'center'}):[]),...(general?.phone?[row(general.phone,{align:'center'})]:[]),
    row('Receipt', { align: 'center' }),
    rule('='),
    row(`Order : ${sale.saleNumber}`),
    row(`Date  : ${dateText(sale.createdAt)}`),
    ...(documents?.receiptShowStaff===false?[]:[row(`Waiter: ${waiterName || 'Counter'}`)]),
    rule(),
  ];
  for (const it of items) {
    const name = it.product?.name || 'Item';
    rows.push(...wrapped(`${Number(it.quantity)} x ${name}`));
    rows.push(pair(`   @ ${Number(it.unitPrice).toFixed(2)}`, Number(it.subtotal).toFixed(2)));
    if (Number(it.discount) > 0) rows.push(pair('   Discount included', money(it.discount)));
  }
  rows.push(rule());
  if (Number(sale.discount) > 0) rows.push(pair('Bill discount included', money(sale.discount)));
  const Decimal=require('@prisma/client').Prisma.Decimal;
  const correction=(sale.financialAdjustments||[]).reduce((n,a)=>n.add(a.salesDelta),new Decimal(0));
  if(!correction.isZero()){rows.push(pair('Original bill',money(sale.total)));rows.push(pair('Audited corrections',money(correction)));}
  rows.push(pair('TOTAL', money(new Decimal(sale.total).add(correction)), { big: true, bold: true }));
  rows.push(row('Amounts in KSh'));
  if (sale.notes && documents?.receiptShowNotes!==false) rows.push(...wrapped(`Note: ${sale.notes}`));
  const footer=documents?.receiptFooter??'Thank you!';if(footer)rows.push(...wrapped(footer,{align:'center'}));
  return rows;
}

function docketRows(sale, items, waiterName, isAddition) {
  const rows = [
    ...require('./branding').receiptLogoRows(),
    row('HABIBI LOUNGE', { align: 'center', bold: true }),
    row(isAddition ? 'ADDITION' : 'DOCKET', { align: 'center', big: true, bold: true }),
    rule('='),
    row(`Order : ${sale.saleNumber}`),
    row(`Time  : ${timeText(isAddition ? new Date() : sale.createdAt)}`),
    row(`Waiter: ${waiterName || 'Counter'}`),
    rule(),
  ];
  for (const it of items) {
    const name = it.product?.name || 'Item';
    rows.push(...wrapped(`${Number(it.quantity)} x ${name}`, { bold: true, tall: true }));
  }
  if (sale.notes) {
    rows.push(rule());
    rows.push(...wrapped(`NOTE: ${sale.notes}`));
  }
  return rows;
}

// ---------- turning rows into printer bytes / readable text ----------
function toBuffer(rows) {
  const parts = [Buffer.from([0x1b, 0x40])]; // reset the printer
  for (const r of rows) {
    if(r.brandRaster){const b=r.brandRaster;parts.push(Buffer.from([0x1b,0x61,1,0x1d,0x76,0x30,0,b.widthBytes,0,b.height,0]),Buffer.from(b.data,'base64'),Buffer.from([0x0a]));continue;}
    const size = r.big ? 0x11 : r.tall ? 0x01 : 0x00; // double both / double height / normal
    parts.push(Buffer.from([0x1b, 0x61, r.align === 'center' ? 1 : 0])); // alignment
    parts.push(Buffer.from([0x1b, 0x45, r.bold ? 1 : 0])); // bold
    parts.push(Buffer.from([0x1d, 0x21, size]));
    parts.push(Buffer.from(r.t + '\n', 'latin1'));
  }
  parts.push(Buffer.from([0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00, 0x1b, 0x61, 0x00])); // back to normal
  parts.push(Buffer.from([0x1b, 0x64, 0x04])); // feed 4 lines
  parts.push(Buffer.from([0x1d, 0x56, 0x00])); // cut
  return Buffer.concat(parts);
}

function toPreview(rows) {
  return (
    rows
      .map((r) => {
        if (r.align !== 'center') return r.t;
        const cols = r.big ? COLS / 2 : COLS;
        return ' '.repeat(Math.max(0, Math.floor((cols - r.t.length) / 2))) + r.t;
      })
      .join('\n') + '\n'
  );
}

// ---------- sending ----------
function saveFiles(label, saleNumber, target, rows, failed) {
  const dir = path.join(process.cwd(), 'prints');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${stamp}_${saleNumber}_${label}_${target.name.replace(/\s+/g, '_')}${failed ? '_FAILED' : ''}`;
  fs.writeFileSync(path.join(dir, base + '.bin'), toBuffer(rows));
  fs.writeFileSync(path.join(dir, base + '.txt'), toPreview(rows));
  return base;
}

function sendToPrinter(ip, buffer, port = printers.PORT) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Printer ${ip} timed out`));
    }, 5000);
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.connect(port, ip, () => {
      socket.write(buffer, () => {
        clearTimeout(timer);
        socket.end();
        resolve();
      });
    });
  });
}

// Prints one ticket. Never throws. If the printer fails, the ticket is saved in prints/ as _FAILED
// so nothing is lost and you can see what did not print.
async function printTicket(label, sale, target, rows, config = printers) {
  // Dry-run proves bitmap output. Existing physical text printers remain unchanged
  // until their raster capability is accepted in reviewed deployment configuration.
  rows=(config.DRY_RUN||config.RASTER_LOGO===true)?rows:rows.filter(r=>!r.brandRaster);
  if (config.DRY_RUN) {
    const base = saveFiles(label, sale.saleNumber, target, rows, false);
    console.log(`[PRINT DRY-RUN] ${label} -> prints/${base}.txt`);
    return;
  }
  try {
    await sendToPrinter(target.ip, toBuffer(rows), config.PORT);
  } catch (err) {
    console.error(`[PRINT ERROR] ${label} for ${sale.saleNumber} (${target.ip}): ${err.message}`);
    try {
      saveFiles(label, sale.saleNumber, target, rows, true);
    } catch (e) {
      console.error('[PRINT ERROR] could not save the failed ticket:', e.message);
    }
  }
}

// Which printer is this waitress's? By her id, or by her name. Counter orders print at the counter.
function receiptPrinter(waiterId, waiterName, config = printers) {
  if (!waiterId && !waiterName) return config.COUNTER;
  const map = config.WAITER_PRINTERS || {};
  if (waiterId && map[waiterId]) return map[waiterId];
  const wanted = String(waiterName || '').trim().toLowerCase();
  for (const key of Object.keys(map)) {
    if (wanted && key.trim().toLowerCase() === wanted) return map[key];
  }
  return config.DEFAULT_WAITER;
}

/**
 * sale        : the order from loadSale
 * items       : ALL items of the order (for the receipt)
 * options.added: items just ADDED to an existing order (docket then says ADDITION and lists only these)
 * options.authorizeReceipt: trusted server callback performing fresh authorization.
 * Missing/failed authorization suppresses only the optional customer receipt.
 * Never accept this callback or a receipt-enable flag from request data.
 */
async function printOrder(sale, items, waiterName, waiterId, options = {}) {
  let settings;try{settings=await require('./settings').documentSettings();}catch{console.error('[PRINT ERROR] Configuration unavailable; automatic print suppressed.');return;}
  const config=require('./docket-routing').routeConfig(printers,settings);
  const added = options.added || null;
  // Each branch starts independently, including synchronous dry-run I/O errors.
  // Financial work has already committed; neither branch may invite its retry.
  await Promise.allSettled([
    Promise.resolve().then(async () => {const plan=require('./docket-routing').docketPlan(sale,added||items,waiterName,config,Boolean(added),docketRows);await Promise.allSettled(plan.map(job=>Promise.resolve().then(()=>printTicket(job.label,sale,job.target,job.rows,config))));}).catch(()=>{console.error('[PRINT ERROR] Docket route unavailable; automatic docket suppressed.');}),
    Promise.resolve().then(async () => {
      if (typeof options.authorizeReceipt !== 'function' || await options.authorizeReceipt() !== true) return;
      const receipt = receiptRows(sale, items, waiterName, settings);
      await printTicket('receipt', sale, receiptPrinter(waiterId, waiterName, config), receipt,config);
    }),
  ]);
}

module.exports = { printOrder, receiptRows, docketRows, toPreview, toBuffer };
