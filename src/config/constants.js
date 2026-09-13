/**
 * Shared constants, mirroring the Apex Constants class so the two stay aligned.
 *
 * Note: TELEGRAM_BOT_TOKEN is a live credential. It is kept here by choice to
 * match the Apex side, but anyone with read access to this repository can send
 * messages as the bot. Rotate it in BotFather if the repo is ever shared, and
 * update Constants.cls at the same time.
 */
module.exports = {
  // Same value as Constants.ADMIN_TELEGRAM_ID in Apex.
  TELEGRAM_ADMIN_CHAT_ID: '944782656',
  TELEGRAM_BOT_TOKEN: '7703395825:AAFu9sah7EuaaETXk2401tvVRulphXHgn70',

  // Constants.PAARAI_GROUP_TELEGRAM_ID
  TELEGRAM_GROUP_CHAT_ID: '-1002417566041',
};
