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
  const subject = '🔐 உங்கள் OTP குறியீடு — UPR நட்பு சாம்ராஜ்யம்';
  const expiry  = process.env.OTP_EXPIRY_MINUTES || 10;
  const digits  = String(otp).split('');

  const htmlBody = `<!DOCTYPE html>
<html lang="ta">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OTP - UPR</title>
</head>
<body style="margin:0;padding:0;background-color:#0F0A02;font-family:Georgia,'Times New Roman',serif;">

<!-- Outer wrapper -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0F0A02">
<tr><td align="center" style="padding:40px 16px;">

  <!-- Card -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;">

    <!-- ── Gold top bar ── -->
    <tr>
      <td bgcolor="#C9A227" style="height:4px;line-height:4px;font-size:0;">&nbsp;</td>
    </tr>

    <!-- ── Header ── -->
    <tr>
      <td bgcolor="#1C1408" style="padding:36px 40px 28px;text-align:center;border-left:1px solid #3A2A08;border-right:1px solid #3A2A08;">
        <!-- Emblem row -->
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-bottom:16px;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td bgcolor="#C9A227" style="width:1px;">&nbsp;</td>
            <td style="padding:0 20px;">
              <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:4px;color:#C9A227;text-transform:uppercase;">UPR நட்பு சாம்ராஜ்யம்</p>
            </td>
            <td bgcolor="#C9A227" style="width:1px;">&nbsp;</td>
          </tr></table>
        </td></tr></table>

        <h1 style="margin:0 0 6px;font-size:28px;font-weight:800;color:#F5ECD7;letter-spacing:-0.5px;">கணேசாபுரம்</h1>
        <p style="margin:0;font-size:13px;color:#C4A882;letter-spacing:1px;">உறுப்பினர் உள்நுழைவு சரிபார்ப்பு</p>

        <!-- Gold divider -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
          <tr>
            <td bgcolor="#9C7A1A" style="height:1px;line-height:1px;font-size:0;" width="20%">&nbsp;</td>
            <td bgcolor="#C9A227" style="height:1px;line-height:1px;font-size:0;" width="20%">&nbsp;</td>
            <td bgcolor="#F5D06E" style="height:1px;line-height:1px;font-size:0;" width="20%">&nbsp;</td>
            <td bgcolor="#C9A227" style="height:1px;line-height:1px;font-size:0;" width="20%">&nbsp;</td>
            <td bgcolor="#9C7A1A" style="height:1px;line-height:1px;font-size:0;" width="20%">&nbsp;</td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- ── Body ── -->
    <tr>
      <td bgcolor="#110C03" style="padding:32px 40px 36px;border-left:1px solid #3A2A08;border-right:1px solid #3A2A08;">

        <!-- Greeting -->
        <p style="margin:0 0 8px;font-size:15px;color:#C4A882;">வணக்கம்,</p>
        <p style="margin:0 0 24px;font-size:20px;font-weight:700;color:#F5D06E;">${memberName}</p>

        <p style="margin:0 0 24px;font-size:14px;color:#7A6040;line-height:1.7;">
          UPR நட்பு சாம்ராஜ்யம் பயன்பாட்டில் உள்நுழைவதற்கான<br>
          உங்கள் சரிபார்ப்பு OTP குறியீடு கீழே உள்ளது:
        </p>

        <!-- OTP box -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
          <tr>
            <td align="center">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td bgcolor="#9C7A1A" style="height:2px;font-size:0;" colspan="8">&nbsp;</td>
                </tr>
                <tr>
                  <td bgcolor="#2A1E08" style="padding:28px 40px;text-align:center;border-left:2px solid #9C7A1A;border-right:2px solid #9C7A1A;">
                    <!-- Individual digit boxes -->
                    <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
                      <tr>
                        ${digits.map(d => `
                        <td align="center" bgcolor="#C9A227" style="width:44px;height:56px;border-radius:8px;font-size:28px;font-weight:900;color:#1A0F00;font-family:Courier,'Courier New',monospace;letter-spacing:0;padding:0 6px;vertical-align:middle;">
                          ${d}
                        </td>
                        <td style="width:8px;">&nbsp;</td>`).join('')}
                      </tr>
                    </table>
                    <p style="margin:16px 0 0;font-size:12px;color:#9C7A1A;letter-spacing:2px;">ONE TIME PASSWORD</p>
                  </td>
                </tr>
                <tr>
                  <td bgcolor="#9C7A1A" style="height:2px;font-size:0;" colspan="8">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Expiry notice -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td bgcolor="#1C1408" style="padding:14px 16px;border-left:3px solid #C9A227;border-radius:0 6px 6px 0;">
              <p style="margin:0;font-size:13px;color:#C4A882;">
                ⏱&nbsp; இந்த OTP <strong style="color:#F5D06E;">${expiry} நிமிடங்களில்</strong> காலாவதியாகும்
              </p>
            </td>
          </tr>
        </table>

        <!-- Security notice -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td bgcolor="#1C1408" style="padding:14px 16px;border-left:3px solid #3A2A08;border-radius:0 6px 6px 0;">
              <p style="margin:0;font-size:12px;color:#7A6040;line-height:1.6;">
                🔒&nbsp; இந்த OTP-ஐ யாரிடமும் பகிர வேண்டாம்.<br>
                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;நீங்கள் OTP கோரவில்லை எனில் இந்த மின்னஞ்சலை புறக்கணிக்கவும்.
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>

    <!-- ── Footer ── -->
    <tr>
      <td bgcolor="#1C1408" style="padding:20px 40px;text-align:center;border-left:1px solid #3A2A08;border-right:1px solid #3A2A08;">
        <!-- Gold divider -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
          <tr>
            <td bgcolor="#9C7A1A" style="height:1px;line-height:1px;font-size:0;" width="30%">&nbsp;</td>
            <td bgcolor="#C9A227" style="height:1px;line-height:1px;font-size:0;" width="40%">&nbsp;</td>
            <td bgcolor="#9C7A1A" style="height:1px;line-height:1px;font-size:0;" width="30%">&nbsp;</td>
          </tr>
        </table>
        <p style="margin:0 0 4px;font-size:12px;color:#7A6040;letter-spacing:1px;">✦ &nbsp; UPR நட்பு சாம்ராஜ்யம் &nbsp; ✦</p>
        <p style="margin:0;font-size:11px;color:#3A2A08;">இந்த மின்னஞ்சல் தானியங்கி. பதில் அளிக்க வேண்டாம்.</p>
      </td>
    </tr>

    <!-- ── Gold bottom bar ── -->
    <tr>
      <td bgcolor="#C9A227" style="height:4px;line-height:4px;font-size:0;">&nbsp;</td>
    </tr>

  </table>
  <!-- /Card -->

</td></tr>
</table>
<!-- /Outer wrapper -->

</body>
</html>`;

  await sendMail({ toEmail, subject, htmlBody });
}

module.exports = { sendOtpEmail };
