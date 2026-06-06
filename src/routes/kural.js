const express = require('express');
const axios = require('axios');
const router = express.Router();

// GET /api/kural  — random kural
// GET /api/kural/:number  — specific kural (1–1330)
router.get('/:number?', async (req, res) => {
  try {
    const number = req.params.number
      ? parseInt(req.params.number, 10)
      : Math.floor(Math.random() * 1330) + 1;

    const apiKey = process.env.THIRUKURAL_API_KEY;
    const url = `https://getthirukkural.appspot.com/api/3.0/kural/${number}?appid=${apiKey}`;

    const response = await axios.get(url);
    res.json({ success: true, kural: response.data, number });
  } catch (err) {
    console.error('kural error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch Thirukural' });
  }
});

module.exports = router;
