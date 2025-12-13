/**
 * Notification Service
 * Sends notifications to users for important events
 */

import accountLinker from './accountLinker.js';
import logger from '../utils/logger.js';

class NotificationService {
  constructor() {
    this.bot = null;
  }

  setBot(bot) {
    this.bot = bot;
  }

  /**
   * Send notification to user
   */
  async notifyUser(userId, message, options = {}) {
    try {
      if (!this.bot) {
        console.log('[NOTIFICATION] Bot not set, skipping notification');
        return { success: false, error: 'Bot not initialized' };
      }

      await this.bot.sendMessage(userId, message, {
        parse_mode: 'HTML',
        ...options
      });
      
      logger.logChange('NOTIFICATION', userId, 'Notification sent');
      return { success: true };
    } catch (error) {
      logger.logError('NOTIFICATION', userId, error, 'Failed to send notification');
      return { success: false, error: error.message };
    }
  }

  /**
   * Notify broadcast completion
   */
  async notifyBroadcastComplete(userId, stats) {
    const message = `✅ <b>Broadcast Completed!</b>\n\n` +
      `📊 Statistics:\n` +
      `• Total Groups: ${stats.totalGroups || 0}\n` +
      `• Messages Sent: ${stats.successCount || 0}\n` +
      `• Failed: ${stats.errorCount || 0}\n` +
      `• Success Rate: ${stats.totalGroups > 0 ? ((stats.successCount / stats.totalGroups) * 100).toFixed(1) : 0}%`;
    
    return await this.notifyUser(userId, message);
  }

  /**
   * Notify broadcast error
   */
  async notifyBroadcastError(userId, error) {
    const message = `❌ <b>Broadcast Error</b>\n\n` +
      `An error occurred during broadcasting:\n` +
      `<code>${error.message || error}</code>`;
    
    return await this.notifyUser(userId, message);
  }

  /**
   * Notify scheduled message sent
   */
  async notifyScheduledSent(userId, scheduledTime) {
    const message = `⏰ <b>Scheduled Message Sent</b>\n\n` +
      `Your scheduled message was sent at ${new Date(scheduledTime).toLocaleString()}`;
    
    return await this.notifyUser(userId, message);
  }
}

export default new NotificationService();
