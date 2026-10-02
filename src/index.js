require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const memberRoutes = require('./routes/member');
const weatherRoutes = require('./routes/weather');
const kuralRoutes = require('./routes/kural');
const notificationRoutes = require('./routes/notification');
const communityRoutes = require('./routes/community');
const quizRoutes = require('./routes/quiz');
const blueMoonRoutes = require('./routes/bluemoon');
const { installGlobalErrorReporting, notifyError } = require('./services/telegram');
const { contextMiddleware } = require('./services/requestContext');

// Every server failure reaches Telegram from here, including code added later.
installGlobalErrorReporting();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
// After express.json() so the member id in a request body is visible.
app.use(contextMiddleware);
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));

app.use('/api/member', memberRoutes);
app.use('/api/weather', weatherRoutes);
app.use('/api/kural', kuralRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/quiz', quizRoutes);
app.use('/api/bluemoon', blueMoonRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  notifyError(`${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Ganesapuram server running on port ${PORT}`);
});
