const express = require('express');
const axios = require('axios');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { lat, lon, city } = req.query;
    let query = city || '10.955040,78.608624';
    if (lat && lon) query = `${lat},${lon}`;

    const apiKey = process.env.WEATHER_API_KEY;
    const url = `http://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${query}&days=1&aqi=no&alerts=yes&lang=ta`;

    const response = await axios.get(url, { timeout: 8000 });
    const data = response.data;

    if (lat && lon) {
      const lat_n = parseFloat(lat);
      const lon_n = parseFloat(lon);
      if (lat_n >= 10.951649 && lat_n <= 10.960611 && lon_n >= 78.600805 && lon_n <= 78.612744) {
        data.location.name = 'Ganesapuram';
      }
    }
    res.json({ success: true, data });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('weather error:', JSON.stringify(detail));
    res.status(500).json({ success: false, message: 'Failed to fetch weather', detail });
  }
});

module.exports = router;
