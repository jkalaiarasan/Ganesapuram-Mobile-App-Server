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
  const subject = 'உங்கள் சரிபார்ப்பு குறியீடு — கணேசாபுரம்';
  const expiry  = process.env.OTP_EXPIRY_MINUTES || 10;

  const htmlBody = `<!DOCTYPE html>
<html lang="ta">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OTP — கணேசாபுரம்</title>
</head>
<body style="margin:0;padding:0;background-color:#07050D;font-family:Georgia,'Times New Roman',serif;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#07050D">
<tr><td align="center" style="padding:52px 16px;">

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

    <!-- Top gold rule -->
    <tr>
      <td style="height:1px;line-height:1px;font-size:0;" bgcolor="#C8A951">&nbsp;</td>
    </tr>
    <tr>
      <td style="height:2px;line-height:2px;font-size:0;" bgcolor="#D4AF37">&nbsp;</td>
    </tr>
    <tr>
      <td style="height:1px;line-height:1px;font-size:0;" bgcolor="#C8A951">&nbsp;</td>
    </tr>

    <!-- Header -->
    <tr>
      <td bgcolor="#0E0A18" style="padding:48px 52px 40px;text-align:center;border-left:1px solid #1E1630;border-right:1px solid #1E1630;">

        <p style="margin:0 0 14px;font-size:10px;font-weight:700;letter-spacing:5px;color:#C8A951;text-transform:uppercase;">UPR நட்பு சாம்ராஜ்யம்</p>

        <h1 style="margin:0 0 10px;font-size:34px;font-weight:700;color:#F0E8D5;letter-spacing:3px;font-style:italic;">கணேசாபுரம்</h1>

        <p style="margin:0 0 28px;font-size:10px;color:#5E4E30;letter-spacing:4px;text-transform:uppercase;">உறுப்பினர் சரிபார்ப்பு</p>

        <!-- Ornament divider -->
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="40%" style="height:1px;font-size:0;" bgcolor="#1E1630">&nbsp;</td>
          <td style="font-size:12px;color:#C8A951;text-align:center;padding:0 14px;line-height:1;">◆</td>
          <td width="40%" style="height:1px;font-size:0;" bgcolor="#1E1630">&nbsp;</td>
        </tr></table>

      </td>
    </tr>

    <!-- Header–body separator -->
    <tr>
      <td bgcolor="#0E0A18" style="padding:0 52px;border-left:1px solid #1E1630;border-right:1px solid #1E1630;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="height:1px;font-size:0;" bgcolor="#D4AF37">&nbsp;</td>
        </tr></table>
      </td>
    </tr>

    <!-- Body -->
    <tr>
      <td bgcolor="#0B0816" style="padding:44px 52px 48px;border-left:1px solid #1E1630;border-right:1px solid #1E1630;">

        <p style="margin:0 0 4px;font-size:12px;color:#5E4E30;letter-spacing:1px;">வணக்கம்,</p>
        <p style="margin:0 0 30px;font-size:22px;font-weight:600;color:#D4AF37;letter-spacing:0.5px;">${memberName}</p>

        <p style="margin:0 0 36px;font-size:14px;color:#9C8B6A;line-height:1.85;">
          உங்கள் உள்நுழைவை சரிபார்க்க கீழே உள்ள ஒரு முறை<br>கடவுச்சொல்லைப் பயன்படுத்தவும்.
        </p>

        <!-- OTP block -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:36px;">
          <tr><td align="center">
            <table cellpadding="0" cellspacing="0" style="border:1px solid #C8A951;">
              <tr>
                <td bgcolor="#120F1C" style="padding:36px 56px;text-align:center;">
                  <p style="margin:0 0 12px;font-size:9px;letter-spacing:5px;color:#4A3820;text-transform:uppercase;">One Time Password</p>
                  <p style="margin:0;font-size:44px;font-weight:700;color:#D4AF37;letter-spacing:14px;font-family:'Courier New',Courier,monospace;">${otp}</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>

        <!-- Expiry notice -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
          <tr>
            <td style="padding:16px 20px;border-left:2px solid #D4AF37;background-color:#120F1C;">
              <p style="margin:0;font-size:13px;color:#B89A60;line-height:1.6;">
                இந்த OTP <strong style="color:#F0E8D5;">${expiry} நிமிடங்களில்</strong> காலாவதியாகும்.
              </p>
            </td>
          </tr>
        </table>

        <!-- Security notice -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:16px 20px;border-left:2px solid #2A2040;background-color:#0E0B18;">
              <p style="margin:0;font-size:12px;color:#5E4E30;line-height:1.75;">
                இந்த OTP-ஐ யாரிடமும் பகிர வேண்டாம். நீங்கள் OTP கோரவில்லை
                எனில் இந்த மின்னஞ்சலை புறக்கணிக்கவும்.
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>

    <!-- Body–footer separator -->
    <tr>
      <td bgcolor="#0E0A18" style="padding:0 52px;border-left:1px solid #1E1630;border-right:1px solid #1E1630;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="height:1px;font-size:0;" bgcolor="#D4AF37">&nbsp;</td>
        </tr></table>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td bgcolor="#0E0A18" style="padding:26px 52px;text-align:center;border-left:1px solid #1E1630;border-right:1px solid #1E1630;">
        <p style="margin:0 0 5px;font-size:10px;color:#3A2C18;letter-spacing:3px;text-transform:uppercase;">UPR நட்பு சாம்ராஜ்யம்</p>
        <p style="margin:0;font-size:10px;color:#2E2218;letter-spacing:1px;">இந்த மின்னஞ்சல் தானியங்கி. பதில் அளிக்க வேண்டாம்.</p>
      </td>
    </tr>

    <!-- Bottom gold rule -->
    <tr>
      <td style="height:1px;line-height:1px;font-size:0;" bgcolor="#C8A951">&nbsp;</td>
    </tr>
    <tr>
      <td style="height:2px;line-height:2px;font-size:0;" bgcolor="#D4AF37">&nbsp;</td>
    </tr>
    <tr>
      <td style="height:1px;line-height:1px;font-size:0;" bgcolor="#C8A951">&nbsp;</td>
    </tr>

  </table>

</td></tr>
</table>

</body>
</html>`;

  await sendMail({ toEmail, subject, htmlBody });
}

module.exports = { sendOtpEmail };
