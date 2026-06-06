const express = require('express');
const router = express.Router();
const { queryMemberByEmail, getMemberListBulk, getMemberByEmail, getImageStream } = require('../services/salesforce');
const { sendOtpEmail } = require('../services/zohoMail');
const { generateOtp, storeOtp, verifyOtp } = require('../services/otp');

router.post('/request-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });
    const member = await queryMemberByEmail(email);
    if (!member) return res.status(404).json({ success: false, message: 'Member not found or not approved' });
    const otp = generateOtp();
    storeOtp(email, otp);
    await sendOtpEmail(email, member.Name, otp);
    res.json({ success: true, message: 'OTP sent to your email' });
  } catch (err) {
    console.error('request-otp error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ success: false, message: 'Email and OTP required' });
    const valid = verifyOtp(email, otp);
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
        username: member.Username__c,
        dateOfBirth: member.DateOfBirth__c || null,
        phone: member.Phone__c || null,
        work: member.Work__c || null,
        location: member.Location__c || null,
        contentVersionId: member.contentVersionId,
      },
    });
  } catch (err) {
    console.error('verify-otp error:', err.message);
    res.status(500).json({ success: false, message: 'Verification failed' });
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
      username: m.Username__c,
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

module.exports = router;
