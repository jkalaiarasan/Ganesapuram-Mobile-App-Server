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
<body style="margin:0;padding:0;background-color:#0C0A14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0C0A14">
<tr><td align="center" style="padding:40px 16px 48px;">

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">

    <!-- Brand row above card -->
    <tr>
      <td style="padding:0 0 20px;text-align:center;">
        <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:5px;color:#C8A951;text-transform:uppercase;">UPR நட்பு சாம்ராஜ்யம்</p>
      </td>
    </tr>

    <!-- Card: gold top strip -->
    <tr><td style="height:4px;font-size:0;background-color:#D4AF37;border-radius:12px 12px 0 0;">&nbsp;</td></tr>

    <!-- Card body -->
    <tr>
      <td bgcolor="#17142A" style="padding:0;">

        <!-- Card header section -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:40px 44px 32px;text-align:center;border-bottom:1px solid #231F38;">
              <h1 style="margin:0 0 8px;font-size:26px;font-weight:700;color:#F0E8D5;letter-spacing:1px;">கணேசாபுரம்</h1>
              <p style="margin:0;font-size:11px;color:#6A5E80;letter-spacing:3px;text-transform:uppercase;">உறுப்பினர் சரிபார்ப்பு</p>
            </td>
          </tr>
        </table>

        <!-- Card content section -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:36px 44px 40px;">

              <!-- Greeting -->
              <p style="margin:0 0 4px;font-size:13px;color:#6A5E80;">வணக்கம்,</p>
              <p style="margin:0 0 24px;font-size:19px;font-weight:600;color:#D4AF37;">${memberName}</p>

              <p style="margin:0 0 32px;font-size:14px;color:#9A8AAA;line-height:1.85;">
                உங்கள் உள்நுழைவை சரிபார்க்க கீழே உள்ள ஒரு முறை கடவுச்சொல்லைப் பயன்படுத்தவும்.
              </p>

              <!-- OTP box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td style="background-color:#0F0D1E;border:1.5px solid #D4AF37;border-radius:10px;padding:30px 20px;text-align:center;">
                    <p style="margin:0 0 14px;font-size:10px;font-weight:600;letter-spacing:5px;color:#C8A951;text-transform:uppercase;">One Time Password</p>
                    <!-- Divider under label -->
                    <table cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 18px;width:80px;">
                      <tr><td style="height:1px;font-size:0;background-color:#D4AF37;">&nbsp;</td></tr>
                    </table>
                    <!-- OTP digits -->
                    <p style="margin:0;font-size:56px;font-weight:700;color:#F5D060;letter-spacing:18px;font-family:'Courier New',Courier,monospace;line-height:1;">${otp}</p>
                  </td>
                </tr>
              </table>

              <!-- Expiry pill -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
                <tr>
                  <td style="background-color:#1E1A30;border-radius:8px;padding:13px 18px;">
                    <p style="margin:0;font-size:13px;color:#B89A60;line-height:1.6;">
                      இந்த OTP <strong style="color:#EDE0C4;">${expiry} நிமிடங்களில்</strong> காலாவதியாகும்.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Security pill -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background-color:#13101F;border-radius:8px;padding:13px 18px;">
                    <p style="margin:0;font-size:12px;color:#5A5070;line-height:1.85;">
                      இந்த OTP-ஐ யாரிடமும் பகிர வேண்டாம். நீங்கள் OTP கோரவில்லை எனில் இந்த மின்னஞ்சலை புறக்கணிக்கவும்.
                    </p>
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>

        <!-- Card footer strip -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:18px 44px;text-align:center;border-top:1px solid #231F38;">
              <p style="margin:0 0 3px;font-size:10px;color:#3E3458;letter-spacing:3px;text-transform:uppercase;">கணேசபுரம்</p>
              <p style="margin:0;font-size:10px;color:#2E2848;">இந்த மின்னஞ்சல் தானியங்கி. பதில் அளிக்க வேண்டாம்.</p>
            </td>
          </tr>
        </table>

      </td>
    </tr>

    <!-- Card: gold bottom strip -->
    <tr><td style="height:4px;font-size:0;background-color:#D4AF37;border-radius:0 0 12px 12px;">&nbsp;</td></tr>

  </table>

</td></tr>
</table>

</body>
</html>`;

  await sendMail({ toEmail, subject, htmlBody });
}

module.exports = { sendOtpEmail };
