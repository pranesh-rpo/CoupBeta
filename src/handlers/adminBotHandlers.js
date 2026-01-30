/**
 * Admin Bot Handlers
 * Handles admin bot commands and controls
 */

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import db from '../database/db.js';
import accountLinker from '../services/accountLinker.js';
import automationService from '../services/automationService.js';
import premiumService from '../services/premiumService.js';
import logger from '../utils/logger.js';
import adminNotifier from '../services/adminNotifier.js';
import { isFloodWaitError, extractWaitTime, waitForFloodError, safeBotApiCall } from '../utils/floodWaitHandler.js';
import { validateUserId, sanitizeErrorMessage, adminCommandRateLimiter } from '../utils/security.js';

let adminBot = null;
let mainBot = null; // Reference to main bot for sending messages to users
let lastAdminBroadcast = null; // Store last broadcast message
let pollingRetryCount = 0;
let pollingRetryTimeout = null;
const MAX_POLLING_RETRIES = 5;
const BASE_RETRY_DELAY = 10000; // 10 seconds base delay

/**
 * Restart admin bot polling with retry logic and exponential backoff
 */
async function restartPolling() {
  if (!adminBot) return;
  
  pollingRetryCount++;
  if (pollingRetryCount > MAX_POLLING_RETRIES) {
    console.error('[ADMIN BOT] Max polling retries reached. Stopping retry attempts.');
    pollingRetryTimeout = null;
    return;
  }
  
  // Exponential backoff: 10s, 20s, 40s, 80s, 160s
  const retryDelay = BASE_RETRY_DELAY * Math.pow(2, pollingRetryCount - 1);
  
  console.log(`[ADMIN BOT] Restarting polling (attempt ${pollingRetryCount}/${MAX_POLLING_RETRIES}) in ${retryDelay / 1000}s...`);
  
  try {
    adminBot.stopPolling();
    
    // Wait a moment before restarting
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Delete webhook before restarting polling
    try {
      await safeBotApiCall(
        () => adminBot.deleteWebHook({ drop_pending_updates: false }),
        { maxRetries: 2, bufferSeconds: 1, throwOnFailure: false }
      );
    } catch (webhookError) {
      // Ignore webhook deletion errors
    }
    
    // Wait a bit more before starting polling
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    try {
      await adminBot.startPolling({ restart: true });
      pollingRetryCount = 0; // Reset on success
      pollingRetryTimeout = null;
      console.log('[ADMIN BOT] Polling restarted successfully');
    } catch (restartError) {
      const errorMessage = restartError.message || '';
      
      // Check for 409 Conflict error
      if (errorMessage.includes('409') || errorMessage.includes('Conflict') || errorMessage.includes('terminated by other getUpdates')) {
        console.error('[ADMIN BOT] ⚠️ 409 Conflict when restarting polling - stopping retry attempts');
        console.error('[ADMIN BOT] Another instance is already polling this bot token');
        pollingRetryTimeout = null;
        pollingRetryCount = MAX_POLLING_RETRIES + 1; // Prevent further retries
        return;
      }
      
      console.error('[ADMIN BOT] Failed to restart polling:', restartError);
      pollingRetryTimeout = setTimeout(restartPolling, retryDelay);
    }
  } catch (error) {
    console.error('[ADMIN BOT] Error stopping polling:', error);
    pollingRetryTimeout = setTimeout(restartPolling, retryDelay);
  }
}

/**
 * Initialize admin bot
 */
export function initializeAdminBot(mainBotInstance = null) {
  if (!config.adminBotToken) {
    console.log('[ADMIN BOT] Admin bot token not configured');
    return null;
  }

  // Prevent multiple initializations
  if (adminBot) {
    console.log('[ADMIN BOT] Admin bot already initialized, skipping...');
    return adminBot;
  }

  try {
    // Configure admin bot with autoStart: false so we can delete webhook first
    adminBot = new TelegramBot(config.adminBotToken, { 
      polling: {
        autoStart: false, // We'll start after deleting webhook
        interval: 300,
        params: {
          timeout: 10,
          allowed_updates: ['message', 'callback_query']
        }
      },
      request: {
        timeout: 60000, // 60 seconds timeout for requests
        agentOptions: {
          keepAlive: true,
          keepAliveMsecs: 10000
        }
      }
    });
    mainBot = mainBotInstance; // Store reference to main bot
    console.log('[ADMIN BOT] Admin bot instance created');
    console.log(`[ADMIN BOT] Main bot instance ${mainBot ? 'is set' : 'is NOT set'}`);

    // Enhanced error handlers with retry logic
    adminBot.on('polling_error', (error) => {
      const errorMessage = error.message || '';
      const errorCode = error.code || '';
      const errorName = error.name || '';
      const errorCause = error.cause || error.error || null;
      const errorStack = error.stack || '';
      
      // Check for 409 Conflict error (multiple getUpdates requests)
      const isConflictError = 
        errorCode === 409 ||
        errorMessage.includes('409') ||
        errorMessage.includes('Conflict') ||
        errorMessage.includes('terminated by other getUpdates') ||
        errorMessage.includes('only one bot instance is running');
      
      // Check for timeout errors in various forms (direct, wrapped, or in stack)
      // Include both ETIMEDOUT and ESOCKETTIMEDOUT
      const isTimeoutError = 
        errorCode === 'ETIMEDOUT' || 
        errorCode === 'ESOCKETTIMEDOUT' ||
        errorName === 'RequestError' && (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('ESOCKETTIMEDOUT')) ||
        errorMessage.includes('ETIMEDOUT') || 
        errorMessage.includes('ESOCKETTIMEDOUT') ||
        errorMessage.includes('TIMEOUT') ||
        (errorCause && (errorCause.code === 'ETIMEDOUT' || errorCause.code === 'ESOCKETTIMEDOUT' || errorCause.message?.includes('ETIMEDOUT') || errorCause.message?.includes('ESOCKETTIMEDOUT'))) ||
        errorStack.includes('ETIMEDOUT') ||
        errorStack.includes('ESOCKETTIMEDOUT');
      
      console.error('[ADMIN BOT] Polling error:', error);
      
      // Handle 409 Conflict error - another instance is polling
      if (isConflictError) {
        console.error('[ADMIN BOT] ⚠️ 409 Conflict: Another bot instance is polling. Stopping polling to avoid conflicts.');
        console.error('[ADMIN BOT] This usually means:');
        console.error('[ADMIN BOT]   1. Another process is using the same admin bot token');
        console.error('[ADMIN BOT]   2. A webhook is set for this bot');
        console.error('[ADMIN BOT]   3. The bot was restarted without properly stopping polling');
        logger.logError('ADMIN_BOT', null, error, 'Admin bot polling conflict - another instance is polling');
        
        // Stop polling to avoid conflicts
        try {
          adminBot.stopPolling();
          console.log('[ADMIN BOT] Polling stopped due to conflict');
        } catch (stopError) {
          console.error('[ADMIN BOT] Error stopping polling:', stopError);
        }
        
        // Don't retry on conflict errors - manual intervention needed
        return;
      }
      
      // Don't retry on certain errors (like unauthorized)
      if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        console.error('[ADMIN BOT] Unauthorized error - check ADMIN_BOT_TOKEN');
        logger.logError('ADMIN_BOT', null, error, 'Admin bot polling error - Unauthorized');
        return;
      }
      
      // Handle timeout errors gracefully - these are often transient network issues
      if (isTimeoutError) {
        console.warn('[ADMIN BOT] Polling timeout detected - will retry automatically');
        logger.logError('ADMIN_BOT', null, error, 'Admin bot polling timeout - will retry');
      } else {
        logger.logError('ADMIN_BOT', null, error, 'Admin bot polling error');
      }
      
      // Retry polling on other errors (including timeouts)
      if (pollingRetryCount < MAX_POLLING_RETRIES) {
        if (!pollingRetryTimeout) {
          const retryDelay = BASE_RETRY_DELAY * Math.pow(2, pollingRetryCount);
          pollingRetryTimeout = setTimeout(restartPolling, retryDelay);
        }
      }
    });

    adminBot.on('error', (error) => {
      const errorMessage = error.message || '';
      const errorCode = error.code || '';
      const errorName = error.name || '';
      const errorCause = error.cause || error.error || null;
      const errorStack = error.stack || '';
      
      // Check for timeout errors in various forms (direct, wrapped, or in stack)
      // Include both ETIMEDOUT and ESOCKETTIMEDOUT
      const isTimeoutError = 
        errorCode === 'ETIMEDOUT' || 
        errorCode === 'ESOCKETTIMEDOUT' ||
        errorName === 'RequestError' && (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('ESOCKETTIMEDOUT')) ||
        errorMessage.includes('ETIMEDOUT') || 
        errorMessage.includes('ESOCKETTIMEDOUT') ||
        errorMessage.includes('TIMEOUT') ||
        (errorCause && (errorCause.code === 'ETIMEDOUT' || errorCause.code === 'ESOCKETTIMEDOUT' || errorCause.message?.includes('ETIMEDOUT') || errorCause.message?.includes('ESOCKETTIMEDOUT'))) ||
        errorStack.includes('ETIMEDOUT') ||
        errorStack.includes('ESOCKETTIMEDOUT');
      
      const isConnectionError = 
        errorCode === 'ECONNREFUSED' || 
        errorMessage.includes('ECONNREFUSED') ||
        (errorCause && errorCause.code === 'ECONNREFUSED');
      
      console.error('[ADMIN BOT] Error:', error);
      
      // Handle timeout errors - these are often transient network issues
      if (isTimeoutError) {
        console.warn('[ADMIN BOT] Request timeout detected - will retry automatically');
        logger.logError('ADMIN_BOT', null, error, 'Admin bot request timeout - will retry');
      } else {
        logger.logError('ADMIN_BOT', null, error, 'Admin bot error');
      }
      
      // Retry on connection errors (including timeouts)
      if (isConnectionError || isTimeoutError) {
        if (pollingRetryCount < MAX_POLLING_RETRIES && !pollingRetryTimeout) {
          const retryDelay = BASE_RETRY_DELAY * Math.pow(2, pollingRetryCount);
          pollingRetryTimeout = setTimeout(restartPolling, retryDelay);
        }
      }
    });

    // Register admin commands
    registerAdminCommands(adminBot);
    
    // Delete webhook and start polling (similar to main bot)
    (async () => {
      try {
        // Delete any existing webhook before starting polling
        await safeBotApiCall(
          () => adminBot.deleteWebHook({ drop_pending_updates: false }),
          { maxRetries: 3, bufferSeconds: 1, throwOnFailure: false }
        );
        console.log('[ADMIN BOT] ✅ Deleted any existing webhook');
        
        // Wait a moment before starting polling
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Start polling
        await adminBot.startPolling();
        console.log('[ADMIN BOT] ✅ Polling started');
        pollingRetryCount = 0; // Reset retry count on successful start
      } catch (error) {
        const errorMessage = error.message || '';
        
        // Check for 409 Conflict error
        if (errorMessage.includes('409') || errorMessage.includes('Conflict') || errorMessage.includes('terminated by other getUpdates')) {
          console.error('[ADMIN BOT] ⚠️ 409 Conflict when starting polling:');
          console.error('[ADMIN BOT]   Another instance is already polling this bot token');
          console.error('[ADMIN BOT]   Please check for other running instances or webhooks');
          logger.logError('ADMIN_BOT', null, error, 'Admin bot polling conflict on startup');
        } else if (isFloodWaitError(error)) {
          const waitSeconds = extractWaitTime(error);
          console.warn(`[ADMIN BOT] ⚠️ Rate limited while starting polling. Waiting ${waitSeconds + 1}s...`);
          await waitForFloodError(error, 1);
          // Retry starting polling
          try {
            await adminBot.startPolling();
            console.log('[ADMIN BOT] ✅ Polling started (after flood wait retry)');
          } catch (retryError) {
            console.error('[ADMIN BOT] Failed to start polling after retry:', retryError);
            logger.logError('ADMIN_BOT', null, retryError, 'Admin bot polling start failed after retry');
          }
        } else {
          console.error('[ADMIN BOT] Failed to start polling:', error);
          logger.logError('ADMIN_BOT', null, error, 'Admin bot polling start failed');
        }
      }
    })();
    
    return adminBot;
  } catch (error) {
    console.error('[ADMIN BOT] Failed to initialize:', error);
    logger.logError('ADMIN_BOT', null, error, 'Failed to initialize admin bot');
    return null;
  }
}

/**
 * Register admin bot commands
 */
function registerAdminCommands(bot) {
  console.log('[ADMIN BOT] Registering admin commands...');
  
  // /start command
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Check if user is admin
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, '❌ You are not authorized to use this bot.');
      return;
    }

    const welcomeMessage = `👑 <b>Admin Bot</b>\n\n` +
      `Welcome, Admin!\n\n` +
      `<b>📊 Statistics & Information:</b>\n` +
      `/stats - View bot statistics\n` +
      `/users - List recent users (last 20)\n` +
      `/accounts - List recent accounts (last 20)\n` +
      `/broadcasts - View active broadcasts\n` +
      `/groups - List groups by account\n` +
      `/database - Database statistics\n\n` +
      `<b>👁️ Monitoring & Logs:</b>\n` +
      `/logs - View recent logs (last 10)\n` +
      `/logs_error - View error logs only\n` +
      `/logs_success - View success logs only\n` +
      `/errors - View recent errors (last 10)\n` +
      `/user &lt;id&gt; - Get user details\n` +
      `/account &lt;id&gt; - Get account details\n\n` +
      `<b>⭐ Premium Management:</b>\n` +
      `/premium_stats - Premium statistics\n` +
      `/premium_list - List active premium subscriptions\n` +
      `/premium_all - List all premium (all statuses)\n` +
      `/premium_expiring - List expiring in 7 days\n` +
      `/premium_user &lt;id&gt; - Get user premium status\n` +
      `/premium_add &lt;id&gt; - Add premium (30 days default)\n` +
      `/premium_set_date &lt;id&gt; &lt;YYYY-MM-DD&gt; - Set expiry date manually\n` +
      `/premium_extend &lt;id&gt; &lt;days&gt; - Extend premium by days\n` +
      `/premium_remove &lt;id&gt; - Remove/cancel premium\n` +
      `/premium_update &lt;id&gt; &lt;amount&gt; - Update subscription amount\n\n` +
      `<b>🎮 Broadcast Control:</b>\n` +
      `/stop_broadcast &lt;user_id&gt; - Stop user's broadcast\n` +
      `/stop_all_broadcasts - Stop all broadcasts\n` +
      `/abroadcast &lt;message&gt; - Broadcast to all users\n` +
      `/abroadcast_last - Resend last broadcast\n\n` +
      `<b>📢 Notifications:</b>\n` +
      `/notify &lt;message&gt; - Send notification to admins\n\n` +
      `<b>⚙️ System & Status:</b>\n` +
      `/status - Bot health status\n` +
      `/uptime - Bot uptime information\n` +
      `/test - Test admin bot connection\n\n` +
      `<b>❓ Help & Navigation:</b>\n` +
      `/help - Show detailed help with descriptions\n` +
      `/start - Show this welcome message`;

    await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
  });

  // /stats command
  bot.onText(/\/stats/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const userCount = await db.query('SELECT COUNT(*) as count FROM users');
      const accountCount = await db.query('SELECT COUNT(*) as count FROM accounts');
      const activeBroadcasts = automationService.activeBroadcasts?.size || 0;
      const groupCount = await db.query('SELECT COUNT(*) as count FROM groups WHERE is_active = TRUE');
      const messageCount = await db.query('SELECT COUNT(*) as count FROM messages');

      const statsMessage = `📊 <b>Bot Statistics</b>\n\n` +
        `👥 Total Users: ${userCount.rows[0].count}\n` +
        `🔑 Total Accounts: ${accountCount.rows[0].count}\n` +
        `📢 Active Broadcasts: ${activeBroadcasts}\n` +
        `👥 Active Groups: ${groupCount.rows[0].count}\n` +
        `📝 Total Messages: ${messageCount.rows[0].count}`;

      await bot.sendMessage(msg.chat.id, statsMessage, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /users command
  bot.onText(/\/users/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const users = await db.query(
        'SELECT user_id, username, first_name, joined_at, is_verified FROM users ORDER BY joined_at DESC LIMIT 20'
      );

      let message = `👥 <b>Recent Users</b> (Last 20)\n\n`;
      users.rows.forEach((user, i) => {
        message += `${i + 1}. <b>${user.first_name || 'Unknown'}</b>\n`;
        message += `   ID: <code>${user.user_id}</code>\n`;
        message += `   Username: @${user.username || 'N/A'}\n`;
        message += `   Verified: ${user.is_verified ? '✅' : '❌'}\n`;
        message += `   Joined: ${new Date(user.joined_at).toLocaleString()}\n\n`;
      });

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /accounts command
  bot.onText(/\/accounts/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const accounts = await db.query(
        'SELECT account_id, user_id, phone, is_active, is_broadcasting, created_at FROM accounts ORDER BY created_at DESC LIMIT 20'
      );

      let message = `🔑 <b>Recent Accounts</b> (Last 20)\n\n`;
      accounts.rows.forEach((account, i) => {
        message += `${i + 1}. <b>${account.phone}</b>\n`;
        message += `   Account ID: <code>${account.account_id}</code>\n`;
        message += `   User ID: <code>${account.user_id}</code>\n`;
        message += `   Active: ${account.is_active ? '✅' : '❌'}\n`;
        message += `   Broadcasting: ${account.is_broadcasting ? '📢' : '⏸️'}\n`;
        message += `   Created: ${new Date(account.created_at).toLocaleString()}\n\n`;
      });

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /broadcasts command
  bot.onText(/\/broadcasts/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const activeBroadcasts = Array.from(automationService.activeBroadcasts?.entries() || []);
      
      if (activeBroadcasts.length === 0) {
        await bot.sendMessage(msg.chat.id, '📢 No active broadcasts');
        return;
      }

      let message = `📢 <b>Active Broadcasts</b>\n\n`;
      activeBroadcasts.forEach(([userId, broadcast], i) => {
        message += `${i + 1}. User ID: <code>${userId}</code>\n`;
        message += `   Account ID: <code>${broadcast.accountId}</code>\n`;
        message += `   Messages Sent: ${broadcast.messageCount || 0}\n`;
        message += `   Running: ${broadcast.isRunning ? '✅' : '❌'}\n\n`;
      });

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /logs command
  bot.onText(/\/logs/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const logs = await db.query(
        'SELECT * FROM logs ORDER BY timestamp DESC LIMIT 10'
      );

      let message = `📋 <b>Recent Logs</b> (Last 10)\n\n`;
      logs.rows.forEach((log, i) => {
        const time = new Date(log.timestamp).toLocaleString();
        const status = log.status === 'success' ? '✅' : log.status === 'error' ? '❌' : 'ℹ️';
        message += `${status} <b>${time}</b>\n`;
        message += `${log.message.substring(0, 80)}${log.message.length > 80 ? '...' : ''}\n\n`;
      });

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /errors command
  bot.onText(/\/errors/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const errors = await db.query(
        "SELECT * FROM logs WHERE status = 'error' ORDER BY timestamp DESC LIMIT 10"
      );

      if (errors.rows.length === 0) {
        await bot.sendMessage(msg.chat.id, '✅ No recent errors');
        return;
      }

      let message = `❌ <b>Recent Errors</b> (Last 10)\n\n`;
      errors.rows.forEach((error, i) => {
        const time = new Date(error.timestamp).toLocaleString();
        message += `${i + 1}. <b>${time}</b>\n`;
        message += `<code>${error.message.substring(0, 100)}${error.message.length > 100 ? '...' : ''}</code>\n\n`;
      });

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /user <id> command
  bot.onText(/\/user (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    // SECURITY: Rate limiting for admin commands
    const rateLimit = adminCommandRateLimiter.checkRateLimit(adminUserId, 20, 60000); // 20 commands per minute
    if (!rateLimit.allowed) {
      await bot.sendMessage(
        msg.chat.id,
        `⏳ Rate limit exceeded. Please wait ${Math.ceil(rateLimit.resetIn / 1000)} seconds.`
      );
      return;
    }

    try {
      // SECURITY: Validate and sanitize user ID input
      const targetUserId = validateUserId(match[1]);
      if (!targetUserId) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid user ID format');
        return;
      }
      
      const user = await db.query('SELECT * FROM users WHERE user_id = $1', [targetUserId]);
      
      if (user.rows.length === 0) {
        await bot.sendMessage(msg.chat.id, '❌ User not found');
        return;
      }

      const accounts = await db.query('SELECT * FROM accounts WHERE user_id = $1', [userId]);
      const logs = await db.query('SELECT COUNT(*) as count FROM logs WHERE user_id = $1', [userId]);

      const userData = user.rows[0];
      let message = `👤 <b>User Details</b>\n\n`;
      message += `ID: <code>${userData.user_id}</code>\n`;
      message += `Username: @${userData.username || 'N/A'}\n`;
      message += `Name: ${userData.first_name || 'N/A'}\n`;
      message += `Verified: ${userData.is_verified ? '✅' : '❌'}\n`;
      message += `Joined: ${new Date(userData.joined_at).toLocaleString()}\n\n`;
      message += `Accounts: ${accounts.rows.length}\n`;
      message += `Log Entries: ${logs.rows[0].count}`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /stop_broadcast <user_id> command
  bot.onText(/\/stop_broadcast (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const userId = parseInt(match[1]);
      
      // Get all broadcasting account IDs for this user
      const broadcastingAccountIds = automationService.getBroadcastingAccountIds(userId);
      
      if (broadcastingAccountIds.length === 0) {
        await bot.sendMessage(msg.chat.id, `❌ No active broadcasts found for user ${userId}`);
        return;
      }
      
      let stoppedCount = 0;
      for (const accountId of broadcastingAccountIds) {
        const result = await automationService.stopBroadcast(userId, accountId);
        if (result.success) {
          stoppedCount++;
        }
      }
      
      await bot.sendMessage(msg.chat.id, `✅ Stopped ${stoppedCount} broadcast(s) for user ${userId}`);
      logger.logChange('ADMIN', msg.from.id, `Stopped ${stoppedCount} broadcast(s) for user ${userId}`);
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /stop_all_broadcasts command
  bot.onText(/\/stop_all_broadcasts/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const activeBroadcasts = Array.from(automationService.activeBroadcasts?.entries() || []);
      
      if (activeBroadcasts.length === 0) {
        await bot.sendMessage(msg.chat.id, '📢 No active broadcasts to stop');
        return;
      }
      
      let stoppedCount = 0;
      for (const [broadcastKey, broadcast] of activeBroadcasts) {
        if (broadcast.isRunning) {
          const result = await automationService.stopBroadcast(broadcast.userId, broadcast.accountId);
          if (result.success) {
            stoppedCount++;
          }
        }
      }
      
      await bot.sendMessage(msg.chat.id, `✅ Stopped ${stoppedCount} out of ${activeBroadcasts.length} active broadcast(s)`);
      logger.logChange('ADMIN', msg.from.id, `Stopped all broadcasts (${stoppedCount}/${activeBroadcasts.length})`);
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /account <id> command
  bot.onText(/\/account (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const accountId = parseInt(match[1]);
      const account = await db.query('SELECT * FROM accounts WHERE account_id = $1', [accountId]);
      
      if (account.rows.length === 0) {
        await bot.sendMessage(msg.chat.id, '❌ Account not found');
        return;
      }

      const accountData = account.rows[0];
      const groups = await db.query('SELECT COUNT(*) as count FROM groups WHERE account_id = $1 AND is_active = TRUE', [accountId]);
      const logs = await db.query('SELECT COUNT(*) as count FROM logs WHERE account_id = $1', [accountId]);
      const isBroadcasting = automationService.isBroadcasting(accountData.user_id, accountId);

      let message = `🔑 <b>Account Details</b>\n\n`;
      message += `Account ID: <code>${accountData.account_id}</code>\n`;
      message += `User ID: <code>${accountData.user_id}</code>\n`;
      message += `Phone: ${accountData.phone || 'N/A'}\n`;
      message += `Active: ${accountData.is_active ? '✅' : '❌'}\n`;
      message += `Broadcasting: ${isBroadcasting ? '📢 Yes' : '⏸️ No'}\n`;
      message += `Created: ${new Date(accountData.created_at).toLocaleString()}\n\n`;
      message += `Active Groups: ${groups.rows[0].count}\n`;
      message += `Log Entries: ${logs.rows[0].count}`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /groups command
  bot.onText(/\/groups/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const groups = await db.query(
        'SELECT account_id, COUNT(*) as count FROM groups WHERE is_active = TRUE GROUP BY account_id ORDER BY count DESC LIMIT 20'
      );

      if (groups.rows.length === 0) {
        await bot.sendMessage(msg.chat.id, '👥 No active groups found');
        return;
      }

      let message = `👥 <b>Groups by Account</b> (Top 20)\n\n`;
      groups.rows.forEach((group, i) => {
        message += `${i + 1}. Account <code>${group.account_id}</code>: ${group.count} groups\n`;
      });

      const totalGroups = await db.query('SELECT COUNT(*) as count FROM groups WHERE is_active = TRUE');
      message += `\n📊 Total Active Groups: ${totalGroups.rows[0].count}`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /database command
  bot.onText(/\/database/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      // SECURITY: Whitelist of allowed table names to prevent SQL injection
      const allowedTables = ['users', 'accounts', 'groups', 'messages', 'logs', 'audit_logs'];
      const stats = {};

      for (const table of allowedTables) {
        try {
          // SECURITY: Validate table name against whitelist
          // Only allow alphanumeric and underscore characters
          if (!/^[a-zA-Z0-9_]+$/.test(table) || !allowedTables.includes(table)) {
            stats[table] = 'Invalid';
            continue;
          }
          
          // Use parameterized query (though table names can't be parameterized in PostgreSQL)
          // We rely on whitelist validation above
          const result = await db.query(`SELECT COUNT(*) as count FROM ${table}`);
          stats[table] = result.rows[0].count;
        } catch (error) {
          stats[table] = 'Error';
        }
      }

      let message = `🗄️ <b>Database Statistics</b>\n\n`;
      for (const [table, count] of Object.entries(stats)) {
        message += `<b>${table}:</b> ${count}\n`;
      }

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /status command
  bot.onText(/\/status/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const activeBroadcasts = automationService.activeBroadcasts?.size || 0;
      const memoryUsage = process.memoryUsage();
      const uptime = process.uptime();
      
      const days = Math.floor(uptime / 86400);
      const hours = Math.floor((uptime % 86400) / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = Math.floor(uptime % 60);
      
      // Test database connection
      let dbStatus = '✅ Connected';
      try {
        await db.query('SELECT 1');
      } catch (error) {
        dbStatus = `❌ Error: ${error.message.substring(0, 50)}`;
      }

      const statusMessage = `🖥️ <b>Bot Status</b>\n\n` +
        `<b>System:</b>\n` +
        `Uptime: ${days}d ${hours}h ${minutes}m ${seconds}s\n` +
        `Memory: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB\n` +
        `Node.js: ${process.version}\n\n` +
        `<b>Bot:</b>\n` +
        `Active Broadcasts: ${activeBroadcasts}\n` +
        `Database: ${dbStatus}\n` +
        `Main Bot: ${mainBot ? '✅ Connected' : '❌ Not Available'}\n` +
        `Admin Bot: ✅ Running`;

      await bot.sendMessage(msg.chat.id, statusMessage, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /uptime command
  bot.onText(/\/uptime/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const uptime = process.uptime();
      const startTime = new Date(Date.now() - uptime * 1000);
      
      const days = Math.floor(uptime / 86400);
      const hours = Math.floor((uptime % 86400) / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = Math.floor(uptime % 60);

      const uptimeMessage = `⏱️ <b>Uptime Information</b>\n\n` +
        `Started: ${startTime.toLocaleString()}\n` +
        `Uptime: ${days} days, ${hours} hours, ${minutes} minutes, ${seconds} seconds\n` +
        `Total Seconds: ${Math.floor(uptime)}`;

      await bot.sendMessage(msg.chat.id, uptimeMessage, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /logs_error command
  bot.onText(/\/logs_error/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const errors = await db.query(
        "SELECT * FROM logs WHERE status = 'error' ORDER BY timestamp DESC LIMIT 20"
      );

      if (errors.rows.length === 0) {
        await bot.sendMessage(msg.chat.id, '✅ No error logs found');
        return;
      }

      let message = `❌ <b>Error Logs</b> (Last 20)\n\n`;
      errors.rows.forEach((log, i) => {
        const time = new Date(log.timestamp).toLocaleString();
        message += `${i + 1}. <b>${time}</b>\n`;
        message += `Account: ${log.account_id || 'N/A'}\n`;
        message += `<code>${log.message.substring(0, 100)}${log.message.length > 100 ? '...' : ''}</code>\n\n`;
      });

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /logs_success command
  bot.onText(/\/logs_success/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const logs = await db.query(
        "SELECT * FROM logs WHERE status = 'success' ORDER BY timestamp DESC LIMIT 20"
      );

      if (logs.rows.length === 0) {
        await bot.sendMessage(msg.chat.id, '✅ No success logs found');
        return;
      }

      let message = `✅ <b>Success Logs</b> (Last 20)\n\n`;
      logs.rows.forEach((log, i) => {
        const time = new Date(log.timestamp).toLocaleString();
        message += `${i + 1}. <b>${time}</b>\n`;
        message += `Account: ${log.account_id || 'N/A'}\n`;
        message += `${log.message.substring(0, 80)}${log.message.length > 80 ? '...' : ''}\n\n`;
      });

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /notify command
  bot.onText(/\/notify (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const notification = match[1];
      await adminNotifier.notify(`📢 <b>Admin Notification</b>\n\n${notification}`, { parseMode: 'HTML' });
      await bot.sendMessage(msg.chat.id, '✅ Notification sent to all admins');
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /abroadcast command - Broadcast message to all users
  bot.onText(/\/abroadcast(?:\s+(.+))?/, async (msg, match) => {
    console.log(`[ADMIN_BROADCAST] Command received from user ${msg.from.id}`);
    console.log(`[ADMIN_BROADCAST] Message text: ${msg.text}`);
    console.log(`[ADMIN_BROADCAST] Match result:`, match);
    
    try {
      if (!isAdmin(msg.from.id)) {
        console.log(`[ADMIN_BROADCAST] Unauthorized access attempt from user ${msg.from.id}`);
        await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
        return;
      }

      if (!mainBot) {
        console.log('[ADMIN_BROADCAST] Main bot not available');
        await bot.sendMessage(msg.chat.id, '❌ Main bot not available');
        return;
      }

      // Check if message was provided
      if (!match[1] || !match[1].trim()) {
        await bot.sendMessage(
          msg.chat.id,
          '❌ Please provide a message to broadcast.\n\nUsage: <code>/abroadcast Your message here</code>',
          { parse_mode: 'HTML' }
        );
        return;
      }
      const broadcastMessage = match[1].trim();
      lastAdminBroadcast = broadcastMessage; // Store for /abroadcast_last
      
      // Send status message
      const statusMsg = await bot.sendMessage(
        msg.chat.id,
        '📢 Starting admin broadcast...\n\n⏳ Please wait, this may take a while.',
        { parse_mode: 'HTML' }
      );

      // Get all users who have used /start at least once
      // All users in the users table have used /start (added via handleStart -> userService.addUser)
      const users = await db.query('SELECT DISTINCT user_id FROM users ORDER BY user_id');
      // Convert user_id to number (PostgreSQL BIGINT might be returned as string or BigInt)
      const userIds = users.rows.map(row => {
        const uid = row.user_id;
        // Handle BigInt, string, or number
        if (typeof uid === 'bigint') {
          return Number(uid);
        } else if (typeof uid === 'string') {
          return parseInt(uid, 10);
        }
        return uid;
      }).filter(uid => uid && !isNaN(uid)); // Filter out any invalid IDs
      
      if (userIds.length === 0) {
        await bot.editMessageText('❌ No users found. No one has used /start yet.', {
          chat_id: msg.chat.id,
          message_id: statusMsg.message_id,
        });
        return;
      }

      console.log(`[ADMIN_BROADCAST] Starting broadcast to ${userIds.length} users (all users who have used /start)`);
      let successCount = 0;
      let failedCount = 0;
      const failedUsers = [];

      // CRITICAL: Rate limiting for admin broadcasts
      // Telegram allows ~30 messages/second, but we use ULTRA-CONSERVATIVE limits to prevent bot deletion
      // Reduced to 10 messages/minute (1 per 6 seconds) to stay well below limits and avoid spam detection
      const MIN_DELAY_BETWEEN_MESSAGES = 6000; // 6 seconds between messages (10 messages/minute max) - INCREASED for safety
      const MAX_MESSAGES_PER_MINUTE = 10; // Ultra-conservative limit (reduced from 20)
      
      // Track messages sent in the last minute
      const messageTimestamps = [];

      // Send message to each user with proper rate limiting
      for (const userId of userIds) {
        try {
          // Update current time on each iteration
          const now = Date.now();
          const oneMinuteAgo = now - 60000;
          
          // Clean up old timestamps (older than 1 minute) to prevent memory leak
          const validTimestamps = messageTimestamps.filter(ts => ts > oneMinuteAgo);
          messageTimestamps.splice(0, messageTimestamps.length, ...validTimestamps);
          
          // Check rate limit: don't exceed MAX_MESSAGES_PER_MINUTE
          if (messageTimestamps.length >= MAX_MESSAGES_PER_MINUTE) {
            // Calculate wait time until oldest message is 1 minute old
            const oldestMessage = Math.min(...messageTimestamps);
            const waitTime = 60000 - (now - oldestMessage) + 1000; // Add 1 second buffer
            console.log(`[ADMIN_BROADCAST] Rate limit reached (${messageTimestamps.length}/${MAX_MESSAGES_PER_MINUTE} messages in last minute). Waiting ${(waitTime / 1000).toFixed(1)}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            // Clean up timestamps after waiting
            const newNow = Date.now();
            const newOneMinuteAgo = newNow - 60000;
            messageTimestamps.splice(0, messageTimestamps.length, ...messageTimestamps.filter(ts => ts > newOneMinuteAgo));
          }

          // Use safeBotApiCall to properly handle flood waits
          const sendResult = await safeBotApiCall(
            () => mainBot.sendMessage(userId, broadcastMessage, { parse_mode: 'HTML' }),
            { maxRetries: 3, bufferSeconds: 2, throwOnFailure: false }
          );

          if (sendResult) {
            successCount++;
            messageTimestamps.push(Date.now());
            logger.logChange('ADMIN_BROADCAST', msg.from.id, `Sent broadcast to user ${userId}`);
          } else {
            failedCount++;
            failedUsers.push(userId);
            console.log(`[ADMIN_BROADCAST] Failed to send to user ${userId} after retries`);
            logger.logError('ADMIN_BROADCAST', userId, new Error('Failed after retries'), `Failed to send broadcast to user ${userId}`);
          }
        } catch (error) {
          failedCount++;
          failedUsers.push(userId);
          console.log(`[ADMIN_BROADCAST] Failed to send to user ${userId}: ${error.message}`);
          logger.logError('ADMIN_BROADCAST', userId, error, `Failed to send broadcast to user ${userId}`);
        }

        // CRITICAL: Wait at least MIN_DELAY_BETWEEN_MESSAGES between messages to avoid rate limits
        // This ensures we never exceed Telegram's rate limits
        await new Promise(resolve => setTimeout(resolve, MIN_DELAY_BETWEEN_MESSAGES));
      }

      // Update status message with results
      const resultMessage = `✅ <b>Admin Broadcast Completed</b>\n\n` +
        `📊 Statistics:\n` +
        `• Total Users: ${userIds.length}\n` +
        `• ✅ Success: ${successCount}\n` +
        `• ❌ Failed: ${failedCount}\n` +
        `• Success Rate: ${((successCount / userIds.length) * 100).toFixed(1)}%\n\n` +
        `${failedCount > 0 ? `⚠️ Some users may have blocked the bot or had errors.` : `🎉 All messages sent successfully!`}`;

      await bot.editMessageText(resultMessage, {
        chat_id: msg.chat.id,
        message_id: statusMsg.message_id,
        parse_mode: 'HTML',
      });

      logger.logChange('ADMIN_BROADCAST', msg.from.id, `Admin broadcast completed. Success: ${successCount}, Failed: ${failedCount}`);
    } catch (error) {
      console.error('[ADMIN_BROADCAST] Error:', error);
      logger.logError('ADMIN_BROADCAST', msg.from.id, error, 'Admin broadcast error');
      try {
        // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
      } catch (sendError) {
        console.error('[ADMIN_BROADCAST] Failed to send error message:', sendError);
      }
    }
  });

  // /abroadcast_last command - Resend last broadcast message
  bot.onText(/\/abroadcast_last/, async (msg) => {
    console.log(`[ADMIN_BROADCAST] /abroadcast_last command received from user ${msg.from.id}`);
    
    if (!isAdmin(msg.from.id)) {
      console.log(`[ADMIN_BROADCAST] Unauthorized access attempt from user ${msg.from.id}`);
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    if (!mainBot) {
      console.log('[ADMIN_BROADCAST] Main bot not available');
      await bot.sendMessage(msg.chat.id, '❌ Main bot not available');
      return;
    }

    if (!lastAdminBroadcast) {
      await bot.sendMessage(msg.chat.id, '❌ No previous broadcast found. Use /abroadcast <message> first.');
      return;
    }

    try {
      // Send status message
      const statusMsg = await bot.sendMessage(
        msg.chat.id,
        '📢 Resending last admin broadcast...\n\n⏳ Please wait, this may take a while.',
        { parse_mode: 'HTML' }
      );

      // Get all users who have used /start at least once
      // All users in the users table have used /start (added via handleStart -> userService.addUser)
      const users = await db.query('SELECT DISTINCT user_id FROM users ORDER BY user_id');
      // Convert user_id to number (PostgreSQL BIGINT might be returned as string or BigInt)
      const userIds = users.rows.map(row => {
        const uid = row.user_id;
        // Handle BigInt, string, or number
        if (typeof uid === 'bigint') {
          return Number(uid);
        } else if (typeof uid === 'string') {
          return parseInt(uid, 10);
        }
        return uid;
      }).filter(uid => uid && !isNaN(uid)); // Filter out any invalid IDs
      
      if (userIds.length === 0) {
        await bot.editMessageText('❌ No users found. No one has used /start yet.', {
          chat_id: msg.chat.id,
          message_id: statusMsg.message_id,
        });
        return;
      }

      console.log(`[ADMIN_BROADCAST] Resending last broadcast to ${userIds.length} users (all users who have used /start)`);
      let successCount = 0;
      let failedCount = 0;

      // CRITICAL: Rate limiting for admin broadcasts
      // Telegram allows ~30 messages/second, but we use ULTRA-CONSERVATIVE limits to prevent bot deletion
      // Reduced to 10 messages/minute (1 per 6 seconds) to stay well below limits and avoid spam detection
      const MIN_DELAY_BETWEEN_MESSAGES = 6000; // 6 seconds between messages (10 messages/minute max) - INCREASED for safety
      const MAX_MESSAGES_PER_MINUTE = 10; // Ultra-conservative limit (reduced from 20)
      
      // Track messages sent in the last minute
      const messageTimestamps = [];

      // Send message to each user with proper rate limiting
      for (const userId of userIds) {
        try {
          // Update current time on each iteration
          const now = Date.now();
          const oneMinuteAgo = now - 60000;
          
          // Clean up old timestamps (older than 1 minute) to prevent memory leak
          const validTimestamps = messageTimestamps.filter(ts => ts > oneMinuteAgo);
          messageTimestamps.splice(0, messageTimestamps.length, ...validTimestamps);
          
          // Check rate limit: don't exceed MAX_MESSAGES_PER_MINUTE
          if (messageTimestamps.length >= MAX_MESSAGES_PER_MINUTE) {
            // Calculate wait time until oldest message is 1 minute old
            const oldestMessage = Math.min(...messageTimestamps);
            const waitTime = 60000 - (now - oldestMessage) + 1000; // Add 1 second buffer
            console.log(`[ADMIN_BROADCAST] Rate limit reached (${messageTimestamps.length}/${MAX_MESSAGES_PER_MINUTE} messages in last minute). Waiting ${(waitTime / 1000).toFixed(1)}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            // Clean up timestamps after waiting
            const newNow = Date.now();
            const newOneMinuteAgo = newNow - 60000;
            messageTimestamps.splice(0, messageTimestamps.length, ...messageTimestamps.filter(ts => ts > newOneMinuteAgo));
          }

          // Use safeBotApiCall to properly handle flood waits
          const sendResult = await safeBotApiCall(
            () => mainBot.sendMessage(userId, lastAdminBroadcast, { parse_mode: 'HTML' }),
            { maxRetries: 3, bufferSeconds: 2, throwOnFailure: false }
          );

          if (sendResult) {
            successCount++;
            messageTimestamps.push(Date.now());
            logger.logChange('ADMIN_BROADCAST', msg.from.id, `Resent broadcast to user ${userId}`);
          } else {
            failedCount++;
            console.log(`[ADMIN_BROADCAST] Failed to resend to user ${userId} after retries`);
            logger.logError('ADMIN_BROADCAST', userId, new Error('Failed after retries'), `Failed to resend broadcast to user ${userId}`);
          }
        } catch (error) {
          failedCount++;
          console.log(`[ADMIN_BROADCAST] Failed to resend to user ${userId}: ${error.message}`);
          logger.logError('ADMIN_BROADCAST', userId, error, `Failed to resend broadcast to user ${userId}`);
        }

        // CRITICAL: Wait at least MIN_DELAY_BETWEEN_MESSAGES between messages to avoid rate limits
        // This ensures we never exceed Telegram's rate limits
        await new Promise(resolve => setTimeout(resolve, MIN_DELAY_BETWEEN_MESSAGES));
      }

      // Update status message with results
      const resultMessage = `✅ <b>Last Broadcast Resent</b>\n\n` +
        `📊 Statistics:\n` +
        `• Total Users: ${userIds.length}\n` +
        `• ✅ Success: ${successCount}\n` +
        `• ❌ Failed: ${failedCount}\n` +
        `• Success Rate: ${((successCount / userIds.length) * 100).toFixed(1)}%\n\n` +
        `${failedCount > 0 ? `⚠️ Some users may have blocked the bot or had errors.` : `🎉 All messages sent successfully!`}`;

      await bot.editMessageText(resultMessage, {
        chat_id: msg.chat.id,
        message_id: statusMsg.message_id,
        parse_mode: 'HTML',
      });

      logger.logChange('ADMIN_BROADCAST', msg.from.id, `Last broadcast resent. Success: ${successCount}, Failed: ${failedCount}`);
    } catch (error) {
      logger.logError('ADMIN_BROADCAST', msg.from.id, error, 'Resend last broadcast error');
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /help command - Make sure it's registered early and works
  bot.onText(/\/help/, async (msg) => {
    try {
      if (!msg || !msg.from || !msg.chat) {
        console.error('[ADMIN BOT] Invalid message object in /help');
        return;
      }

      if (!isAdmin(msg.from.id)) {
        await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
        return;
      }

      const helpMessage = `👑 <b>Admin Bot Commands</b>\n\n` +
        `<b>📊 Statistics & Information:</b>\n` +
        `/stats - View bot statistics (users, accounts, broadcasts, groups, messages)\n` +
        `/users - List recent users (last 20)\n` +
        `/accounts - List recent accounts (last 20)\n` +
        `/broadcasts - View active broadcasts\n` +
        `/groups - List groups by account (top 20)\n` +
        `/database - Database statistics (all tables)\n\n` +
        `<b>👁️ Monitoring & Logs:</b>\n` +
        `/logs - View recent logs (last 10)\n` +
        `/logs_error - View error logs only (last 20)\n` +
        `/logs_success - View success logs only (last 20)\n` +
        `/errors - View recent errors (last 10)\n` +
        `/user &lt;id&gt; - Get detailed user information\n` +
        `/account &lt;id&gt; - Get detailed account information\n\n` +
        `<b>⭐ Premium Management:</b>\n` +
        `/premium_stats - Premium subscription statistics\n` +
        `/premium_list - List active premium subscriptions (last 15)\n` +
        `/premium_all - List all premium subscriptions (all statuses, last 20)\n` +
        `/premium_expiring - List subscriptions expiring in next 7 days\n` +
        `/premium_user &lt;id&gt; - Get user premium status and details\n` +
        `/premium_add &lt;id&gt; - Add premium subscription (30 days default)\n` +
        `/premium_set_date &lt;id&gt; &lt;YYYY-MM-DD&gt; - Manually set expiry date\n` +
        `/premium_extend &lt;id&gt; &lt;days&gt; - Extend premium by number of days\n` +
        `/premium_remove &lt;id&gt; - Remove/cancel premium subscription\n` +
        `/premium_update &lt;id&gt; &lt;amount&gt; - Update subscription amount\n\n` +
        `<b>🎮 Broadcast Control:</b>\n` +
        `/stop_broadcast &lt;user_id&gt; - Stop specific user's broadcast\n` +
        `/stop_all_broadcasts - Stop all active broadcasts\n` +
        `/abroadcast &lt;message&gt; - Broadcast message to all users\n` +
        `/abroadcast_last - Resend last broadcast message\n\n` +
        `<b>📢 Notifications:</b>\n` +
        `/notify &lt;message&gt; - Send notification to all admins\n\n` +
        `<b>⚙️ System & Status:</b>\n` +
        `/status - Bot health status (uptime, memory, database, broadcasts)\n` +
        `/uptime - Detailed uptime information\n` +
        `/test - Test admin bot connection\n\n` +
        `<b>❓ Help & Navigation:</b>\n` +
        `/help - Show this detailed help message\n` +
        `/start - Show welcome message with quick command overview`;

      await bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('[ADMIN BOT] Error in /help command:', error);
      try {
        // SECURITY: Sanitize error message
        const safeErrorMessage = sanitizeErrorMessage(error, false);
        await bot.sendMessage(msg.chat.id, `❌ Error showing help: ${safeErrorMessage}`);
      } catch (sendError) {
        console.error('[ADMIN BOT] Failed to send error message:', sendError);
      }
    }
  });

  // Test command to verify bot is working
  bot.on('message', async (msg) => {
    // Log all messages for debugging
    if (msg.text && msg.text.startsWith('/')) {
      console.log(`[ADMIN BOT] Received command "${msg.text}" from user ${msg.from.id} (${msg.from.username || 'no username'})`);
    }
  });

  // Add a simple test command
  bot.onText(/\/test/, async (msg) => {
    console.log(`[ADMIN BOT] /test command received from ${msg.from.id}`);
    try {
      await bot.sendMessage(msg.chat.id, `✅ Admin bot is working! Your ID: ${msg.from.id}\nIs Admin: ${isAdmin(msg.from.id)}`);
    } catch (error) {
      console.error('[ADMIN BOT] Error in /test:', error);
    }
  });

  // Premium subscription commands
  bot.onText(/\/premium_stats/, async (msg) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const stats = await premiumService.getStatistics();
      const message = `╔═══════════════════════════╗
║  ⭐ <b>PREMIUM STATISTICS</b>   ║
╚═══════════════════════════╝

┌───────────────────────────┐
│  📊 <b>Subscription Status</b>  │
└───────────────────────────┘

✅ <b>Active:</b> <code>${stats.active}</code>
❌ <b>Expired:</b> <code>${stats.expired}</code>
🚫 <b>Cancelled:</b> <code>${stats.cancelled}</code>

┌───────────────────────────┐
│  💰 <b>Revenue</b>            │
└───────────────────────────┘

<b>Total Revenue:</b> ₹${stats.totalRevenue.toFixed(2)}
<b>Average per Active:</b> ₹${stats.active > 0 ? (stats.totalRevenue / stats.active).toFixed(2) : '0.00'}`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/premium_list/, async (msg) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const subscriptions = await premiumService.getAllActiveSubscriptions();
      
      if (subscriptions.length === 0) {
        await bot.sendMessage(msg.chat.id, '📭 No active premium subscriptions found.');
        return;
      }

      let message = `╔═══════════════════════════╗
║  ⭐ <b>ACTIVE PREMIUM</b>      ║
║  <b>(${subscriptions.length} subscriptions)</b>  ║
╚═══════════════════════════╝\n\n`;
      
      subscriptions.slice(0, 15).forEach((sub, index) => {
        const expiresAt = new Date(sub.expires_at);
        const daysRemaining = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
        const statusEmoji = daysRemaining <= 7 ? '⚠️' : daysRemaining <= 15 ? '🟡' : '🟢';
        
        message += `┌─ <b>#${index + 1}</b> ───────────────────┐\n`;
        message += `│ ${statusEmoji} <b>${sub.first_name || 'N/A'}</b>\n`;
        message += `│ 👤 @${sub.username || 'no_username'}\n`;
        message += `│ 🆔 <code>${sub.user_id}</code>\n`;
        message += `│ 📅 Expires: ${expiresAt.toLocaleDateString('en-IN')}\n`;
        message += `│ ⏰ ${daysRemaining} days remaining\n`;
        message += `│ 💰 ₹${sub.amount}\n`;
        message += `└────────────────────────────┘\n\n`;
      });

      if (subscriptions.length > 15) {
        message += `\n<i>... and ${subscriptions.length - 15} more subscriptions</i>`;
      }

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/premium_expiring/, async (msg) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const subscriptions = await premiumService.getExpiringSubscriptions();
      
      if (subscriptions.length === 0) {
        await bot.sendMessage(msg.chat.id, '✅ No subscriptions expiring in the next 7 days.');
        return;
      }

      let message = `╔═══════════════════════════╗
║  ⚠️ <b>EXPIRING SOON</b>       ║
║  <b>(${subscriptions.length} subscriptions)</b>  ║
╚═══════════════════════════╝\n\n`;
      
      subscriptions.forEach((sub, index) => {
        const expiresAt = new Date(sub.expires_at);
        const daysRemaining = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
        const urgencyEmoji = daysRemaining <= 1 ? '🔴' : daysRemaining <= 3 ? '🟠' : '🟡';
        
        message += `┌─ <b>#${index + 1}</b> ───────────────────┐\n`;
        message += `│ ${urgencyEmoji} <b>${sub.first_name || 'N/A'}</b>\n`;
        message += `│ 👤 @${sub.username || 'no_username'}\n`;
        message += `│ 🆔 <code>${sub.user_id}</code>\n`;
        message += `│ 📅 ${expiresAt.toLocaleDateString('en-IN')}\n`;
        message += `│ ⏰ <b>${daysRemaining} days left</b>\n`;
        message += `└────────────────────────────┘\n\n`;
      });

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/premium_user (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const targetUserId = validateUserId(match[1]);
      if (!targetUserId) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid user ID format');
        return;
      }

      const subscription = await premiumService.getSubscription(targetUserId);
      const isPremium = await premiumService.isPremium(targetUserId);

      let message = `╔═══════════════════════════╗
║  👤 <b>USER PREMIUM STATUS</b>  ║
║  <b>ID: ${targetUserId}</b>        ║
╚═══════════════════════════╝\n\n`;
      
      if (isPremium && subscription) {
        const expiresAt = new Date(subscription.expires_at);
        const daysRemaining = subscription.daysRemaining || 0;
        const expiresAtFormatted = expiresAt.toLocaleDateString('en-IN', { 
          day: 'numeric', 
          month: 'long', 
          year: 'numeric' 
        });
        
        message += `┌───────────────────────────┐\n`;
        message += `│  ✅ <b>ACTIVE PREMIUM</b>     │\n`;
        message += `└───────────────────────────┘\n\n`;
        message += `📅 <b>Expires:</b> ${expiresAtFormatted}\n`;
        message += `⏰ <b>Days Remaining:</b> <code>${daysRemaining}</code>\n`;
        message += `💰 <b>Amount:</b> ₹${subscription.amount}\n`;
        message += `💳 <b>Payment:</b> ${subscription.payment_method || 'N/A'}\n`;
        if (subscription.payment_reference) {
          message += `📝 <b>Reference:</b> <code>${subscription.payment_reference}</code>\n`;
        }
      } else {
        message += `┌───────────────────────────┐\n`;
        message += `│  ❌ <b>NOT PREMIUM</b>        │\n`;
        message += `└───────────────────────────┘\n\n`;
        if (subscription) {
          message += `📅 <b>Last Status:</b> ${subscription.status}\n`;
          if (subscription.expires_at) {
            const expiresAt = new Date(subscription.expires_at);
            message += `📅 <b>Expired:</b> ${expiresAt.toLocaleDateString('en-IN')}\n`;
          }
        } else {
          message += `No subscription history found.\n`;
        }
      }

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/premium_add (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const targetUserId = validateUserId(match[1]);
      if (!targetUserId) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid user ID format');
        return;
      }

      const result = await premiumService.createSubscription(targetUserId, {
        amount: 30.0,
        currency: 'INR',
        paymentMethod: 'admin_manual',
        paymentReference: `Admin: ${adminUserId}`
      });

      if (result.success) {
        const expiresAt = new Date(result.subscription.expires_at);
        const expiresAtFormatted = expiresAt.toLocaleDateString('en-IN', { 
          day: 'numeric', 
          month: 'long', 
          year: 'numeric' 
        });
        
        const message = `╔═══════════════════════════╗
║  ✅ <b>PREMIUM ADDED</b>        ║
╚═══════════════════════════╝

👤 <b>User ID:</b> <code>${targetUserId}</code>
📅 <b>Expires:</b> ${expiresAtFormatted}
💰 <b>Amount:</b> ₹${result.subscription.amount}

<i>Premium subscription activated successfully!</i>`;
        
        await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
      } else {
        await bot.sendMessage(
          msg.chat.id, 
          `❌ <b>Failed to Add Premium</b>\n\n<code>${result.error}</code>`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /premium_set_date <user_id> <date> - Manually set expiry date (YYYY-MM-DD format)
  bot.onText(/\/premium_set_date (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const parts = match[1].trim().split(/\s+/);
      if (parts.length < 2) {
        await bot.sendMessage(
          msg.chat.id,
          '❌ <b>Invalid Format</b>\n\nUsage: <code>/premium_set_date &lt;user_id&gt; &lt;YYYY-MM-DD&gt;</code>\n\nExample: <code>/premium_set_date 123456789 2024-12-31</code>',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const targetUserId = validateUserId(parts[0]);
      if (!targetUserId) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid user ID format');
        return;
      }

      const dateStr = parts[1];
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(dateStr)) {
        await bot.sendMessage(
          msg.chat.id,
          '❌ <b>Invalid Date Format</b>\n\nPlease use YYYY-MM-DD format.\n\nExample: <code>2024-12-31</code>',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const result = await premiumService.setExpiryDate(targetUserId, dateStr);

      if (result.success) {
        const expiresAt = new Date(result.subscription.expires_at);
        const expiresAtFormatted = expiresAt.toLocaleDateString('en-IN', { 
          day: 'numeric', 
          month: 'long', 
          year: 'numeric' 
        });
        
        const message = `╔═══════════════════════════╗
║  ✅ <b>EXPIRY DATE SET</b>     ║
╚═══════════════════════════╝

👤 <b>User ID:</b> <code>${targetUserId}</code>
📅 <b>New Expiry:</b> ${expiresAtFormatted}
⏰ <b>Days Remaining:</b> ${result.subscription.daysRemaining || 0}

<i>Premium subscription expiry date updated!</i>`;
        
        await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
        logger.logChange('ADMIN_PREMIUM', adminUserId, `Set expiry date for user ${targetUserId} to ${dateStr}`);
      } else {
        await bot.sendMessage(
          msg.chat.id, 
          `❌ <b>Failed to Set Date</b>\n\n<code>${result.error}</code>`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /premium_extend <user_id> <days> - Extend premium by X days
  bot.onText(/\/premium_extend (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const parts = match[1].trim().split(/\s+/);
      if (parts.length < 2) {
        await bot.sendMessage(
          msg.chat.id,
          '❌ <b>Invalid Format</b>\n\nUsage: <code>/premium_extend &lt;user_id&gt; &lt;days&gt;</code>\n\nExample: <code>/premium_extend 123456789 30</code>',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const targetUserId = validateUserId(parts[0]);
      if (!targetUserId) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid user ID format');
        return;
      }

      const days = parseInt(parts[1], 10);
      if (isNaN(days) || days <= 0) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid number of days. Must be a positive integer.');
        return;
      }

      const result = await premiumService.extendSubscription(targetUserId, days);

      if (result.success) {
        const expiresAt = new Date(result.subscription.expires_at);
        const expiresAtFormatted = expiresAt.toLocaleDateString('en-IN', { 
          day: 'numeric', 
          month: 'long', 
          year: 'numeric' 
        });
        
        const message = `╔═══════════════════════════╗
║  ✅ <b>PREMIUM EXTENDED</b>    ║
╚═══════════════════════════╝

👤 <b>User ID:</b> <code>${targetUserId}</code>
📅 <b>New Expiry:</b> ${expiresAtFormatted}
⏰ <b>Days Added:</b> ${days}
📊 <b>Days Remaining:</b> ${result.subscription.daysRemaining || 0}

<i>Premium subscription extended successfully!</i>`;
        
        await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
        logger.logChange('ADMIN_PREMIUM', adminUserId, `Extended premium for user ${targetUserId} by ${days} days`);
      } else {
        await bot.sendMessage(
          msg.chat.id, 
          `❌ <b>Failed to Extend Premium</b>\n\n<code>${result.error}</code>`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /premium_remove <user_id> - Remove/cancel premium subscription
  bot.onText(/\/premium_remove (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const targetUserId = validateUserId(match[1]);
      if (!targetUserId) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid user ID format');
        return;
      }

      const result = await premiumService.removePremium(targetUserId);

      if (result.success) {
        const message = `╔═══════════════════════════╗
║  ✅ <b>PREMIUM REMOVED</b>     ║
╚═══════════════════════════╝

👤 <b>User ID:</b> <code>${targetUserId}</code>

<i>Premium subscription has been cancelled.</i>`;
        
        await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
        logger.logChange('ADMIN_PREMIUM', adminUserId, `Removed premium for user ${targetUserId}`);
      } else {
        await bot.sendMessage(
          msg.chat.id, 
          `❌ <b>Failed to Remove Premium</b>\n\n<code>${result.error}</code>`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /premium_update <user_id> <amount> - Update subscription amount
  bot.onText(/\/premium_update (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const parts = match[1].trim().split(/\s+/);
      if (parts.length < 2) {
        await bot.sendMessage(
          msg.chat.id,
          '❌ <b>Invalid Format</b>\n\nUsage: <code>/premium_update &lt;user_id&gt; &lt;amount&gt;</code>\n\nExample: <code>/premium_update 123456789 50</code>',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const targetUserId = validateUserId(parts[0]);
      if (!targetUserId) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid user ID format');
        return;
      }

      const amount = parseFloat(parts[1]);
      if (isNaN(amount) || amount < 0) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid amount. Must be a positive number.');
        return;
      }

      const result = await premiumService.updateAmount(targetUserId, amount);

      if (result.success) {
        const message = `╔═══════════════════════════╗
║  ✅ <b>AMOUNT UPDATED</b>      ║
╚═══════════════════════════╝

👤 <b>User ID:</b> <code>${targetUserId}</code>
💰 <b>New Amount:</b> ₹${amount}

<i>Premium subscription amount updated!</i>`;
        
        await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
        logger.logChange('ADMIN_PREMIUM', adminUserId, `Updated premium amount for user ${targetUserId} to ₹${amount}`);
      } else {
        await bot.sendMessage(
          msg.chat.id, 
          `❌ <b>Failed to Update Amount</b>\n\n<code>${result.error}</code>`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /premium_all - List all premium subscriptions (all statuses)
  bot.onText(/\/premium_all/, async (msg) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const subscriptions = await premiumService.getAllSubscriptions();
      
      if (subscriptions.length === 0) {
        await bot.sendMessage(msg.chat.id, '📭 No premium subscriptions found.');
        return;
      }

      let message = `╔═══════════════════════════╗
║  ⭐ <b>ALL PREMIUM</b>          ║
║  <b>(${subscriptions.length} subscriptions)</b>  ║
╚═══════════════════════════╝\n\n`;
      
      subscriptions.slice(0, 20).forEach((sub, index) => {
        const expiresAt = new Date(sub.expires_at);
        const now = new Date();
        const daysRemaining = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
        const statusEmoji = sub.status === 'active' ? '✅' : sub.status === 'expired' ? '❌' : '🚫';
        const statusText = sub.status === 'active' ? 'ACTIVE' : sub.status === 'expired' ? 'EXPIRED' : 'CANCELLED';
        
        message += `┌─ <b>#${index + 1}</b> ───────────────────┐\n`;
        message += `│ ${statusEmoji} <b>${sub.first_name || 'N/A'}</b> [${statusText}]\n`;
        message += `│ 👤 @${sub.username || 'no_username'}\n`;
        message += `│ 🆔 <code>${sub.user_id}</code>\n`;
        message += `│ 📅 ${expiresAt.toLocaleDateString('en-IN')}\n`;
        if (sub.status === 'active') {
          message += `│ ⏰ ${daysRemaining} days remaining\n`;
        }
        message += `│ 💰 ₹${sub.amount}\n`;
        message += `└────────────────────────────┘\n\n`;
      });

      if (subscriptions.length > 20) {
        message += `\n<i>... and ${subscriptions.length - 20} more subscriptions</i>`;
      }

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  console.log('[ADMIN BOT] Commands registered');
  console.log(`[ADMIN BOT] Admin IDs configured: ${config.adminIds?.length || 0} admins`);
  if (config.adminIds && config.adminIds.length > 0) {
    console.log(`[ADMIN BOT] Admin IDs: ${config.adminIds.join(', ')}`);
  }
}

/**
 * Check if user is admin
 */
function isAdmin(userId) {
  if (!config.adminIds || config.adminIds.length === 0) {
    return false;
  }
  return config.adminIds.includes(userId.toString()) || config.adminIds.includes(parseInt(userId));
}

/**
 * Get admin bot instance
 */
export function getAdminBot() {
  return adminBot;
}
