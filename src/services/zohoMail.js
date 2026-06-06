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
  const subject = 'உங்கள் சரிபார்ப்பு குறியீடு — கணேசபுரம்';
  const expiry  = process.env.OTP_EXPIRY_MINUTES || 10;

  const htmlBody = `<!DOCTYPE html>
<html lang="ta">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OTP — கணேசபுரம்</title>
</head>
<body style="margin:0;padding:0;background-color:#eef3ff;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(145deg,#eef3ff 0%,#e3f5ff 45%,#f7f9ff 100%);padding:28px 14px;font-family:Segoe UI,Arial,sans-serif;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background-color:#ffffff;border-radius:18px;border:1px solid #d9e3ff;overflow:hidden;">
          <tr>
            <td style="height:6px;background:linear-gradient(90deg,#2f6bff 0%,#00a6ff 100%);font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:28px 24px 8px;text-align:center;">
              <p style="margin:0;font-size:22px;font-weight:700;color:#10213e;">கணேசபுரம்</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 8px;text-align:center;">
              <p style="margin:0;font-size:14px;line-height:1.6;color:#4a5f85;">வணக்கம் ${memberName}, உங்கள் OTP குறியீடு:</p>
            </td>
          </tr>
          <tr>
            <td style="padding:10px 24px 8px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="text-align:center;background:linear-gradient(135deg,#0f1f44 0%,#1f4ed8 100%);border-radius:14px;padding:18px 10px;">
                    <p style="margin:0 0 6px;font-size:11px;letter-spacing:3px;color:#a9c5ff;font-weight:700;">OTP</p>
                    <p style="margin:0;font-size:44px;line-height:1;font-weight:800;letter-spacing:10px;color:#ffffff;font-family:'Courier New',Courier,monospace;">${otp}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 24px 0;text-align:center;">
              <p style="margin:0;font-size:13px;color:#3f5278;">இந்த குறியீடு <strong style="color:#1f4ed8;">${expiry} நிமிடங்களில்</strong> முடியும்.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 24px 24px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#6e7f9f;">OTP யாரிடமும் பகிர வேண்டாம்.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  await sendMail({ toEmail, subject, htmlBody });
}

module.exports = { sendOtpEmail };
