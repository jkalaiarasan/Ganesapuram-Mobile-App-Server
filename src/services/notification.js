const axios = require('axios');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Send Expo push notifications in chunks of 100 (Expo API limit).
 * Returns { sent, failed, errors }.
 */
async function sendExpoPushNotifications(messages) {
  if (!messages.length) return { sent: 0, failed: 0, errors: [] };

  const results = { sent: 0, failed: 0, errors: [] };
  const chunkSize = 100;

  for (let i = 0; i < messages.length; i += chunkSize) {
    const chunk = messages.slice(i, i + chunkSize);
    try {
      const res = await axios.post(EXPO_PUSH_URL, chunk, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        timeout: 15000,
      });

      const data = res.data?.data || [];
      for (const ticket of data) {
        if (ticket.status === 'ok') {
          results.sent++;
        } else {
          results.failed++;
          results.errors.push(ticket.details?.error || 'unknown error');
        }
      }
    } catch (err) {
      results.failed += chunk.length;
      results.errors.push(err.message);
      console.error('[Notification] Expo push chunk failed:', err.message);
    }
  }

  return results;
}

module.exports = { sendExpoPushNotifications };
