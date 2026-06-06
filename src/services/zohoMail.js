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
<body style="margin:0;padding:0;background-color:#10101A;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:44px 16px;">

  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">

    <!-- Gold top strip -->
    <tr><td style="height:4px;background-color:#D4AF37;font-size:0;">&nbsp;</td></tr>

    <!-- Card -->
    <tr><td bgcolor="#1C1B2E" style="padding:40px 40px 32px;">

      <!-- Brand -->
      <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#F0E8D5;font-family:Arial,sans-serif;text-align:center;">கணேசபுரம்</p>
      
      <!-- Divider -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;"><tr><td style="height:1px;background-color:#2E2A48;font-size:0;">&nbsp;</td></tr></table>

      <!-- Greeting -->
      <p style="margin:0 0 6px;font-size:13px;color:#7A708A;font-family:Arial,sans-serif;">வணக்கம், <strong style="color:#D4AF37;">${memberName}</strong></p>
      <p style="margin:0 0 28px;font-size:14px;color:#8A8098;font-family:Arial,sans-serif;line-height:1.7;">உங்கள் உள்நுழைவு OTP குறியீடு கீழே உள்ளது.</p>

      <!-- OTP highlight box -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td style="background-color:#0C0C1A;border:2px solid #D4AF37;padding:28px 16px 24px;text-align:center;">
            <p style="margin:0 0 10px;font-size:10px;font-weight:700;letter-spacing:5px;color:#9A8050;text-transform:uppercase;font-family:Arial,sans-serif;">ONE TIME PASSWORD</p>
            <p style="margin:0;font-size:64px;font-weight:800;color:#FFD700;letter-spacing:22px;font-family:'Courier New',Courier,monospace;line-height:1.15;">${otp}</p>
          </td>
        </tr>
      </table>

      <!-- Expiry -->
      <p style="margin:0 0 20px;font-size:13px;color:#8A7860;text-align:center;font-family:Arial,sans-serif;">
        இது <strong style="color:#D4AF37;">${expiry} நிமிடங்களில்</strong> காலாவதியாகும்
      </p>

      <!-- Security -->
      <p style="margin:0;font-size:12px;color:#3E3858;text-align:center;font-family:Arial,sans-serif;line-height:1.7;">
        யாரிடமும் பகிர வேண்டாம் &nbsp;&bull;&nbsp; OTP கோரவில்லை எனில் புறக்கணிக்கவும்
      </p>

    </td></tr>

    <!-- Gold bottom strip -->
    <tr><td style="height:4px;background-color:#D4AF37;font-size:0;">&nbsp;</td></tr>

    <!-- Footer -->
    <tr>
      <td style="padding:16px 0;text-align:center;">
        <p style="margin:0;font-size:10px;color:#2E2A40;font-family:Arial,sans-serif;letter-spacing:1px;">கணேசபுரம் &bull; தானியங்கி மின்னஞ்சல்</p>
      </td>
    </tr>

  </table>

</td></tr></table>
</body>
</html>`;

  await sendMail({ toEmail, subject, htmlBody });
}

module.exports = { sendOtpEmail };
