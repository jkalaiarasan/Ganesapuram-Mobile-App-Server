const express = require('express');
const router = express.Router();
const { getMemberPushTokens } = require('../services/salesforce');
const { sendExpoPushNotifications } = require('../services/notification');

const NOTIF_SECRET = 'upr-ganesapuram-notif-secret-2024';

function checkSecret(req, res) {
  if (req.body.secret !== NOTIF_SECRET) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return false;
  }
  return true;
}

// POST /api/notifications/send
// Body: { secret, title, body, data? }
// Sends notification to ALL approved members who have a push token.
router.post('/send', async (req, res) => {
  if (!checkSecret(req, res)) return;

  const { title, body, data } = req.body;
  if (!title || !body) {
    return res.status(400).json({ success: false, message: 'title and body are required' });
  }

  try {
    const members = await getMemberPushTokens();
    if (!members.length) {
      return res.json({ success: true, message: 'No members with push tokens', sent: 0, failed: 0 });
    }

    const messages = members.map(m => ({
      to: m.token,
      title,
      body,
      data: data || {},
      sound: 'default',
      channelId: 'default',
    }));

    const result = await sendExpoPushNotifications(messages);
    console.log(`[Notification] Broadcast: sent=${result.sent} failed=${result.failed}`);
    res.json({ success: true, total: members.length, ...result });
  } catch (err) {
    console.error('notifications/send error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send notifications' });
  }
});

// POST /api/notifications/send-to-member
// Body: { secret, memberId, title, body, data? }
// Sends notification to a single member by Salesforce Member__c Id.
router.post('/send-to-member', async (req, res) => {
  if (!checkSecret(req, res)) return;

  const { memberId, title, body, data } = req.body;
  if (!memberId || !title || !body) {
    return res.status(400).json({ success: false, message: 'memberId, title and body are required' });
  }

  try {
    const all = await getMemberPushTokens();
    const target = all.find(m => m.id === memberId);
    if (!target) {
      return res.status(404).json({ success: false, message: 'Member not found or has no push token' });
    }

    const result = await sendExpoPushNotifications([{
      to: target.token,
      title,
      body,
      data: data || {},
      sound: 'default',
      channelId: 'default',
    }]);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('notifications/send-to-member error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send notification' });
  }
});

module.exports = router;
