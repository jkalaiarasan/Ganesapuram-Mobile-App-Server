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
<body style="margin:0;padding:0;background-color:#06040C;font-family:Georgia,'Times New Roman',serif;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#06040C">
<tr><td align="center" style="padding:48px 16px;">

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;">

    <!-- Top gold bar -->
    <tr><td style="height:1px;line-height:1px;font-size:0;" bgcolor="#7A5C10">&nbsp;</td></tr>
    <tr><td style="height:3px;line-height:3px;font-size:0;" bgcolor="#D4AF37">&nbsp;</td></tr>
    <tr><td style="height:1px;line-height:1px;font-size:0;" bgcolor="#7A5C10">&nbsp;</td></tr>

    <!-- Header -->
    <tr>
      <td bgcolor="#0D0920" style="padding:44px 48px 32px;text-align:center;">
        <p style="margin:0 0 12px;font-size:10px;font-weight:700;letter-spacing:5px;color:#C8A951;text-transform:uppercase;">UPR நட்பு சாம்ராஜ்யம்</p>
        <h1 style="margin:0 0 10px;font-size:32px;font-weight:700;color:#F0E8D5;letter-spacing:3px;font-style:italic;">கணேசாபுரம்</h1>
        <p style="margin:0 0 24px;font-size:10px;color:#8A7050;letter-spacing:4px;text-transform:uppercase;">உறுப்பினர் சரிபார்ப்பு</p>
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="height:1px;font-size:0;background-color:#1E1630;">&nbsp;</td>
          <td style="font-size:13px;color:#C8A951;text-align:center;padding:0 14px;line-height:1;white-space:nowrap;">◆</td>
          <td style="height:1px;font-size:0;background-color:#1E1630;">&nbsp;</td>
        </tr></table>
      </td>
    </tr>

    <!-- Header → body gold line -->
    <tr><td style="height:1px;line-height:1px;font-size:0;" bgcolor="#D4AF37">&nbsp;</td></tr>

    <!-- Body -->
    <tr>
      <td bgcolor="#0A0716" style="padding:40px 48px 44px;">

        <p style="margin:0 0 4px;font-size:12px;color:#8A7050;letter-spacing:1px;">வணக்கம்,</p>
        <p style="margin:0 0 28px;font-size:20px;font-weight:600;color:#D4AF37;letter-spacing:0.5px;">${memberName}</p>

        <p style="margin:0 0 36px;font-size:14px;color:#9C8B6A;line-height:1.9;">
          உங்கள் உள்நுழைவை சரிபார்க்க கீழே உள்ள ஒரு முறை<br>கடவுச்சொல்லைப் பயன்படுத்தவும்.
        </p>

        <!-- OTP highlight block -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
          <tr><td>
            <!-- Top accent bar -->
            <table width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="height:3px;font-size:0;background-color:#D4AF37;">&nbsp;</td>
            </tr></table>
            <!-- OTP card -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td bgcolor="#100D20" style="padding:38px 24px 34px;text-align:center;">
                  <p style="margin:0 0 6px;font-size:9px;letter-spacing:6px;color:#C8A951;text-transform:uppercase;font-weight:700;">One Time Password</p>
                  <!-- Decorative centre line -->
                  <table width="220" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 22px;"><tr>
                    <td style="height:1px;font-size:0;background-color:#2A1E3C;">&nbsp;</td>
                    <td width="60" style="height:1px;font-size:0;background-color:#D4AF37;">&nbsp;</td>
                    <td style="height:1px;font-size:0;background-color:#2A1E3C;">&nbsp;</td>
                  </tr></table>
                  <!-- OTP digits -->
                  <p style="margin:0;font-size:54px;font-weight:700;color:#F2C94C;letter-spacing:16px;font-family:'Courier New',Courier,monospace;">${otp}</p>
                </td>
              </tr>
            </table>
            <!-- Bottom accent bar -->
            <table width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="height:3px;font-size:0;background-color:#D4AF37;">&nbsp;</td>
            </tr></table>
          </td></tr>
        </table>

        <!-- Expiry notice -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
          <tr>
            <td style="padding:14px 18px;border-left:3px solid #D4AF37;background-color:#0E0B1A;">
              <p style="margin:0;font-size:13px;color:#B89A60;line-height:1.6;">
                இந்த OTP <strong style="color:#F0E8D5;">${expiry} நிமிடங்களில்</strong> காலாவதியாகும்.
              </p>
            </td>
          </tr>
        </table>

        <!-- Security notice -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:14px 18px;border-left:3px solid #251A38;background-color:#080612;">
              <p style="margin:0;font-size:12px;color:#6A5848;line-height:1.8;">
                இந்த OTP-ஐ யாரிடமும் பகிர வேண்டாம். நீங்கள் OTP கோரவில்லை
                எனில் இந்த மின்னஞ்சலை புறக்கணிக்கவும்.
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>

    <!-- Body → footer gold line -->
    <tr><td style="height:1px;line-height:1px;font-size:0;" bgcolor="#D4AF37">&nbsp;</td></tr>

    <!-- Footer -->
    <tr>
      <td bgcolor="#0D0920" style="padding:22px 48px;text-align:center;">
        <p style="margin:0 0 4px;font-size:10px;color:#6A5438;letter-spacing:3px;text-transform:uppercase;">கணேசபுரம்</p>
        <p style="margin:0;font-size:10px;color:#4A3828;letter-spacing:1px;">இந்த மின்னஞ்சல் தானியங்கி. பதில் அளிக்க வேண்டாம்.</p>
      </td>
    </tr>

    <!-- Bottom gold bar -->
    <tr><td style="height:1px;line-height:1px;font-size:0;" bgcolor="#7A5C10">&nbsp;</td></tr>
    <tr><td style="height:3px;line-height:3px;font-size:0;" bgcolor="#D4AF37">&nbsp;</td></tr>
    <tr><td style="height:1px;line-height:1px;font-size:0;" bgcolor="#7A5C10">&nbsp;</td></tr>

  </table>

</td></tr>
</table>

</body>
</html>`;

  await sendMail({ toEmail, subject, htmlBody });
}

module.exports = { sendOtpEmail };
