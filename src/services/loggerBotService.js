/**
 * Logger Bot Service
 * Sends logs to users about their account activity
 * Only sends logs to users who have started the logger bot
 * Handles banned logger bot gracefully (doesn't violate Telegram rules)
 */

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import db from '../database/db.js';
import logger, { logError } from '../utils/logger.js';
import { safeBotApiCall } from '../utils/floodWaitHandler.js';

class LoggerBotService {
  constructor() {
    this.bot = null;
    this.initialized = false;
    this.blockedUsers = new Set(); // Track users who have blocked the logger bot
    this.logQueue = new Map(); // Queue logs per user to batch them
    this.queueTimeouts = new Map(); // Timeouts for batching logs
    this.BATCH_DELAY = 2000; // 2 seconds delay for batching
    this.MAX_BATCH_SIZE = 5; // Maximum logs per batch
    this.failedSends = new Map(); // Track failed sends per user: userId -> { count, lastFailed, consecutiveFailures }
    this.maxConsecutiveFailures = 3; // Stop trying after 3 consecutive failures
    this.failureResetTime = 3600000; // Reset failure count after 1 hour
    this.healthCheckInterval = null; // Health check interval
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  /**
   * Initialize the logger bot
   */
  async initialize() {
    if (!config.userLoggerBotToken) {
      console.log('[LOGGER_BOT] ⚠️ USER_LOGGER_BOT_TOKEN not configured. Logger bot disabled.');
      return;
    }

    try {
      this.bot = new TelegramBot(config.userLoggerBotToken, {
        polling: {
          interval: 300,
          autoStart: false,
          params: {
            timeout: 10,
            allowed_updates: ['message', 'callback_query']
          }
        }
      });

      // Delete any existing webhook
      try {
        await this.bot.deleteWebHook({ drop_pending_updates: false });
      } catch (error) {
        // Ignore errors - webhook might not exist
      }

      // Start polling
      await this.bot.startPolling();
      console.log('[LOGGER_BOT] ✅ Logger bot initialized and polling started');

      // Set up handlers
      this.setupHandlers();
      this.initialized = true;
      this.reconnectAttempts = 0;

      // Start periodic health check
      this.startHealthCheck();
    } catch (error) {
      logError('[LOGGER_BOT] Error initializing logger bot:', error);
      this.initialized = false;
    }
  }

  /**
   * Set up bot handlers
   */
  setupHandlers() {
    // Handle /start command
    this.bot.onText(/\/start/, async (msg) => {
      try {
        if (msg.chat.type !== 'private') return;
        const userId = msg.from?.id;
        const chatId = msg.chat?.id;

        if (!userId || !chatId) {
          return;
        }

        // Mark user as having started the logger bot
        await this.markLoggerBotStarted(userId, true);
        
        // Remove from blocked list if they start again
        if (this.blockedUsers.has(userId)) {
          this.blockedUsers.delete(userId);
        }

        try {
          await this.bot.sendMessage(
            chatId,
            '✅ <b>Logger Bot Started</b>\n\n' +
            'You will now receive comprehensive logs about your account activity, including:\n\n' +
            '📢 <b>Broadcast:</b>\n' +
            '• Broadcast started/stopped\n' +
            '• Cycle completion with stats\n' +
            '• Daily cap reached warnings\n' +
            '• Message sent/failed details\n\n' +
            '👥 <b>Groups:</b>\n' +
            '• Group refresh updates\n' +
            '• Groups added/removed\n' +
            '• Group join/leave events\n\n' +
            '⚙️ <b>Settings:</b>\n' +
            '• Interval changes\n' +
            '• Quiet hours updates\n' +
            '• Schedule changes\n' +
            '• Auto-reply settings\n\n' +
            '💬 <b>Auto-Reply:</b>\n' +
            '• DM auto-replies sent\n' +
            '• Group mentions/replies\n\n' +
            '🔑 <b>Account:</b>\n' +
            '• Account linked/deleted\n' +
            '• Account status changes\n' +
            '• Session issues\n' +
            '• Premium status changes\n\n' +
            '📝 <b>Messages:</b>\n' +
            '• Message pool changes\n' +
            '• Message set/updated\n\n' +
            '⚠️ <b>System:</b>\n' +
            '• Rate limiting warnings\n' +
            '• Connection issues\n' +
            '• Error notifications\n\n' +
            'You can stop receiving logs by blocking this bot.',
            { parse_mode: 'HTML' }
          );

          logger.logChange('LOGGER_BOT_STARTED', userId, 'User started logger bot');
        } catch (sendError) {
          // Check if user blocked the bot
          const errorMessage = sendError.message || sendError.toString() || '';
          const isBotBlocked = errorMessage.includes('bot was blocked') ||
                              errorMessage.includes('bot blocked') ||
                              errorMessage.includes('BLOCKED') ||
                              errorMessage.includes('chat not found') ||
                              (sendError.code === 403 && errorMessage.includes('forbidden'));

          if (isBotBlocked) {
            // User blocked the bot - mark them and don't mark as started
            this.blockedUsers.add(userId);
            await this.markLoggerBotStarted(userId, false);
            console.log(`[LOGGER_BOT] User ${userId} has blocked the logger bot - marked as blocked`);
            // Don't log as error - this is expected behavior
            return;
          }
          
          // For other errors, log but don't fail
          logError('[LOGGER_BOT] Error sending welcome message:', sendError);
        }
      } catch (error) {
        // Check if it's a blocked user error
        const errorMessage = error.message || error.toString() || '';
        const isBotBlocked = errorMessage.includes('bot was blocked') ||
                            errorMessage.includes('bot blocked') ||
                            errorMessage.includes('BLOCKED') ||
                            errorMessage.includes('chat not found') ||
                            (error.code === 403 && errorMessage.includes('forbidden'));

        if (isBotBlocked) {
          // User blocked the bot - mark them
          const userId = msg.from?.id;
          if (userId) {
            this.blockedUsers.add(userId);
            await this.markLoggerBotStarted(userId, false);
            console.log(`[LOGGER_BOT] User ${userId} has blocked the logger bot - marked as blocked`);
          }
          // Don't log as error - this is expected behavior
          return;
        }
        
        logError('[LOGGER_BOT] Error handling /start:', error);
      }
    });

    // Handle /help command
    this.bot.onText(/\/help/, async (msg) => {
      try {
        if (msg.chat.type !== 'private') return;
        const userId = msg.from?.id;
        const chatId = msg.chat?.id;

        if (!userId || !chatId) {
          return;
        }

        const helpMessage = '📖 <b>Logger Bot Commands</b>\n\n' +
          '<b>Commands:</b>\n' +
          '/start - Start receiving logs\n' +
          '/help - Show this help message\n' +
          '/status - Check logger bot status\n' +
          '/recent - View recent logs (last 10)\n' +
          '/summary - Get account summary\n' +
          '/settings - Configure log preferences\n\n' +
          '<b>Log Types:</b>\n' +
          '📢 Broadcast events\n' +
          '👥 Group management\n' +
          '⚙️ Settings changes\n' +
          '💬 Auto-reply activity\n' +
          '🔑 Account events\n' +
          '📝 Message updates\n' +
          '⚠️ System warnings\n\n' +
          'You can stop receiving logs by blocking this bot.';

        await this.bot.sendMessage(chatId, helpMessage, { parse_mode: 'HTML' });
      } catch (error) {
        logError('[LOGGER_BOT] Error handling /help:', error);
      }
    });

    // Handle /status command
    this.bot.onText(/\/status/, async (msg) => {
      try {
        if (msg.chat.type !== 'private') return;
        const userId = msg.from?.id;
        const chatId = msg.chat?.id;

        if (!userId || !chatId) {
          return;
        }

        const hasStarted = await this.hasLoggerBotStarted(userId);
        const isBlocked = this.blockedUsers.has(userId);

        let statusMessage = '📊 <b>Logger Bot Status</b>\n\n';
        statusMessage += `Status: ${hasStarted && !isBlocked ? '✅ Active' : '❌ Inactive'}\n`;
        statusMessage += `Receiving Logs: ${hasStarted && !isBlocked ? 'Yes' : 'No'}\n\n`;

        if (hasStarted && !isBlocked) {
          // Get recent log count
          try {
            const logCount = await db.query(
              'SELECT COUNT(*) as count FROM logs WHERE user_id = ? AND timestamp > datetime(\'now\', \'-24 hours\')',
              [userId]
            );
            const count = logCount.rows[0]?.count || 0;
            statusMessage += `Logs in last 24h: ${count}\n`;
          } catch (e) {
            // Ignore errors
          }
        }

        // Add failure stats if any
        const failures = this.getFailureStats(userId);
        if (failures.count > 0) {
          statusMessage += `\n⚠️ Failed Sends: ${failures.count}\n`;
          statusMessage += `Consecutive Failures: ${failures.consecutiveFailures}\n`;
          if (failures.lastError) {
            statusMessage += `Last Error: ${failures.lastError.substring(0, 50)}\n`;
          }
        }

        // Add bot health status
        if (!this.initialized) {
          statusMessage += `\n⚠️ Bot Status: Not Initialized\n`;
        } else if (this.reconnectAttempts > 0) {
          statusMessage += `\n⚠️ Reconnect Attempts: ${this.reconnectAttempts}\n`;
        }

        statusMessage += '\nUse /help to see all commands.';

        await this.bot.sendMessage(chatId, statusMessage, { parse_mode: 'HTML' });
      } catch (error) {
        // Try to send error message
        try {
          await this.bot.sendMessage(chatId, '⚠️ <b>Couldn\'t Retrieve Status</b>\n\nPlease try again in a moment.');
        } catch (e) {
          // Ignore if we can't send error message
        }
        logError('[LOGGER_BOT] Error handling /status:', error);
      }
    });

    // Handle /recent command
    this.bot.onText(/\/recent/, async (msg) => {
      try {
        if (msg.chat.type !== 'private') return;
        const userId = msg.from?.id;
        const chatId = msg.chat?.id;

        if (!userId || !chatId) {
          return;
        }

        const hasStarted = await this.hasLoggerBotStarted(userId);
        if (!hasStarted) {
          await this.bot.sendMessage(chatId, '❌ Please start the logger bot first with /start');
          return;
        }

        // Get recent logs from database
        try {
          const logs = await db.query(
            `SELECT log_type, message, status, timestamp 
             FROM logs 
             WHERE user_id = ? 
             ORDER BY timestamp DESC 
             LIMIT 10`,
            [userId]
          );

          if (!logs.rows || logs.rows.length === 0) {
            await this.bot.sendMessage(chatId, '📋 No recent logs found.');
            return;
          }

          let message = '📋 <b>Recent Logs</b>\n\n';
          logs.rows.forEach((log, index) => {
            const icon = log.status === 'success' ? '✅' : log.status === 'error' ? '❌' : log.status === 'warning' ? '⚠️' : 'ℹ️';
            const time = new Date(log.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            message += `${icon} <b>${log.log_type || 'LOG'}</b>\n`;
            message += `${log.message}\n`;
            message += `<i>${time}</i>\n\n`;
          });

          await this.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        } catch (error) {
          try {
            await this.bot.sendMessage(chatId, '⚠️ <b>Couldn\'t Retrieve Logs</b>\n\nPlease try again in a moment.');
          } catch (e) {
            // Ignore if we can't send error message
          }
          logError('[LOGGER_BOT] Error getting recent logs:', error);
        }
      } catch (error) {
        try {
          await this.bot.sendMessage(chatId, '⚠️ <b>Command Error</b>\n\nSomething went wrong processing your command. Please try again.');
        } catch (e) {
          // Ignore if we can't send error message
        }
        logError('[LOGGER_BOT] Error handling /recent:', error);
      }
    });

    // Handle /summary command
    this.bot.onText(/\/summary/, async (msg) => {
      try {
        if (msg.chat.type !== 'private') return;
        const userId = msg.from?.id;
        const chatId = msg.chat?.id;

        if (!userId || !chatId) {
          return;
        }

        const hasStarted = await this.hasLoggerBotStarted(userId);
        if (!hasStarted) {
          await this.bot.sendMessage(chatId, '❌ Please start the logger bot first with /start');
          return;
        }

        // Get account summary
        try {
          const accounts = await db.query(
            'SELECT account_id, phone, first_name, is_active, is_broadcasting FROM accounts WHERE user_id = ?',
            [userId]
          );

          if (!accounts.rows || accounts.rows.length === 0) {
            await this.bot.sendMessage(chatId, '📊 <b>Account Summary</b>\n\nNo accounts linked yet.');
            return;
          }

          let message = '📊 <b>Account Summary</b>\n\n';
          accounts.rows.forEach((account, index) => {
            message += `<b>Account ${index + 1}:</b>\n`;
            message += `ID: ${account.account_id}\n`;
            message += `Phone: ${account.phone || 'N/A'}\n`;
            message += `Name: ${account.first_name || 'N/A'}\n`;
            message += `Status: ${account.is_active ? '🟢 Active' : '⚪ Inactive'}\n`;
            message += `Broadcasting: ${account.is_broadcasting ? '📢 Yes' : '⏸️ No'}\n\n`;
          });

          // Get group count
          const groupCount = await db.query(
            'SELECT COUNT(*) as count FROM groups WHERE account_id IN (SELECT account_id FROM accounts WHERE user_id = ?) AND is_active = TRUE',
            [userId]
          );
          message += `Total Active Groups: ${groupCount.rows[0]?.count || 0}\n`;

          await this.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        } catch (error) {
          try {
            await this.bot.sendMessage(chatId, '⚠️ <b>Couldn\'t Retrieve Summary</b>\n\nPlease try again in a moment.');
          } catch (e) {
            // Ignore if we can't send error message
          }
          logError('[LOGGER_BOT] Error getting summary:', error);
        }
      } catch (error) {
        try {
          await this.bot.sendMessage(chatId, '⚠️ <b>Command Error</b>\n\nSomething went wrong processing your command. Please try again.');
        } catch (e) {
          // Ignore if we can't send error message
        }
        logError('[LOGGER_BOT] Error handling /summary:', error);
      }
    });

    // Handle errors (user blocked bot, network issues, etc.)
    this.bot.on('error', (error) => {
      const errorMessage = error.message || error.toString() || '';
      
      // Check if it's a blocked user error
      if (this.isBotBlockedError(error)) {
        // This is expected - user blocked the bot, we'll handle it gracefully
        console.log('[LOGGER_BOT] User blocked the logger bot (this is normal)');
        return;
      }

      // Check if it's a network error
      if (this.isNetworkError(error)) {
        console.log(`[LOGGER_BOT] Network error: ${errorMessage}`);
        // Don't log as critical error - network issues are recoverable
        return;
      }

      // Check if it's a rate limit error
      if (this.isRateLimitError(error)) {
        console.log(`[LOGGER_BOT] Rate limit error: ${errorMessage}`);
        // Don't log as critical error - rate limits are recoverable
        return;
      }

      // Log other errors
      logError('[LOGGER_BOT] Bot error:', error);
      
      // Check if we need to reconnect
      if (errorMessage.includes('polling') || errorMessage.includes('connection')) {
        this.reconnectAttempts++;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.log('[LOGGER_BOT] Too many errors, attempting reconnect...');
          this.reconnect().catch(err => {
            logError('[LOGGER_BOT] Reconnect failed:', err);
          });
        }
      }
    });

    // Handle polling errors
    this.bot.on('polling_error', (error) => {
      const errorMessage = error.message || error.toString() || '';
      const errorCode = error.code || error.response?.error_code;
      
      // Check if it's a 409 Conflict (multiple bot instances polling)
      // This is not a critical error - just means another instance is using the bot token
      if (errorCode === 409 || errorMessage.includes('409') || errorMessage.includes('Conflict') || 
          errorMessage.includes('terminated by other getUpdates request')) {
        // Silently ignore - this is expected when multiple instances are running
        // Don't log as error to avoid spam
        return;
      }
      
      // Check if it's a network/connection issue
      if (this.isNetworkError(error)) {
        console.log(`[LOGGER_BOT] Polling network error: ${errorMessage}`);
        return;
      }

      // Check if it's unauthorized (invalid token)
      if (errorCode === 401 || errorMessage.includes('Unauthorized')) {
        console.error('[LOGGER_BOT] ❌ Invalid bot token! Please check USER_LOGGER_BOT_TOKEN in .env');
        logError('[LOGGER_BOT] Invalid bot token:', error);
        this.initialized = false;
        return;
      }

      // Log other polling errors
      logError('[LOGGER_BOT] Polling error:', error);
    });
  }

  /**
   * Check if user has started the logger bot
   */
  async hasLoggerBotStarted(userId) {
    try {
      const result = await db.query(
        'SELECT logger_bot_started FROM users WHERE user_id = ?',
        [userId]
      );

      if (!result.rows || result.rows.length === 0) {
        return false;
      }

      return result.rows[0]?.logger_bot_started === 1;
    } catch (error) {
      logError('[LOGGER_BOT] Error checking logger bot status:', error);
      return false;
    }
  }

  /**
   * Mark logger bot as started/stopped for a user
   */
  async markLoggerBotStarted(userId, started) {
    try {
      await db.query(
        'UPDATE users SET logger_bot_started = ? WHERE user_id = ?',
        [started ? 1 : 0, userId]
      );
    } catch (error) {
      logError('[LOGGER_BOT] Error updating logger bot status:', error);
    }
  }

  /**
   * Queue log for batching (reduces spam)
   */
  queueLog(userId, message, options = {}) {
    if (!this.logQueue.has(userId)) {
      this.logQueue.set(userId, []);
    }

    const queue = this.logQueue.get(userId);
    queue.push({ message, options });

    // If queue is full, send immediately
    if (queue.length >= this.MAX_BATCH_SIZE) {
      this.flushQueue(userId);
      return;
    }

    // Set timeout to flush queue after delay
    if (this.queueTimeouts.has(userId)) {
      clearTimeout(this.queueTimeouts.get(userId));
    }

    const timeoutId = setTimeout(() => {
      this.flushQueue(userId);
    }, this.BATCH_DELAY);

    this.queueTimeouts.set(userId, timeoutId);
  }

  /**
   * Flush queued logs for a user
   */
  async flushQueue(userId) {
    if (!this.logQueue.has(userId)) {
      return;
    }

    const queue = this.logQueue.get(userId);
    if (queue.length === 0) {
      return;
    }

    // Clear timeout
    if (this.queueTimeouts.has(userId)) {
      clearTimeout(this.queueTimeouts.get(userId));
      this.queueTimeouts.delete(userId);
    }

    // Clear queue
    this.logQueue.delete(userId);

    // Send all queued logs
    for (const { message, options } of queue) {
      await this.sendLogDirect(userId, message, options);
      // Small delay between messages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Send log message to user (only if they started the logger bot)
   * Uses batching to reduce spam
   */
  async sendLog(userId, message, options = {}) {
    // Check if logger bot is configured
    if (!config.userLoggerBotToken || !this.initialized || !this.bot) {
      return { success: false, error: 'Logger bot not configured' };
    }

    // Check if user has started the logger bot
    const hasStarted = await this.hasLoggerBotStarted(userId);
    if (!hasStarted) {
      return { success: false, error: 'User has not started logger bot' };
    }

    // Check if user has blocked the bot
    if (this.blockedUsers.has(userId)) {
      return { success: false, error: 'User has blocked logger bot' };
    }

    // Queue log for batching (unless immediate flag is set)
    if (options.immediate) {
      delete options.immediate;
      return await this.sendLogDirect(userId, message, options);
    } else {
      this.queueLog(userId, message, options);
      return { success: true, queued: true };
    }
  }

  /**
   * Check if user has too many consecutive failures
   */
  hasTooManyFailures(userId) {
    const failures = this.failedSends.get(userId);
    if (!failures) {
      return false;
    }

    // Reset if enough time has passed
    if (Date.now() - failures.lastFailed > this.failureResetTime) {
      this.failedSends.delete(userId);
      return false;
    }

    return failures.consecutiveFailures >= this.maxConsecutiveFailures;
  }

  /**
   * Record a failed send attempt
   */
  recordFailure(userId, error) {
    if (!this.failedSends.has(userId)) {
      this.failedSends.set(userId, {
        count: 0,
        lastFailed: Date.now(),
        consecutiveFailures: 0,
        lastError: null
      });
    }

    const failures = this.failedSends.get(userId);
    failures.count++;
    failures.consecutiveFailures++;
    failures.lastFailed = Date.now();
    failures.lastError = error?.message || 'Unknown error';

    // Reset consecutive failures if enough time has passed
    if (Date.now() - failures.lastFailed > this.failureResetTime) {
      failures.consecutiveFailures = 0;
    }
  }

  /**
   * Record a successful send
   */
  recordSuccess(userId) {
    if (this.failedSends.has(userId)) {
      const failures = this.failedSends.get(userId);
      failures.consecutiveFailures = 0; // Reset consecutive failures on success
    }
  }

  /**
   * Check if error indicates bot is blocked
   */
  isBotBlockedError(error) {
    if (!error) return false;

    const errorMessage = (error.message || error.toString() || '').toLowerCase();
    const errorCode = error.code || error.errorCode || error.response?.error_code;
    const errorDescription = (error.description || error.response?.description || '').toLowerCase();

    return (
      errorMessage.includes('bot was blocked') ||
      errorMessage.includes('bot blocked') ||
      errorMessage.includes('blocked') ||
      errorMessage.includes('chat not found') ||
      errorMessage.includes('user is deactivated') ||
      errorMessage.includes('chat_id_invalid') ||
      errorCode === 403 ||
      (errorCode === 400 && (errorMessage.includes('blocked') || errorMessage.includes('forbidden'))) ||
      errorDescription.includes('blocked') ||
      errorDescription.includes('chat not found')
    );
  }

  /**
   * Check if error indicates network/connection issue
   */
  isNetworkError(error) {
    if (!error) return false;

    const errorMessage = (error.message || error.toString() || '').toLowerCase();
    const errorCode = error.code;

    return (
      errorMessage.includes('econnrefused') ||
      errorMessage.includes('etimedout') ||
      errorMessage.includes('enotfound') ||
      errorMessage.includes('network') ||
      errorMessage.includes('connection') ||
      errorMessage.includes('timeout') ||
      errorCode === 'ECONNREFUSED' ||
      errorCode === 'ETIMEDOUT' ||
      errorCode === 'ENOTFOUND'
    );
  }

  /**
   * Check if error indicates rate limiting
   */
  isRateLimitError(error) {
    if (!error) return false;

    const errorMessage = (error.message || error.toString() || '').toLowerCase();
    const errorCode = error.code || error.errorCode || error.response?.error_code;

    return (
      errorCode === 429 ||
      errorMessage.includes('rate limit') ||
      errorMessage.includes('too many requests') ||
      errorMessage.includes('flood') ||
      errorMessage.includes('retry after')
    );
  }

  /**
   * Send log message directly (internal method) with enhanced error handling
   */
  async sendLogDirect(userId, message, options = {}) {
    // Check if user has too many failures
    if (this.hasTooManyFailures(userId)) {
      const failures = this.failedSends.get(userId);
      console.log(`[LOGGER_BOT] Skipping send to user ${userId} - too many consecutive failures (${failures.consecutiveFailures})`);
      return { success: false, error: 'Too many consecutive failures', skipped: true };
    }

    // Check if bot is initialized
    if (!this.bot || !this.initialized) {
      console.log('[LOGGER_BOT] Bot not initialized, skipping send');
      return { success: false, error: 'Logger bot not initialized' };
    }

    try {
      const sendResult = await safeBotApiCall(
        () => this.bot.sendMessage(userId, message, {
          parse_mode: 'HTML',
          ...options
        }),
        { 
          maxRetries: 3, 
          bufferSeconds: 2, 
          throwOnFailure: false 
        }
      );

      if (sendResult) {
        // Record success
        this.recordSuccess(userId);
        return { success: true };
      } else {
        // Send failed - check if it's a blocked user
        const error = new Error('Failed to send message');
        this.recordFailure(userId, error);
        
        // Mark as blocked if we suspect blocking
        this.blockedUsers.add(userId);
        await this.markLoggerBotStarted(userId, false);
        
        return { success: false, error: 'Failed to send (user may have blocked bot)' };
      }
    } catch (error) {
      // Check error type
      if (this.isBotBlockedError(error)) {
        // User blocked the bot - mark them and don't try again
        this.blockedUsers.add(userId);
        await this.markLoggerBotStarted(userId, false);
        this.recordFailure(userId, error);
        console.log(`[LOGGER_BOT] User ${userId} has blocked the logger bot`);
        return { success: false, error: 'User has blocked logger bot', blocked: true };
      }

      if (this.isNetworkError(error)) {
        // Network error - retry later
        this.recordFailure(userId, error);
        console.log(`[LOGGER_BOT] Network error sending to user ${userId}: ${error.message}`);
        return { success: false, error: 'Network error, will retry later', retry: true };
      }

      if (this.isRateLimitError(error)) {
        // Rate limit - wait and retry
        this.recordFailure(userId, error);
        console.log(`[LOGGER_BOT] Rate limited sending to user ${userId}`);
        return { success: false, error: 'Rate limited, will retry later', retry: true };
      }

      // Other error - record and log
      this.recordFailure(userId, error);
      logError('[LOGGER_BOT] Error sending log:', error);
      return { success: false, error: error.message || 'Unknown error' };
    }
  }

  /**
   * Send broadcast started log
   */
  async logBroadcastStarted(userId, accountId, details = {}) {
    let message = '📢 <b>Broadcast Started</b>\n\n' +
                   `Your broadcast has been started successfully.\n` +
                   `Account ID: ${accountId}\n`;
    
    if (details.messagePreview) {
      const preview = details.messagePreview.length > 100 
        ? details.messagePreview.substring(0, 100) + '...' 
        : details.messagePreview;
      message += `Message: ${preview}\n`;
    }
    if (details.groupCount) {
      message += `Groups: ${details.groupCount}\n`;
    }
    if (details.interval) {
      message += `Interval: ${details.interval} minutes\n`;
    }
    
    message += `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message, { immediate: true });
  }

  /**
   * Send broadcast stopped log
   */
  async logBroadcastStopped(userId, accountId, details = {}) {
    let message = '⏹️ <b>Broadcast Stopped</b>\n\n' +
                   `Your broadcast has been stopped.\n` +
                   `Account ID: ${accountId}\n`;
    
    if (details.reason) {
      message += `Reason: ${details.reason}\n`;
    }
    if (details.messagesSent !== undefined) {
      message += `Messages Sent: ${details.messagesSent}\n`;
    }
    if (details.duration) {
      message += `Duration: ${Math.round(details.duration / 60)} minutes\n`;
    }
    
    message += `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message, { immediate: true });
  }

  /**
   * Send account linked log
   */
  async logAccountLinked(userId, phone, accountId) {
    const message = '🔗 <b>Account Linked</b>\n\n' +
                   `Your account has been successfully linked.\n` +
                   `Phone: ${phone}\n` +
                   `Account ID: ${accountId}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Send account deleted log
   */
  async logAccountDeleted(userId, accountId, phone) {
    const message = '🗑️ <b>Account Deleted</b>\n\n' +
                   `Your account has been deleted.\n` +
                   `Account ID: ${accountId}\n` +
                   `Phone: ${phone || 'N/A'}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Send cycle completion log with stats
   */
  async logCycleCompleted(userId, accountId, stats) {
    const { groupsProcessed = 0, messagesSent = 0, errors = 0, skipped = 0 } = stats;
    const message = '✅ <b>Cycle Completed</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Groups Processed: ${groupsProcessed}\n` +
                   `Messages Sent: ${messagesSent}\n` +
                   `Skipped: ${skipped}\n` +
                   `Errors: ${errors}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Forward auto-reply message to logger bot
   */
  async logAutoReply(userId, accountId, originalMessage, replyMessage, chatInfo) {
    try {
      // First send a summary message
      const summary = '💬 <b>Auto-Reply Sent</b>\n\n' +
                     `Account ID: ${accountId}\n` +
                     `Chat: ${chatInfo.name || chatInfo.id || 'Unknown'}\n` +
                     `Chat Type: ${chatInfo.type || 'Unknown'}\n` +
                     `Time: ${new Date().toLocaleString()}\n\n` +
                     `Original message will be forwarded below:`;
      
      await this.sendLog(userId, summary);
      
      // Forward the original message if possible
      // Note: We can't directly forward from MTProto, so we'll format it as text
      if (originalMessage && originalMessage.text) {
        const forwardedMessage = `📨 <b>Original Message:</b>\n\n` +
                                `${originalMessage.text}\n\n` +
                                `📤 <b>Reply Sent:</b>\n${replyMessage}`;
        
        await this.sendLog(userId, forwardedMessage);
      } else {
        const replyOnly = `📤 <b>Reply Sent:</b>\n${replyMessage}`;
        await this.sendLog(userId, replyOnly);
      }
      
      return { success: true };
    } catch (error) {
      logError('[LOGGER_BOT] Error logging auto-reply:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send account activity log
   */
  async logAccountActivity(userId, activity, details = {}) {
    let message = `📊 <b>Account Activity</b>\n\n${activity}\n`;
    
    if (details.accountId) {
      message += `Account ID: ${details.accountId}\n`;
    }
    if (details.groupCount) {
      message += `Groups: ${details.groupCount}\n`;
    }
    if (details.messagesSent) {
      message += `Messages Sent: ${details.messagesSent}\n`;
    }
    
    message += `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Send error log
   */
  async logError(userId, errorType, errorMessage) {
    const message = '⚠️ <b>Error Notification</b>\n\n' +
                   `Type: ${errorType}\n` +
                   `Message: ${errorMessage}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log group refresh event
   */
  async logGroupRefresh(userId, accountId, stats) {
    const { added = 0, updated = 0, total = 0, removed = 0 } = stats;
    const message = '🔄 <b>Groups Refreshed</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Total Groups: ${total}\n` +
                   `Added: ${added}\n` +
                   `Updated: ${updated}\n` +
                   `Removed: ${removed}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log group added/removed
   */
  async logGroupChange(userId, accountId, groupName, action) {
    const icon = action === 'added' ? '➕' : action === 'removed' ? '➖' : '📝';
    const message = `${icon} <b>Group ${action.charAt(0).toUpperCase() + action.slice(1)}</b>\n\n` +
                   `Account ID: ${accountId}\n` +
                   `Group: ${groupName}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log settings change
   */
  async logSettingsChange(userId, accountId, settingName, oldValue, newValue) {
    const message = '⚙️ <b>Settings Changed</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Setting: ${settingName}\n` +
                   `Old Value: ${oldValue || 'N/A'}\n` +
                   `New Value: ${newValue || 'N/A'}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log interval change
   */
  async logIntervalChange(userId, accountId, oldInterval, newInterval) {
    return await this.logSettingsChange(
      userId,
      accountId,
      'Broadcast Interval',
      oldInterval ? `${oldInterval} minutes` : 'Default',
      newInterval ? `${newInterval} minutes` : 'Default'
    );
  }

  /**
   * Log quiet hours change
   */
  async logQuietHoursChange(userId, accountId, quietStart, quietEnd, enabled) {
    const value = enabled ? `${quietStart} - ${quietEnd}` : 'Disabled';
    return await this.logSettingsChange(
      userId,
      accountId,
      'Quiet Hours',
      enabled ? 'Enabled' : 'Disabled',
      value
    );
  }

  /**
   * Log schedule change
   */
  async logScheduleChange(userId, accountId, schedule, enabled) {
    const value = enabled ? schedule : 'Disabled';
    return await this.logSettingsChange(
      userId,
      accountId,
      'Schedule',
      enabled ? 'Enabled' : 'Disabled',
      value
    );
  }

  /**
   * Log daily cap reached warning
   */
  async logDailyCapReached(userId, accountId, dailySent, dailyCap) {
    const percentage = Math.round((dailySent / dailyCap) * 100);
    const message = '⚠️ <b>Daily Cap Warning</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Daily Sent: ${dailySent}/${dailyCap} (${percentage}%)\n` +
                   `Broadcast will pause until cap resets.\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log daily cap reset
   */
  async logDailyCapReset(userId, accountId) {
    const message = '🔄 <b>Daily Cap Reset</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Your daily cap has been reset. Broadcast can resume.\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log message pool change
   */
  async logMessagePoolChange(userId, accountId, action, details = {}) {
    let message = `📚 <b>Message Pool ${action.charAt(0).toUpperCase() + action.slice(1)}</b>\n\n` +
                  `Account ID: ${accountId}\n`;
    
    if (details.messageId) {
      message += `Message ID: ${details.messageId}\n`;
    }
    if (details.messageText) {
      const preview = details.messageText.length > 50 
        ? details.messageText.substring(0, 50) + '...' 
        : details.messageText;
      message += `Message: ${preview}\n`;
    }
    if (details.poolSize !== undefined) {
      message += `Pool Size: ${details.poolSize}\n`;
    }
    if (details.mode) {
      message += `Mode: ${details.mode}\n`;
    }
    
    message += `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log account status change
   */
  async logAccountStatusChange(userId, accountId, status, reason = '') {
    const icon = status === 'active' ? '🟢' : status === 'inactive' ? '⚪' : '⚠️';
    const message = `${icon} <b>Account Status Changed</b>\n\n` +
                   `Account ID: ${accountId}\n` +
                   `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}\n` +
                   (reason ? `Reason: ${reason}\n` : '') +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log session issue
   */
  async logSessionIssue(userId, accountId, issueType, details = '') {
    const icon = issueType === 'revoked' ? '🔒' : issueType === 'expired' ? '⏰' : '⚠️';
    const message = `${icon} <b>Session Issue</b>\n\n` +
                   `Account ID: ${accountId}\n` +
                   `Issue: ${issueType.charAt(0).toUpperCase() + issueType.slice(1)}\n` +
                   (details ? `Details: ${details}\n` : '') +
                   `Please re-link your account if needed.\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log rate limiting warning
   */
  async logRateLimitWarning(userId, accountId, waitTime, reason = '') {
    const message = '⏳ <b>Rate Limit Warning</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Wait Time: ${waitTime} seconds\n` +
                   (reason ? `Reason: ${reason}\n` : '') +
                   `Broadcast will resume after wait period.\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log premium status change
   */
  async logPremiumStatusChange(userId, accountId, isPremium, expiryDate = null) {
    const icon = isPremium ? '⭐' : '⚪';
    const message = `${icon} <b>Premium Status Changed</b>\n\n` +
                   `Account ID: ${accountId}\n` +
                   `Status: ${isPremium ? 'Premium Active' : 'Premium Inactive'}\n` +
                   (expiryDate ? `Expires: ${new Date(expiryDate).toLocaleString()}\n` : '') +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log payment verification
   */
  async logPaymentVerification(userId, accountId, status, transactionId = '') {
    const icon = status === 'success' ? '✅' : status === 'failed' ? '❌' : '⏳';
    const message = `${icon} <b>Payment Verification</b>\n\n` +
                   `Account ID: ${accountId}\n` +
                   `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}\n` +
                   (transactionId ? `Transaction ID: ${transactionId}\n` : '') +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log detailed broadcast stats
   */
  async logBroadcastStats(userId, accountId, stats) {
    const {
      groupsProcessed = 0,
      messagesSent = 0,
      messagesFailed = 0,
      skipped = 0,
      errors = 0,
      duration = 0,
      averageDelay = 0
    } = stats;
    
    const successRate = messagesSent + messagesFailed > 0
      ? Math.round((messagesSent / (messagesSent + messagesFailed)) * 100)
      : 0;
    
    const message = '📊 <b>Broadcast Statistics</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Groups Processed: ${groupsProcessed}\n` +
                   `Messages Sent: ${messagesSent}\n` +
                   `Messages Failed: ${messagesFailed}\n` +
                   `Success Rate: ${successRate}%\n` +
                   `Skipped: ${skipped}\n` +
                   `Errors: ${errors}\n` +
                   (duration > 0 ? `Duration: ${Math.round(duration / 60)} minutes\n` : '') +
                   (averageDelay > 0 ? `Avg Delay: ${averageDelay.toFixed(1)}s\n` : '') +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log message sent to group
   */
  async logMessageSent(userId, accountId, groupName, groupId, success, errorMessage = null) {
    const icon = success ? '✅' : '❌';
    const message = `${icon} <b>Message ${success ? 'Sent' : 'Failed'}</b>\n\n` +
                   `Account ID: ${accountId}\n` +
                   `Group: ${groupName}\n` +
                   `Group ID: ${groupId}\n` +
                   (errorMessage ? `Error: ${errorMessage}\n` : '') +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log connection status change
   */
  async logConnectionStatus(userId, accountId, status, details = '') {
    const icon = status === 'connected' ? '🟢' : status === 'disconnected' ? '🔴' : '⚠️';
    const message = `${icon} <b>Connection Status</b>\n\n` +
                   `Account ID: ${accountId}\n` +
                   `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}\n` +
                   (details ? `Details: ${details}\n` : '') +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log auto-reply settings change
   */
  async logAutoReplySettingsChange(userId, accountId, type, enabled, message = null) {
    const icon = type === 'dm' ? '💬' : '👥';
    const messageText = message && message.length > 50 
      ? message.substring(0, 50) + '...' 
      : message || 'N/A';
    
    const logMessage = `${icon} <b>Auto-Reply Settings Changed</b>\n\n` +
                      `Account ID: ${accountId}\n` +
                      `Type: ${type.toUpperCase()}\n` +
                      `Status: ${enabled ? 'Enabled' : 'Disabled'}\n` +
                      (enabled && message ? `Message: ${messageText}\n` : '') +
                      `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, logMessage);
  }

  /**
   * Log message set/updated
   */
  async logMessageSet(userId, accountId, variant = 'A', messageText = null) {
    const preview = messageText && messageText.length > 50 
      ? messageText.substring(0, 50) + '...' 
      : messageText || 'N/A';
    
    const message = '📝 <b>Message Set</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Variant: ${variant}\n` +
                   `Message: ${preview}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log quiet hours active/inactive
   */
  async logQuietHoursStatus(userId, accountId, isActive, reason = '') {
    const icon = isActive ? '🌙' : '☀️';
    const message = `${icon} <b>Quiet Hours ${isActive ? 'Active' : 'Inactive'}</b>\n\n` +
                   `Account ID: ${accountId}\n` +
                   `Status: ${isActive ? 'Broadcast paused' : 'Broadcast can resume'}\n` +
                   (reason ? `Reason: ${reason}\n` : '') +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log account switched
   */
  async logAccountSwitched(userId, oldAccountId, newAccountId) {
    const message = '🔄 <b>Account Switched</b>\n\n' +
                   `Switched from Account ID: ${oldAccountId || 'None'}\n` +
                   `To Account ID: ${newAccountId}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message, { immediate: true });
  }

  /**
   * Log forward mode change
   */
  async logForwardModeChange(userId, accountId, enabled, messageId = null) {
    const message = '↗️ <b>Forward Mode Changed</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Status: ${enabled ? 'Enabled' : 'Disabled'}\n` +
                   (enabled && messageId ? `Message ID: ${messageId}\n` : '') +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log A/B testing change
   */
  async logABTestingChange(userId, accountId, enabled, mode = null, variant = null) {
    const message = '🧪 <b>A/B Testing Changed</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Status: ${enabled ? 'Enabled' : 'Disabled'}\n` +
                   (enabled && mode ? `Mode: ${mode}\n` : '') +
                   (variant ? `Current Variant: ${variant}\n` : '') +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log template synced
   */
  async logTemplateSynced(userId, accountId, slot, success, error = null) {
    const icon = success ? '✅' : '❌';
    const message = `${icon} <b>Template Synced</b>\n\n` +
                   `Account ID: ${accountId}\n` +
                   `Slot: ${slot}\n` +
                   `Status: ${success ? 'Success' : 'Failed'}\n` +
                   (error ? `Error: ${error}\n` : '') +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message, { immediate: true });
  }

  /**
   * Log group delay change
   */
  async logGroupDelayChange(userId, accountId, minDelay, maxDelay) {
    const message = '⏱️ <b>Group Delay Changed</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Min Delay: ${minDelay} seconds\n` +
                   `Max Delay: ${maxDelay} seconds\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Log mention settings change
   */
  async logMentionSettingsChange(userId, accountId, enabled, count = null) {
    const message = '🔔 <b>Mention Settings Changed</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Auto-Mention: ${enabled ? 'Enabled' : 'Disabled'}\n` +
                   (enabled && count ? `Mention Count: ${count}\n` : '') +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Start periodic health check
   */
  startHealthCheck() {
    // Clear existing interval if any
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Check health every 5 minutes
    this.healthCheckInterval = setInterval(async () => {
      try {
        // Check if bot is still connected
        if (this.bot && this.initialized) {
          try {
            await this.bot.getMe();
            // Bot is healthy
            this.reconnectAttempts = 0;
          } catch (error) {
            console.log(`[LOGGER_BOT] Health check failed: ${error.message}`);
            this.reconnectAttempts++;
            
            // Try to reconnect if too many failures
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
              console.log('[LOGGER_BOT] Too many health check failures, attempting reconnect...');
              await this.reconnect();
            }
          }
        }

        // Clean up old failure records
        const now = Date.now();
        for (const [userId, failures] of this.failedSends.entries()) {
          if (now - failures.lastFailed > this.failureResetTime * 2) {
            this.failedSends.delete(userId);
          }
        }

        // Clean up blocked users list periodically (they might unblock)
        if (this.blockedUsers.size > 1000) {
          // Keep only recent blocks (last 24 hours)
          // Note: We can't track when users unblock, so we'll just limit the size
          const usersArray = Array.from(this.blockedUsers);
          this.blockedUsers.clear();
          // Keep last 500 users
          usersArray.slice(-500).forEach(userId => this.blockedUsers.add(userId));
        }
      } catch (error) {
        logError('[LOGGER_BOT] Error in health check:', error);
      }
    }, 5 * 60 * 1000); // 5 minutes
  }

  /**
   * Attempt to reconnect the bot
   */
  async reconnect() {
    try {
      console.log('[LOGGER_BOT] Attempting to reconnect...');
      
      // Stop current polling
      if (this.bot) {
        try {
          await this.bot.stopPolling();
        } catch (e) {
          // Ignore errors stopping
        }
      }

      // Reinitialize
      await this.initialize();
      
      if (this.initialized) {
        console.log('[LOGGER_BOT] ✅ Reconnected successfully');
        this.reconnectAttempts = 0;
      } else {
        console.log('[LOGGER_BOT] ❌ Reconnection failed');
      }
    } catch (error) {
      logError('[LOGGER_BOT] Error reconnecting:', error);
      this.reconnectAttempts++;
      
      // Schedule retry with exponential backoff
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(60000 * Math.pow(2, this.reconnectAttempts), 300000); // Max 5 minutes
        console.log(`[LOGGER_BOT] Scheduling reconnect retry in ${delay / 1000}s...`);
        setTimeout(() => this.reconnect(), delay);
      }
    }
  }

  /**
   * Get failure statistics for a user
   */
  getFailureStats(userId) {
    const failures = this.failedSends.get(userId);
    if (!failures) {
      return { count: 0, consecutiveFailures: 0, lastFailed: null, lastError: null };
    }
    return {
      count: failures.count,
      consecutiveFailures: failures.consecutiveFailures,
      lastFailed: failures.lastFailed,
      lastError: failures.lastError
    };
  }

  /**
   * Clear failure records for a user (for testing/recovery)
   */
  clearFailures(userId) {
    this.failedSends.delete(userId);
    this.blockedUsers.delete(userId);
  }

  /**
   * Safe wrapper for logging - handles all errors gracefully
   * Use this instead of direct method calls to ensure errors don't break the main bot
   */
  async safeLog(userId, logMethod, ...args) {
    try {
      // Check if logger bot is available
      if (!config.userLoggerBotToken || !this.initialized || !this.bot) {
        return { success: false, error: 'Logger bot not available', skipped: true };
      }

      // Check if user has started logger bot
      const hasStarted = await this.hasLoggerBotStarted(userId);
      if (!hasStarted) {
        return { success: false, error: 'User has not started logger bot', skipped: true };
      }

      // Check if user is blocked
      if (this.blockedUsers.has(userId)) {
        return { success: false, error: 'User has blocked logger bot', skipped: true };
      }

      // Check if user has too many failures
      if (this.hasTooManyFailures(userId)) {
        return { success: false, error: 'Too many failures', skipped: true };
      }

      // Call the log method
      if (typeof this[logMethod] === 'function') {
        return await this[logMethod](userId, ...args);
      } else {
        console.error(`[LOGGER_BOT] Invalid log method: ${logMethod}`);
        return { success: false, error: 'Invalid log method' };
      }
    } catch (error) {
      // Never throw - always return error object
      logError(`[LOGGER_BOT] Error in safeLog (${logMethod}):`, error);
      return { success: false, error: error.message || 'Unknown error' };
    }
  }

  /**
   * Stop the logger bot
   */
  async stop() {
    // Clear health check interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Flush all queues before stopping
    const userIds = Array.from(this.logQueue.keys());
    for (const userId of userIds) {
      await this.flushQueue(userId);
    }

    if (this.bot) {
      try {
        await this.bot.stopPolling();
        console.log('[LOGGER_BOT] Logger bot stopped');
      } catch (error) {
        logError('[LOGGER_BOT] Error stopping logger bot:', error);
      }
    }

    this.initialized = false;
  }
}

const loggerBotService = new LoggerBotService();
export default loggerBotService;

