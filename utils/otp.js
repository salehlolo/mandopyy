const crypto = require('crypto');

function genCode6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function now() {
  return Date.now();
}

function ttlMs(minutes) {
  return Number(minutes) * 60 * 1000;
}

module.exports = {
  genCode6,
  sha256,
  now,
  ttlMs
};
