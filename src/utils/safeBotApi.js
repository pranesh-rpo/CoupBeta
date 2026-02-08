/**
 * Safe wrapper functions for Telegram Bot API calls
 * Automatically handles flood waits to prevent bans
 */

import { safeBotApiCall } from './floodWaitHandler.js';

/**
 * Create a safe wrapper for a bot instance
 * This provides safe versions of common bot API methods
 */
export function createSafeBotWrapper(bot) {
  return {
    // Safe sendMessage with automatic flood wait handling
    sendMessage: async (chatId, text, options = {}) => {
      return safeBotApiCall(
        () => bot.sendMessage(chatId, text, options),
        { maxRetries: 5, bufferSeconds: 2 }
      );
    },
    
    // Safe editMessageText with automatic flood wait handling
    editMessageText: async (text, options = {}) => {
      return safeBotApiCall(
        () => bot.editMessageText(text, options),
        { maxRetries: 5, bufferSeconds: 2 }
      );
    },
    
    // Safe answerCallbackQuery with automatic flood wait handling
    answerCallbackQuery: async (callbackQueryId, options = {}) => {
      return safeBotApiCall(
        () => bot.answerCallbackQuery(callbackQueryId, options),
        { maxRetries: 3, bufferSeconds: 1 }
      );
    },
    
    // Safe deleteMessage with automatic flood wait handling
    deleteMessage: async (chatId, messageId) => {
      return safeBotApiCall(
        () => bot.deleteMessage(chatId, messageId),
        { maxRetries: 3, bufferSeconds: 1 }
      );
    },
    
    // Safe getChat with automatic flood wait handling
    getChat: async (chatId) => {
      return safeBotApiCall(
        () => bot.getChat(chatId),
        { maxRetries: 3, bufferSeconds: 1 }
      );
    },
    
    // Safe getChatMember with automatic flood wait handling
    getChatMember: async (chatId, userId) => {
      return safeBotApiCall(
        () => bot.getChatMember(chatId, userId),
        { maxRetries: 3, bufferSeconds: 1 }
      );
    },
    
    // Safe forwardMessage with automatic flood wait handling
    forwardMessage: async (chatId, fromChatId, messageId, options = {}) => {
      return safeBotApiCall(
        () => bot.forwardMessage(chatId, fromChatId, messageId, options),
        { maxRetries: 5, bufferSeconds: 2 }
      );
    },
    
    // Safe sendPhoto with automatic flood wait handling
    sendPhoto: async (chatId, photo, options = {}) => {
      return safeBotApiCall(
        () => bot.sendPhoto(chatId, photo, options),
        { maxRetries: 5, bufferSeconds: 2 }
      );
    },
    
    // Safe sendVideo with automatic flood wait handling
    sendVideo: async (chatId, video, options = {}) => {
      return safeBotApiCall(
        () => bot.sendVideo(chatId, video, options),
        { maxRetries: 5, bufferSeconds: 2 }
      );
    },
    
    // Expose the original bot for methods not wrapped
    _original: bot,
  };
}

