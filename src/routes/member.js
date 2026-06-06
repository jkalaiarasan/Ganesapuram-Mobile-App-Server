const express = require('express');
const router = express.Router();
const { queryMemberByEmail, getMemberList, getMemberByEmail, getMemberProfileImageUrl } = require('../services/salesforce');
const { sendOtpEmail } = require('../services/zohoMail');
const { generateOtp, storeOtp, verifyOtp } = require('../services/otp');

// POST /api/member/request-otp  { email }
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

// POST /api/member/verify-otp  { email, otp }
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ success: false, message: 'Email and OTP required' });

    const valid = verifyOtp(email, otp);
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid or expired OTP' });

    const member = await getMemberByEmail(email);
    if (!member) return res.status(404).json({ success: false, message: 'Member not found' });

    const profileImageUrl = await getMemberProfileImageUrl(member.Id);

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
        profileImageUrl,
      },
    });
  } catch (err) {
    console.error('verify-otp error:', err.message);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// GET /api/member/list
router.get('/list', async (req, res) => {
  try {
    const members = await getMemberList();
    const withImages = await Promise.all(
      members.map(async (m) => {
        const profileImageUrl = await getMemberProfileImageUrl(m.Id);
        return { ...m, profileImageUrl };
      })
    );
    res.json({ success: true, members: withImages });
  } catch (err) {
    console.error('member list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch members' });
  }
});

module.exports = router;
