// Copy to ignored config/printers.js. Confirm hardware before enabling output.
module.exports = {
  DRY_RUN: true,
  PORT: 9100,
  COUNTER: { name: 'Receipt/docket target', ip: 'REPLACE_WITH_CONFIRMED_IP' },
  WAITER_PRINTERS: {},
  DEFAULT_WAITER: { name: 'Default waiter target', ip: 'REPLACE_WITH_CONFIRMED_IP' },
};
