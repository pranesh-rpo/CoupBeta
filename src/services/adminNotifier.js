/**
 * Admin Notifier Service
 * Sends important logs and errors to admin Telegram chat(s)
 * Following project rules: always log errors and changes
 */

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import { logError } from '../utils/logger.js';

class AdminNotifier {
  constructor() {
    this.bot = null;
    this.adminChatIds = [];
    this.isInitialized = false;
  }

  /**
   * Initialize the admin bot
   */
  async initialize() {
    if (this.isInitialized) {
      return;
    }

    // Check if admin bot token is configured
    if (!config.adminBotToken) {
      console.log('[ADMIN NOTIFIER] Admin bot token not configured, skipping initialization');
      return;
    }

    try {
      // Initialize bot
      this.bot = new TelegramBot(config.adminBotToken, { polling: false });
      
      // Get admin chat IDs from config
      this.adminChatIds = config.adminChatIds || [];
      
      if (this.adminChatIds.length === 0) {
        console.log('[ADMIN NOTIFIER] No admin chat IDs configured');
        return;
      }

      // Test bot connection
      const botInfo = await this.bot.getMe();
      console.log(`[ADMIN NOTIFIER] Initialized successfully as @${botInfo.username}`);
      console.log(`[ADMIN NOTIFIER] Will send notifications to ${this.adminChatIds.length} admin chat(s)`);
      
      this.isInitialized = true;
    } catch (error) {
      logError('[ADMIN NOTIFIER] Failed to initialize admin bot:', error);
      this.isInitialized = false;
    }
  }

  /**
   * Send notification to all admin chats
   * @param {string} message - Message to send
   * @param {object} options - Optional formatting options
   */
  async notify(message, options = {}) {
    if (!this.isInitialized || !this.bot || this.adminChatIds.length === 0) {
      return;
    }

    const { parseMode = 'HTML', disableNotification = false } = options;

    // Send to all admin chats
    const promises = this.adminChatIds.map(async (chatId) => {
      try {
        await this.bot.sendMessage(chatId, message, {
          parse_mode: parseMode,
          disable_notification: disableNotification,
        });
      } catch (error) {
        // Don't log errors for admin notifications to avoid infinite loops
        console.error(`[ADMIN NOTIFIER] Failed to send notification to chat ${chatId}:`, error.message);
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Send error notification
   * @param {string} context - Context where error occurred
   * @param {Error|string} error - Error object or message
   * @param {object} metadata - Additional metadata
   */
  async notifyError(context, error, metadata = {}) {
    const timestamp = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error && error.stack ? `\n\n<code>${this.escapeHtml(error.stack.substring(0, 1000))}</code>` : '';
    
    const userId = metadata.userId ? `\n👤 User ID: <code>${metadata.userId}</code>` : '';
    const accountId = metadata.accountId ? `\n🔑 Account ID: <code>${metadata.accountId}</code>` : '';
    const details = metadata.details ? `\n📝 Details: ${this.escapeHtml(metadata.details)}` : '';

    const message = `
🚨 <b>Error Alert</b>

⏰ Time: <code>${timestamp}</code>
📍 Context: <b>${this.escapeHtml(context)}</b>
❌ Error: <code>${this.escapeHtml(errorMessage)}</code>${errorStack}${userId}${accountId}${details}
    `.trim();

    await this.notify(message, { parseMode: 'HTML' });
  }

  /**
   * Send important event notification
   * @param {string} eventType - Type of event (e.g., 'SESSION_REVOKED', 'ACCOUNT_DELETED')
   * @param {string} message - Event message
   * @param {object} metadata - Additional metadata
   */
  async notifyEvent(eventType, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const emoji = this.getEventEmoji(eventType);
    
    const userId = metadata.userId ? `\n👤 User ID: <code>${metadata.userId}</code>` : '';
    const accountId = metadata.accountId ? `\n🔑 Account ID: <code>${metadata.accountId}</code>` : '';
    const details = metadata.details ? `\n📝 Details: ${this.escapeHtml(metadata.details)}` : '';

    const notificationMessage = `
${emoji} <b>${this.escapeHtml(eventType)}</b>

⏰ Time: <code>${timestamp}</code>
📢 Message: ${this.escapeHtml(message)}${userId}${accountId}${details}
    `.trim();

    await this.notify(notificationMessage, { parseMode: 'HTML' });
  }

  /**
   * Send startup error notification
   * @param {Error} error - Startup error
   */
  async notifyStartupError(error) {
    const message = `
🔴 <b>Bot Startup Failed</b>

⏰ Time: <code>${new Date().toISOString()}</code>
❌ Error: <code>${this.escapeHtml(error.message)}</code>

<code>${this.escapeHtml(error.stack || 'No stack trace available')}</code>
    `.trim();

    await this.notify(message, { parseMode: 'HTML', disableNotification: true });
  }

  /**
   * Send user action notification (for important user actions)
   * @param {string} actionType - Type of action (e.g., 'BROADCAST_STARTED', 'ACCOUNT_LINKED', 'MESSAGE_SET')
   * @param {number} userId - User ID who performed the action
   * @param {object} metadata - Additional metadata (username, accountId, details, etc.)
   */
  async notifyUserAction(actionType, userId, metadata = {}) {
    const timestamp = new Date().toISOString();
    const emoji = this.getEventEmoji(actionType) || '📢';
    
    const username = metadata.username ? ` (@${metadata.username})` : '';
    const accountId = metadata.accountId ? `\n🔑 Account ID: <code>${metadata.accountId}</code>` : '';
    const details = metadata.details ? `\n📝 Details: ${this.escapeHtml(metadata.details)}` : '';
    const phone = metadata.phone ? `\n📱 Phone: <code>${this.escapeHtml(metadata.phone)}</code>` : '';
    const message = metadata.message ? `\n💬 Message: <code>${this.escapeHtml(metadata.message.substring(0, 100))}${metadata.message.length > 100 ? '...' : ''}</code>` : '';

    const notificationMessage = `
${emoji} <b>User Action: ${this.escapeHtml(actionType)}</b>

⏰ Time: <code>${timestamp}</code>
👤 User ID: <code>${userId}</code>${username}${accountId}${phone}${message}${details}
    `.trim();

    await this.notify(notificationMessage, { parseMode: 'HTML' });
  }

  /**
   * Send user error notification (for important user-facing errors)
   * @param {string} errorType - Type of error (e.g., 'START_ERROR', 'LINK_ERROR', 'OTP_ERROR')
   * @param {number} userId - User ID who encountered the error
   * @param {string|Error} error - Error message or object
   * @param {object} metadata - Additional metadata
   */
  async notifyUserError(errorType, userId, error, metadata = {}) {
    const timestamp = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error && error.stack ? `\n\n<code>${this.escapeHtml(error.stack.substring(0, 1000))}</code>` : '';
    
    const username = metadata.username ? ` (@${metadata.username})` : '';
    const accountId = metadata.accountId ? `\n🔑 Account ID: <code>${metadata.accountId}</code>` : '';
    const details = metadata.details ? `\n📝 Details: ${this.escapeHtml(metadata.details)}` : '';
    const phone = metadata.phone ? `\n📱 Phone: <code>${this.escapeHtml(metadata.phone)}</code>` : '';

    const message = `
⚠️ <b>User Error Alert</b>

⏰ Time: <code>${timestamp}</code>
📍 Error Type: <b>${this.escapeHtml(errorType)}</b>
👤 User ID: <code>${userId}</code>${username}${accountId}${phone}
❌ Error: <code>${this.escapeHtml(errorMessage)}</code>${errorStack}${details}
    `.trim();

    await this.notify(message, { parseMode: 'HTML' });
  }

  /**
   * Get emoji for event type
   */
  getEventEmoji(eventType) {
    const emojiMap = {
      'SESSION_REVOKED': '🔐',
      'ACCOUNT_DELETED': '🗑️',
      'ACCOUNT_LINKED': '✅',
      'BROADCAST_STARTED': '▶️',
      'BROADCAST_STOPPED': '⏹️',
      'ACCOUNT_SWITCHED': '🔄',
      'MESSAGE_SET': '📝',
      'CONFIG_CHANGED': '⚙️',
      'GROUPS_REFRESHED': '👥',
      'TEMPLATE_SYNCED': '💎',
      'ACCOUNT_DELETED': '🗑️',
      'CRITICAL_ERROR': '🚨',
      'DATABASE_ERROR': '💾',
      'CONNECTION_ERROR': '🔌',
      'BOT_STARTED': '✅',
      'BOT_STOPPED': '🛑',
      'USER_START_ERROR': '⚠️',
      'LINK_ERROR': '🔗',
      'OTP_ERROR': '🔢',
      '2FA_ERROR': '🔐',
      'BROADCAST_ERROR': '📢',
    };
    return emojiMap[eventType] || '📢';
  }

  /**
   * Escape HTML special characters
   */
  escapeHtml(text) {
    if (typeof text !== 'string') {
      text = String(text);
    }
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

export default new AdminNotifier();
