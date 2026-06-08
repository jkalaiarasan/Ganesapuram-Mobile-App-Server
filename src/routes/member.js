const express = require('express');
const router = express.Router();
const { queryMemberByEmail, getMemberListBulk, getMemberByEmail, getImageStream, updateMemberPushToken, createErrorLog } = require('../services/salesforce');
const { sendOtpEmail } = require('../services/zohoMail');
const { generateOtp, createOtpToken, verifyOtpToken } = require('../services/otp');

router.post('/request-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });
    const member = await queryMemberByEmail(email);
    if (!member) return res.status(404).json({ success: false, message: 'Member not found or not approved' });
    const otp = generateOtp();
    const token = createOtpToken(email, otp);
    await sendOtpEmail(email, member.Name, otp);
    res.json({ success: true, message: 'OTP sent to your email', token });
  } catch (err) {
    console.error('request-otp error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp, token } = req.body;
    if (!email || !otp || !token) return res.status(400).json({ success: false, message: 'Email, OTP and token required' });
    const valid = verifyOtpToken(token, email, otp);
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid or expired OTP' });
    const member = await getMemberByEmail(email);
    if (!member) return res.status(404).json({ success: false, message: 'Member not found' });
    res.json({
      success: true,
      member: {
        id: member.Id,
        name: member.Name,
        email: member.Email__c,
        uprId: member.UPRId__c,
        position: member.Position__c,
        department: member.Department__c,
        dateOfBirth: member.DateOfBirth__c || null,
        phone: member.Phone__c || null,
        work: member.Work__c || null,
        location: member.Location__c || null,
        contentVersionId: member.contentVersionId,
        type: member.Type__c || null,
      },
    });
  } catch (err) {
    console.error('verify-otp error:', err.message);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// POST /api/member/push-token — save Expo push token to Salesforce Member__c
router.post('/push-token', async (req, res) => {
  const { memberId, expoPushToken } = req.body;
  if (!memberId || !expoPushToken) {
    return res.status(400).json({ success: false, message: 'memberId and expoPushToken required' });
  }
  try {
    await updateMemberPushToken(memberId, expoPushToken);
    res.json({ success: true });
  } catch (err) {
    console.error('push-token error:', err.message);
    try {
      await createErrorLog(memberId, 'Push Token Save Failed',
        `Member: ${memberId} | Token: ${expoPushToken?.slice(0, 30)}... | Error: ${err.message}`);
    } catch { /* log failure must not block the response */ }
    res.status(500).json({ success: false, message: 'Failed to save push token' });
  }
});

// GET /api/member/list — bulk query, returns contentVersionId per member
router.get('/list', async (req, res) => {
  try {
    const raw = await getMemberListBulk();
    const members = raw.map(m => ({
      id: m.Id,
      name: m.Name,
      uprId: m.UPRId__c,
      position: m.Position__c,
      department: m.Department__c,
      phone: m.Phone__c || null,
      contentVersionId: m.contentVersionId,
    }));
    res.json({ success: true, members });
  } catch (err) {
    console.error('member list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch members' });
  }
});

// GET /api/member/image/:versionId — proxy Salesforce ContentVersion image
router.get('/image/:versionId', async (req, res) => {
  try {
    const { stream, contentType } = await getImageStream(req.params.versionId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    stream.pipe(res);
  } catch (err) {
    console.error('image proxy error:', err.message);
    res.status(404).end();
  }
});

// GET /api/member/profile — refresh member data for already-logged-in user
router.get('/profile', async (req, res) => {
  try {
    const { memberId, email } = req.query;
    if (!memberId || !email) return res.status(400).json({ success: false, message: 'memberId and email required' });
    const member = await getMemberByEmail(email);
    if (!member || member.Id !== memberId) return res.status(404).json({ success: false, message: 'Member not found' });
    res.json({
      success: true,
      member: {
        id: member.Id,
        name: member.Name,
        email: member.Email__c,
        uprId: member.UPRId__c,
        position: member.Position__c,
        department: member.Department__c,
        dateOfBirth: member.DateOfBirth__c || null,
        phone: member.Phone__c || null,
        work: member.Work__c || null,
        location: member.Location__c || null,
        contentVersionId: member.contentVersionId,
        type: member.Type__c || null,
      },
    });
  } catch (err) {
    console.error('profile refresh error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
});

// POST /api/member/error-log — create ErrorLog__c record in Salesforce
router.post('/error-log', async (req, res) => {
  const { name, description, memberId } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'name required' });
  try {
    await createErrorLog(memberId || null, name, description || '');
    res.json({ success: true });
  } catch (err) {
    console.error('error-log error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create error log' });
  }
});

module.exports = router;
