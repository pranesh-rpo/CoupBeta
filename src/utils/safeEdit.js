/**
 * Safe message editing utility
 * Handles "message is not modified" errors gracefully
 * Following project rules: always log changes and errors
 */

import logger from './logger.js';

/**
 * Safely edit a message, ignoring "message is not modified" errors
 * @param {Object} bot - Telegram bot instance
 * @param {number} chatId - Chat ID
 * @param {number} messageId - Message ID to edit
 * @param {string} text - New message text
 * @param {Object} options - Additional options (parse_mode, reply_markup, etc.)
 * @returns {Promise<boolean>} - True if message was edited, false if unchanged or error
 */
export async function safeEditMessage(bot, chatId, messageId, text, options = {}) {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...options,
    });
    logger.logChange('MESSAGE_EDIT', null, `Message ${messageId} edited in chat ${chatId}`);
    return true;
  } catch (error) {
    // Handle "message is not modified" error gracefully
    // Check multiple error properties and message formats
    const errorMessage = (error.message || error.description || error.toString() || '').toLowerCase();
    const errorCode = error.code || (error.response && error.response.statusCode);
    
    // Check for various "message not modified" error formats
    const isNotModified = 
      errorMessage.includes('message is not modified') ||
      errorMessage.includes('message not modified') ||
      errorMessage.includes('specified new message content and reply markup are exactly the same') ||
      errorMessage.includes('bad request: message is not modified') ||
      errorMessage.includes('etelegram: 400') && errorMessage.includes('message is not modified') ||
      (errorCode === 400 && (errorMessage.includes('message') || errorMessage.includes('not modified'))) ||
      (error.response && error.response.statusCode === 400 && errorMessage.includes('message'));
    
    if (isNotModified) {
      // This is expected when content hasn't changed - not an error, just log as info
      logger.logInfo('MESSAGE_EDIT', `Message ${messageId} unchanged (not modified) - this is normal`, null);
      return false; // Return false instead of throwing
    }
    
    // Log other errors but don't throw - let caller handle
    logger.logError('MESSAGE_EDIT', null, error, `Failed to edit message ${messageId} in chat ${chatId}`);
    // Don't throw - return false to indicate failure
    return false;
  }
}

/**
 * Safely answer a callback query, ignoring expired query errors
 * @param {Object} bot - Telegram bot instance
 * @param {string} callbackQueryId - Callback query ID
 * @param {Object} options - Options (text, show_alert)
 * @returns {Promise<boolean>} - True if answered, false if expired/error
 */
export async function safeAnswerCallback(bot, callbackQueryId, options = {}) {
  try {
    await bot.answerCallbackQuery(callbackQueryId, options);
    return true;
  } catch (error) {
    // Handle expired query errors gracefully
    if (error.message && (
      error.message.includes('query is too old') ||
      error.message.includes('query id is invalid') ||
      error.message.includes('query expired')
    )) {
      logger.logInfo('CALLBACK_QUERY', `Callback query ${callbackQueryId} expired (ignored)`, null);
      return false;
    }
    
    // Log other errors
    logger.logError('CALLBACK_QUERY', null, error, `Failed to answer callback query ${callbackQueryId}`);
    return false;
  }
}
