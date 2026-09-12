const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Public fallback — only here so a missing env var cannot take login down.
// Set JWT_SECRET in the deployment environment and this is never used.
const FALLBACK_SECRET = 'upr-ganesapuram-otp-secret';
const SECRET = process.env.JWT_SECRET || FALLBACK_SECRET;
const EXPIRY = (parseInt(process.env.OTP_EXPIRY_MINUTES, 10) || 10) * 60; // seconds

if (!process.env.JWT_SECRET) {
  console.warn('[otp] JWT_SECRET is not set — signing with a publicly known fallback. Set JWT_SECRET now.');
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function hashOtp(email, otp) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${email.toLowerCase()}:${otp}`)
    .digest('hex');
}

// The token carries only an HMAC of the OTP. A JWT payload is base64, not
// encrypted, so putting the OTP itself in here hands the code to the caller.
function createOtpToken(email, otp) {
  return jwt.sign(
    { email: email.toLowerCase(), otpHash: hashOtp(email, otp) },
    SECRET,
    { expiresIn: EXPIRY }
  );
}

function verifyOtpToken(token, email, otp) {
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.email !== email.toLowerCase()) return false;

    const provided = Buffer.from(String(decoded.otpHash || ''), 'utf8');
    const expected = Buffer.from(hashOtp(email, String(otp)), 'utf8');
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

module.exports = { generateOtp, createOtpToken, verifyOtpToken };
