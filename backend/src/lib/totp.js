// TOTP (RFC 6238) two-factor auth, implemented directly on Node's
// built-in crypto rather than pulled from a library - same reasoning as
// lib/telegram.js and middleware/rateLimit.js: this is a small, fully
// standard algorithm (HMAC-SHA1 over a 30-second time counter, per
// RFC 4226/6238), and every authenticator app (Google Authenticator,
// Authy, 1Password, etc.) already implements the same spec, so there's
// nothing a dependency would add except another thing to keep updated.

import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20; // 160 bits - the RFC 4226 recommended minimum

function base32Encode(buffer) {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder) {
    output += BASE32_ALPHABET[parseInt(bits.slice(bits.length - remainder).padEnd(5, "0"), 2)];
  }
  return output;
}

function base32Decode(input) {
  const clean = String(input || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) continue;
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// A fresh secret for setup, encoded the way authenticator apps expect
// (base32, no padding) - never the raw bytes.
export function generateSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

// otpauth:// URI an authenticator app can import directly if scanned
// from a rendered QR code, or the raw secret can be typed in manually -
// Starlink Monitor doesn't render a QR image itself (no new dependency for it), so
// the setup screen shows both the URI and the bare secret.
export function otpauthUrl({ secret, email, issuer = "Starlink Monitor" }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

// Accepts a code from the current 30s step or one step either side -
// the standard tolerance window, so a slow typist or a slightly-off
// device clock isn't locked out of their own account.
export function verifyTotp(secret, token) {
  if (!secret || !token) return false;
  const clean = String(token).trim();
  if (!/^\d{6}$/.test(clean)) return false;
  const secretBuffer = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (const drift of [0, -1, 1]) {
    if (hotp(secretBuffer, counter + drift) === clean) return true;
  }
  return false;
}

// Recovery codes for when the authenticator device itself is lost.
// Returned as plaintext once at generation time; callers are
// responsible for bcrypt-hashing before storing, same as a password.
export function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) codes.push(crypto.randomBytes(5).toString("hex"));
  return codes;
}
