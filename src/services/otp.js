const jwt = require('jsonwebtoken');

const SECRET  = process.env.JWT_SECRET || 'upr-ganesapuram-otp-secret';
const EXPIRY  = (parseInt(process.env.OTP_EXPIRY_MINUTES, 10) || 10) * 60; // seconds

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Returns a signed token containing the OTP — no server-side state needed
function createOtpToken(email, otp) {
  return jwt.sign({ email: email.toLowerCase(), otp }, SECRET, { expiresIn: EXPIRY });
}

// Returns true/false; throws if token is expired or tampered
function verifyOtpToken(token, email, otp) {
  try {
    const decoded = jwt.verify(token, SECRET);
    return decoded.email === email.toLowerCase() && decoded.otp === String(otp);
  } catch {
    return false;
  }
}

module.exports = { generateOtp, createOtpToken, verifyOtpToken };
