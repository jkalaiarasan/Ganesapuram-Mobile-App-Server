const NodeCache = require('node-cache');

const otpCache = new NodeCache({ stdTTL: (process.env.OTP_EXPIRY_MINUTES || 10) * 60 });

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function storeOtp(email, otp) {
  otpCache.set(email.toLowerCase(), otp);
}

function verifyOtp(email, otp) {
  const stored = otpCache.get(email.toLowerCase());
  if (!stored) return false;
  const valid = stored === String(otp);
  if (valid) otpCache.del(email.toLowerCase());
  return valid;
}

module.exports = { generateOtp, storeOtp, verifyOtp };
