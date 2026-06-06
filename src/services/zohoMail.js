const axios = require('axios');

const TOKEN_URL = 'https://accounts.zoho.in/oauth/v2/token';
const BASE_URL = 'https://mail.zoho.in/api/accounts/';

let cachedToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const res = await axios.post(TOKEN_URL, null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });

  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

async function sendMail({ toEmail, subject, htmlBody }) {
  const token = await getAccessToken();
  const endpoint = `${BASE_URL}${process.env.ZOHO_ACCOUNT_ID}/messages`;

  await axios.post(
    endpoint,
    {
      fromAddress: process.env.ZOHO_FROM_EMAIL,
      toAddress: toEmail,
      subject,
      content: htmlBody,
      mailFormat: 'html',
    },
    {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

async function sendOtpEmail(toEmail, memberName, otp) {
  const subject = 'உங்கள் OTP - UPR நட்பு சாம்ராஜ்யம்';
  const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr><td style="background:linear-gradient(135deg,#c9a227 0%,#f5d06e 50%,#c9a227 100%);border-radius:20px 20px 0 0;padding:36px;text-align:center;">
          <h1 style="margin:0;font-size:26px;font-weight:800;color:#1a1a2e;">UPR நட்பு சாம்ராஜ்யம்</h1>
          <p style="margin:6px 0 0;color:#3d2500;font-size:14px;">உங்கள் உள்நுழைவு OTP</p>
        </td></tr>
        <tr><td style="background:#1e1b4b;padding:32px;border-radius:0 0 20px 20px;">
          <p style="color:#e5e7eb;font-size:16px;margin:0 0 20px;">வணக்கம் <strong style="color:#f5d06e;">${memberName}</strong>,</p>
          <p style="color:#9ca3af;font-size:14px;margin:0 0 24px;">உங்கள் உள்நுழைவு OTP கோட்:</p>
          <div style="background:rgba(201,162,39,0.15);border:2px solid #c9a227;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
            <span style="font-size:40px;font-weight:900;letter-spacing:12px;color:#f5d06e;">${otp}</span>
          </div>
          <p style="color:#6b7280;font-size:13px;margin:0;">இந்த OTP ${process.env.OTP_EXPIRY_MINUTES || 10} நிமிடங்களில் காலாவதியாகும்.</p>
          <p style="color:#6b7280;font-size:12px;margin:16px 0 0;">இந்த மின்னஞ்சல் தானியங்கி. பதில் அளிக்க வேண்டாம்.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await sendMail({ toEmail, subject, htmlBody });
}

module.exports = { sendOtpEmail };
