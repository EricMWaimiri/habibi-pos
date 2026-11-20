'use strict';

// Explicit ECMAScript trim whitespace; ASCII casing avoids locale-dependent folds.
const MPESA_REFERENCE_SQL = "translate(btrim(reference, U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF'), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')";
const MPESA_REFERENCE_PATTERN = '^[A-Z0-9]{10}$';
const MPESA_REFERENCE_INDEX = 'payments_mpesa_reference_unique';
function normalizeMpesaReference(value) {
  return (value || '').trim().replace(/[a-z]/g, letter => letter.toUpperCase());
}
function isValidMpesaReference(value) {
  return typeof value === 'string' && /^[A-Z0-9]{10}$/.test(value);
}
module.exports = { MPESA_REFERENCE_SQL, MPESA_REFERENCE_PATTERN, MPESA_REFERENCE_INDEX,
  normalizeMpesaReference, isValidMpesaReference };
