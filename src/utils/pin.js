const crypto = require('crypto');

/**
 * Validate that a PIN is 4 to 6 digits only.
 */
function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin);
}

/**
 * Hash a PIN with HMAC-SHA256 using PIN_PEPPER. Returns hex output.
 */
function hashPin(pin, pepper) {
  return crypto.createHmac('sha256', pepper).update(pin).digest('hex');
}

module.exports = { isValidPin, hashPin };