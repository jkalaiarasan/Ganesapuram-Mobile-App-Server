require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const memberRoutes = require('./routes/member');
const weatherRoutes = require('./routes/weather');
const kuralRoutes = require('./routes/kural');
const notificationRoutes = require('./routes/notification');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));

app.use('/api/member', memberRoutes);
app.use('/api/weather', weatherRoutes);
app.use('/api/kural', kuralRoutes);
app.use('/api/notifications', notificationRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Ganesapuram server running on port ${PORT}`);
});
