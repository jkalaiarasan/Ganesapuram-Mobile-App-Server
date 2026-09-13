const axios = require('axios');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID } = require('../config/constants');

const BOT_TOKEN = TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = TELEGRAM_ADMIN_CHAT_ID;

// Captured before console.error is patched below. Everything inside this module
// logs through this, otherwise reporting a failure would re-enter the patched
// console.error and recurse forever.
const rawError = console.error.bind(console);

// A crash loop would otherwise put hundreds of messages on the admin's phone.
// Same signature at most once per window. Serverless memory is per-instance, so
// this is best effort rather than a guarantee.
const WINDOW_MS = 5 * 60 * 1000;
const recent = new Map();
let reporting = false;

function shouldSend(signature) {
  const now = Date.now();
  for (const [key, at] of recent) {
    if (now - at > WINDOW_MS) recent.delete(key);
  }
  if (recent.has(signature)) return false;
  recent.set(signature, now);
  return true;
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return false;
  await axios.post(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    { chat_id: ADMIN_CHAT_ID, text: text.slice(0, 4000) },
    { timeout: 8000 }
  );
  return true;
}

/**
 * Report a server failure to the admin on Telegram.
 * Never throws and never rejects — a reporter that can fail masks the fault it
 * was meant to surface.
 */
async function notifyError(context, err, extra = {}) {
  if (reporting) return; // guard against a report triggering a report
  reporting = true;
  try {
    const message = err?.message ?? String(err);
    if (!shouldSend(`${context}:${message}`)) return;

    const lines = [
      '🚨 Server Error',
      '',
      `Context: ${context}`,
      `Env:     ${process.env.VERCEL_ENV || 'local'}`,
      `Time:    ${new Date().toISOString()}`,
      '',
      `Type:    ${err?.name ?? 'Error'}`,
      `Message: ${message}`,
    ];

    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null && v !== '') lines.push(`${k}: ${v}`);
    }

    // Salesforce puts the useful detail in the response body, not the message.
    const sfDetail = err?.response?.data;
    if (sfDetail) lines.push('', `Salesforce: ${JSON.stringify(sfDetail).slice(0, 800)}`);
    if (err?.stack) lines.push('', 'Stack:', err.stack.split('\n').slice(0, 6).join('\n'));

    await sendTelegram(lines.join('\n'));
  } catch (reporterFailure) {
    rawError('[telegram] could not report error:', reporterFailure.message);
  } finally {
    reporting = false;
  }
}

function reportError(context, err, extra = {}) {
  rawError(`${context}:`, err?.message ?? err);
  notifyError(context, err, extra);
}

/**
 * Route every server failure to Telegram from one place.
 *
 * console.error is wrapped rather than edited at all ~30 existing call sites,
 * so code added later is covered automatically instead of being silently
 * missed. The original logger still runs first, so platform logs are unchanged.
 */
function installGlobalErrorReporting() {
  console.error = (...args) => {
    rawError(...args);
    try {
      const text = args
        .map(a => (a instanceof Error ? (a.stack ?? a.message)
          : typeof a === 'string' ? a
          : JSON.stringify(a)))
        .join(' ');
      notifyError('server', { name: 'ServerError', message: text.slice(0, 1500) });
    } catch {
      // reporting must never break logging
    }
  };

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : { name: 'UnhandledRejection', message: String(reason) };
    rawError('[unhandledRejection]', err.message);
    notifyError('unhandledRejection', err);
  });

  process.on('uncaughtException', (err) => {
    rawError('[uncaughtException]', err.message);
    notifyError('uncaughtException', err);
  });
}

module.exports = { notifyError, reportError, sendTelegram, installGlobalErrorReporting };
