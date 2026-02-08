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
import groupService from '../services/groupService.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
          timeout: 60, // Increased from 10 to 60 seconds to prevent timeout errors
          allowed_updates: ['message', 'callback_query']
        }
      },
      request: {
        timeout: 120000, // Increased from 90s to 120 seconds timeout for requests to handle slow networks
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
      
      // Only log full error details if it's not a timeout (timeouts are logged separately below)
      if (!isTimeoutError) {
        console.error('[ADMIN BOT] Polling error:', error);
      }
      
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
        // Timeout errors are expected and handled automatically - log as warning, not error
        console.warn(`[ADMIN BOT] Polling timeout detected (attempt ${pollingRetryCount + 1}/${MAX_POLLING_RETRIES}) - will retry automatically`);
        // Don't log timeout errors to error log - they're expected network issues
        // logger.logError('ADMIN_BOT', null, error, 'Admin bot polling timeout - will retry');
      } else {
        // Only log non-timeout errors with full details
        console.error('[ADMIN BOT] Polling error:', error);
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
      
      // Handle timeout errors - these are often transient network issues
      if (isTimeoutError) {
        // Timeout errors are expected - log as warning, not error
        console.warn('[ADMIN BOT] Request timeout detected - this is usually a transient network issue');
        // Don't log timeout errors to error log - they're expected network issues
        // logger.logError('ADMIN_BOT', null, error, 'Admin bot request timeout - will retry');
      } else {
        // Only log non-timeout errors with full details
        console.error('[ADMIN BOT] Error:', error);
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
    // Check if chat is private
    if (msg.chat.type !== 'private') return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Check if user is admin
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, '❌ You are not authorized to use this bot.');
      return;
    }

    const welcomeMessage = `👑 <b>Admin Bot</b>\n\n` +
      `Welcome, Admin!\n\n` +
      `<b>📊 Statistics:</b>\n` +
      `/stats - View bot statistics\n` +
      `/users - List recent users\n` +
      `/accounts - List recent accounts\n` +
      `/broadcasts - View active broadcasts\n` +
      `/groups - List groups by account\n` +
      `/links - Collect all group links (as text file)\n` +
      `/database - Database statistics\n\n` +
      `<b>⭐ Premium Management:</b>\n` +
      `/premium_stats - Premium statistics\n` +
      `/premium_list - List active premium\n` +
      `/premium_expiring - Expiring subscriptions\n` +
      `/premium_user &lt;id&gt; - Check user premium\n` +
      `/premium_add &lt;id&gt; - Add premium\n` +
      `/premium_revoke &lt;id&gt; - Revoke premium\n` +
      `/premium_cancel &lt;id&gt; - Cancel premium\n` +
      `/payment_pending - Pending payments\n` +
      `/payment_verify &lt;id&gt; - Verify payment\n` +
      `/payment_reject &lt;id&gt; [reason] - Reject payment\n\n` +
      `<b>👁️ Monitoring:</b>\n` +
      `/logs - View recent logs\n` +
      `/logs_error - View error logs only\n` +
      `/logs_success - View success logs only\n` +
      `/errors - View recent errors\n` +
      `/user &lt;id&gt; - Get user details\n` +
      `/account &lt;id&gt; - Get account details\n\n` +
      `<b>🤖 Auto-Reply:</b>\n` +
      `/autoreply - Show auto-reply status\n` +
      `/autoreply_refresh - Restart auto-reply service\n` +
      `/autoreply_stats - Auto-reply statistics\n` +
      `/autoreply_logs - View auto-reply logs\n` +
      `/test_autoreply &lt;account_id&gt; - Test auto-reply\n\n` +
      `<b>🔧 Operations:</b>\n` +
      `/account_reconnect &lt;account_id&gt; - Reconnect account\n` +
      `/ban_user &lt;user_id&gt; - Ban a user\n` +
      `/unban_user &lt;user_id&gt; - Unban a user\n` +
      `/message_user &lt;user_id&gt; &lt;msg&gt; - Send message\n` +
      `/cleanup - Clean old data\n\n` +
      `<b>🎮 Control:</b>\n` +
      `/stop_broadcast &lt;user_id&gt; - Stop user's broadcast\n` +
      `/stop_all_broadcasts - Stop all broadcasts\n` +
      `/notify &lt;message&gt; - Send notification to admins\n` +
      `/abroadcast &lt;message&gt; - Broadcast to all users\n` +
      `/abroadcast_last - Resend last broadcast\n\n` +
      `<b>⚙️ System:</b>\n` +
      `/status - Bot health status\n` +
      `/health_check - Comprehensive health check\n` +
      `/uptime - Bot uptime information\n` +
      `/test - Test admin bot connection\n\n` +
      `<b>❓ Help:</b>\n` +
      `/help - Show detailed help\n` +
      `/start - Show this menu`;

    await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
  });

  // /stats command
  bot.onText(/\/stats/, async (msg) => {
    if (msg.chat.type !== 'private') return;
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
        `👥 Total Users: ${userCount.rows[0]?.count || 0}\n` +
        `🔑 Total Accounts: ${accountCount.rows[0]?.count || 0}\n` +
        `📢 Active Broadcasts: ${activeBroadcasts}\n` +
        `👥 Active Groups: ${groupCount.rows[0]?.count || 0}\n` +
        `📝 Total Messages: ${messageCount.rows[0]?.count || 0}`;

      await bot.sendMessage(msg.chat.id, statsMessage, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /users command
  bot.onText(/\/users/, async (msg) => {
    if (msg.chat.type !== 'private') return;
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
        const username = user.username ? `@${user.username}` : 'No username';
        message += `${i + 1}. <b>${user.first_name || 'Unknown'}</b> (${username})\n`;
        message += `   ID: <code>${user.user_id}</code>\n`;
        message += `   Verified: ${user.is_verified ? '✅' : '❌'}\n`;
        const joinedDate = new Date(user.joined_at);
        message += `   Joined: ${joinedDate.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n`;
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
    if (msg.chat.type !== 'private') return;
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const accounts = await db.query(
        'SELECT account_id, user_id, phone, is_active, is_broadcasting, created_at FROM accounts ORDER BY created_at DESC LIMIT 20'
      );

      let message = `🔑 <b>Recent Accounts</b> (Last 20)\n\n`;
      for (let i = 0; i < accounts.rows.length; i++) {
        const account = accounts.rows[i];
        // Get user info for display
        const userResult = await db.query('SELECT username, first_name FROM users WHERE user_id = $1', [account.user_id]);
        const userInfo = userResult.rows[0];
        const username = userInfo?.username ? `@${userInfo.username}` : 'N/A';
        const firstName = userInfo?.first_name || 'Unknown';
        
        message += `${i + 1}. <b>${account.phone}</b>\n`;
        message += `   Account ID: <code>${account.account_id}</code>\n`;
        message += `   User: <b>${firstName}</b> (${username})\n`;
        message += `   User ID: <code>${account.user_id}</code>\n`;
        message += `   Active: ${account.is_active ? '✅' : '❌'}\n`;
        message += `   Broadcasting: ${account.is_broadcasting ? '📢' : '⏸️'}\n`;
        const createdDate = new Date(account.created_at);
        message += `   Created: ${createdDate.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n`;
      }

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /broadcasts command
  bot.onText(/\/broadcasts/, async (msg) => {
    if (msg.chat.type !== 'private') return;
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
      for (let i = 0; i < activeBroadcasts.length; i++) {
        const [userId, broadcast] = activeBroadcasts[i];
        // Get user info for display
        const userResult = await db.query('SELECT username, first_name FROM users WHERE user_id = $1', [userId]);
        const userInfo = userResult.rows[0];
        const username = userInfo?.username ? `@${userInfo.username}` : 'N/A';
        const firstName = userInfo?.first_name || 'Unknown';
        
        message += `${i + 1}. <b>${firstName}</b> (${username})\n`;
        message += `   User ID: <code>${userId}</code>\n`;
        message += `   Account ID: <code>${broadcast.accountId}</code>\n`;
        message += `   Messages Sent: ${broadcast.messageCount || 0}\n`;
        message += `   Running: ${broadcast.isRunning ? '✅' : '❌'}\n\n`;
      }

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /logs command
  bot.onText(/\/logs/, async (msg) => {
    if (msg.chat.type !== 'private') return;
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
        const time = new Date(log.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
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
    if (msg.chat.type !== 'private') return;
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
        const time = new Date(error.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
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
    if (msg.chat.type !== 'private') return;
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

      const accounts = await db.query('SELECT * FROM accounts WHERE user_id = $1', [targetUserId]);
      const logs = await db.query('SELECT COUNT(*) as count FROM logs WHERE user_id = $1', [targetUserId]);

      const userData = user.rows[0];
      let message = `👤 <b>User Details</b>\n\n`;
      message += `ID: <code>${userData.user_id}</code>\n`;
      message += `Username: @${userData.username || 'N/A'}\n`;
      message += `Name: ${userData.first_name || 'N/A'}\n`;
      message += `Verified: ${userData.is_verified ? '✅' : '❌'}\n`;
      const joinedDate = new Date(userData.joined_at);
      message += `Joined: ${joinedDate.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n`;
      message += `Accounts: ${accounts.rows.length}\n`;
      message += `Log Entries: ${logs.rows[0]?.count || 0}`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /stop_broadcast <user_id> command
  bot.onText(/\/stop_broadcast (.+)/, async (msg, match) => {
    if (msg.chat.type !== 'private') return;
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const userId = parseInt(match[1]);
      
      // Get all broadcasting account IDs for this user
      const broadcastingAccountIds = automationService.getBroadcastingAccountIds(userId);
      
      if (broadcastingAccountIds.length === 0) {
        // Get user info for display
        const userResult = await db.query('SELECT username, first_name FROM users WHERE user_id = $1', [userId]);
        const userInfo = userResult.rows[0];
        const username = userInfo?.username ? `@${userInfo.username}` : 'N/A';
        const firstName = userInfo?.first_name || 'Unknown';
        await bot.sendMessage(msg.chat.id, `❌ No active broadcasts found for user <b>${firstName}</b> (${username}) - <code>${userId}</code>`, { parse_mode: 'HTML' });
        return;
      }
      
      // Get user info for display
      const userResult = await db.query('SELECT username, first_name FROM users WHERE user_id = $1', [userId]);
      const userInfo = userResult.rows[0];
      const username = userInfo?.username ? `@${userInfo.username}` : 'N/A';
      const firstName = userInfo?.first_name || 'Unknown';
      
      let stoppedCount = 0;
      for (const accountId of broadcastingAccountIds) {
        const result = await automationService.stopBroadcast(userId, accountId);
        if (result.success) {
          stoppedCount++;
        }
      }
      
      await bot.sendMessage(msg.chat.id, `✅ Stopped ${stoppedCount} broadcast(s) for user <b>${firstName}</b> (${username}) - <code>${userId}</code>`, { parse_mode: 'HTML' });
      logger.logChange('ADMIN', msg.from.id, `Stopped ${stoppedCount} broadcast(s) for user ${userId}`);
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /stop_all_broadcasts command
  bot.onText(/\/stop_all_broadcasts/, async (msg) => {
    if (msg.chat.type !== 'private') return;
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
    if (msg.chat.type !== 'private') return;
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
      
      // Get user info for display
      const userResult = await db.query('SELECT username, first_name FROM users WHERE user_id = $1', [accountData.user_id]);
      const userInfo = userResult.rows[0];
      const username = userInfo?.username ? `@${userInfo.username}` : 'N/A';
      const firstName = userInfo?.first_name || 'Unknown';
      
      const groups = await db.query('SELECT COUNT(*) as count FROM groups WHERE account_id = $1 AND is_active = TRUE', [accountId]);
      const logs = await db.query('SELECT COUNT(*) as count FROM logs WHERE account_id = $1', [accountId]);
      const isBroadcasting = automationService.isBroadcasting(accountData.user_id, accountId);

      let message = `🔑 <b>Account Details</b>\n\n`;
      message += `Account ID: <code>${accountData.account_id}</code>\n`;
      message += `User: <b>${firstName}</b> (${username})\n`;
      message += `User ID: <code>${accountData.user_id}</code>\n`;
      message += `Phone: ${accountData.phone || 'N/A'}\n`;
      message += `Active: ${accountData.is_active ? '✅' : '❌'}\n`;
      message += `Broadcasting: ${isBroadcasting ? '📢 Yes' : '⏸️ No'}\n`;
      const createdDate = new Date(accountData.created_at);
      message += `Created: ${createdDate.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n`;
      message += `Active Groups: ${groups.rows[0]?.count || 0}\n`;
      message += `Log Entries: ${logs.rows[0]?.count || 0}`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /groups command
  bot.onText(/\/groups/, async (msg) => {
    if (msg.chat.type !== 'private') return;
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
      message += `\n📊 Total Active Groups: ${totalGroups.rows[0]?.count || 0}`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      // SECURITY: Sanitize error message to prevent information leakage
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /database command
  bot.onText(/\/database/, async (msg) => {
    if (msg.chat.type !== 'private') return;
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
          stats[table] = result.rows[0]?.count || 0;
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
    if (msg.chat.type !== 'private') return;
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
    if (msg.chat.type !== 'private') return;
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
        `Started: ${startTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n` +
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
    if (msg.chat.type !== 'private') return;
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
        const time = new Date(log.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
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
    if (msg.chat.type !== 'private') return;
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
        const time = new Date(log.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
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
    if (msg.chat.type !== 'private') return;
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
    if (msg.chat.type !== 'private') return;
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
    if (msg.chat.type !== 'private') return;
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
        `<b>📊 Statistics:</b>\n` +
        `/stats - View bot statistics\n` +
        `/users - List recent users (last 20)\n` +
        `/accounts - List recent accounts (last 20)\n` +
        `/broadcasts - View active broadcasts\n` +
        `/groups - List all groups\n` +
        `/links - Collect all group links (as text file)\n` +
        `/database - Database statistics\n\n` +
        `<b>⭐ Premium Management:</b>\n` +
        `/premium_stats - Premium subscription statistics\n` +
        `/premium_list - List all active premium subscriptions\n` +
        `/premium_expiring - List subscriptions expiring soon\n` +
        `/premium_user &lt;user_id&gt; - Check user's premium status\n` +
        `/premium_add &lt;user_id&gt; - Add premium subscription\n` +
        `/premium_revoke &lt;user_id&gt; - Revoke premium subscription\n` +
        `/premium_cancel &lt;user_id&gt; - Cancel premium subscription\n` +
        `/payment_pending - View pending payment submissions\n` +
        `/payment_verify &lt;id&gt; - Verify payment submission\n` +
        `/payment_reject &lt;id&gt; [reason] - Reject payment submission\n\n` +
        `<b>👁️ Monitoring:</b>\n` +
        `/logs - View recent logs (last 10)\n` +
        `/logs_error - View error logs only\n` +
        `/logs_success - View success logs only\n` +
        `/errors - View recent errors (last 10)\n` +
        `/user &lt;id&gt; - Get user details\n` +
        `/account &lt;id&gt; - Get account details\n\n` +
        `<b>🤖 Auto-Reply:</b>\n` +
        `/autoreply - Show auto-reply status for all accounts\n` +
        `/autoreply_refresh - Restart auto-reply service\n` +
        `/autoreply_stats - Detailed auto-reply statistics\n` +
        `/autoreply_logs - View recent auto-reply activity\n` +
        `/test_autoreply &lt;account_id&gt; - Test auto-reply for account\n\n` +
        `<b>🔧 Account Operations:</b>\n` +
        `/account_reconnect &lt;account_id&gt; - Force reconnect stuck account\n` +
        `/ban_user &lt;user_id&gt; - Ban user from bot\n` +
        `/unban_user &lt;user_id&gt; - Unban user\n` +
        `/message_user &lt;user_id&gt; &lt;msg&gt; - Send direct message to user\n` +
        `/cleanup - Clean old logs and optimize database\n\n` +
        `<b>🎮 Control:</b>\n` +
        `/stop_broadcast &lt;user_id&gt; - Stop user's broadcast\n` +
        `/stop_all_broadcasts - Stop all active broadcasts\n` +
        `/notify &lt;message&gt; - Send notification to all admins\n` +
        `/abroadcast &lt;message&gt; - Broadcast to all users\n` +
        `/abroadcast_last - Resend last broadcast\n\n` +
        `<b>⚙️ System:</b>\n` +
        `/status - Bot health status\n` +
        `/health_check - Comprehensive system health check\n` +
        `/uptime - Bot uptime information\n` +
        `/test - Test admin bot connection\n\n` +
        `<b>❓ Help:</b>\n` +
        `/help - Show this help\n` +
        `/start - Show welcome message`;

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

  // Auto-reply management commands
  bot.onText(/\/autoreply$/, async (msg) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      // Get all accounts with auto-reply enabled
      const result = await db.query(
        `SELECT 
          a.account_id, 
          a.phone, 
          a.user_id,
          a.auto_reply_dm_enabled,
          a.auto_reply_dm_message,
          a.auto_reply_groups_enabled,
          a.auto_reply_groups_message,
          u.first_name,
          u.username
         FROM accounts a
         LEFT JOIN users u ON a.user_id = u.user_id
         WHERE a.auto_reply_dm_enabled = 1 OR a.auto_reply_groups_enabled = 1
         ORDER BY a.account_id`
      );

      if (result.rows.length === 0) {
        await bot.sendMessage(msg.chat.id, '📭 No accounts have auto-reply enabled', { parse_mode: 'HTML' });
        return;
      }

      // Get auto-reply service status
      const autoReplyRealtimeService = (await import('../services/autoReplyRealtimeService.js')).default;
      const activePolling = autoReplyRealtimeService.pollingAccounts.size;

      let message = `🤖 <b>Auto-Reply Status</b>\n\n`;
      message += `📊 <b>Overview:</b>\n`;
      message += `• Accounts with auto-reply: ${result.rows.length}\n`;
      message += `• Active polling sessions: ${activePolling}\n\n`;
      message += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

      for (const account of result.rows) {
        const isPolling = autoReplyRealtimeService.pollingAccounts.has(account.account_id.toString());
        const userName = account.first_name || account.username || 'Unknown';
        
        message += `📱 <b>Account ${account.account_id}</b>\n`;
        message += `   Phone: ${account.phone || 'N/A'}\n`;
        message += `   User: ${userName} (ID: ${account.user_id})\n`;
        message += `   Status: ${isPolling ? '🟢 Polling' : '🔴 Inactive'}\n`;
        
        if (account.auto_reply_dm_enabled) {
          const dmMsg = account.auto_reply_dm_message || 'Not set';
          message += `   📬 DM: ✅ Enabled\n`;
          message += `      Message: "${dmMsg.substring(0, 30)}${dmMsg.length > 30 ? '...' : ''}"\n`;
        }
        
        if (account.auto_reply_groups_enabled) {
          const groupMsg = account.auto_reply_groups_message || 'Not set';
          message += `   👥 Groups: ✅ Enabled\n`;
          message += `      Message: "${groupMsg.substring(0, 30)}${groupMsg.length > 30 ? '...' : ''}"\n`;
        }
        
        message += `\n`;
      }

      message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
      message += `💡 Use /autoreply_refresh to restart polling\n`;
      message += `📊 Use /autoreply_stats for detailed stats`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('[ADMIN BOT] Error in /autoreply:', error);
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/autoreply_refresh/, async (msg) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      await bot.sendMessage(msg.chat.id, '🔄 Refreshing auto-reply service...', { parse_mode: 'HTML' });

      const autoReplyRealtimeService = (await import('../services/autoReplyRealtimeService.js')).default;

      // Get status before refresh
      const beforePersistent = autoReplyRealtimeService.connectedAccounts.size;
      const beforeNative = autoReplyRealtimeService.nativeAwayAccounts.size;

      // Refresh the service
      await autoReplyRealtimeService.refresh();

      // Wait a bit for service to stabilize
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Get status after refresh
      const afterPersistent = autoReplyRealtimeService.connectedAccounts.size;
      const afterNative = autoReplyRealtimeService.nativeAwayAccounts.size;

      const message = `✅ <b>Auto-Reply Service Refreshed</b>\n\n` +
        `📊 <b>Status:</b>\n` +
        `• Native Away: ${beforeNative} → ${afterNative} account(s)\n` +
        `• Event-driven: ${beforePersistent} → ${afterPersistent} connection(s)\n\n` +
        `💡 All accounts with auto-reply enabled have been restarted`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
      logger.logChange('ADMIN', adminUserId, 'Refreshed auto-reply service');
    } catch (error) {
      console.error('[ADMIN BOT] Error in /autoreply_refresh:', error);
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error refreshing: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/autoreply_stats/, async (msg) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const autoReplyRealtimeService = (await import('../services/autoReplyRealtimeService.js')).default;
      
      // Get database stats
      const totalAccounts = await db.query('SELECT COUNT(*) as count FROM accounts');
      const dmEnabled = await db.query('SELECT COUNT(*) as count FROM accounts WHERE auto_reply_dm_enabled = 1');
      const groupsEnabled = await db.query('SELECT COUNT(*) as count FROM accounts WHERE auto_reply_groups_enabled = 1');
      const bothEnabled = await db.query('SELECT COUNT(*) as count FROM accounts WHERE auto_reply_dm_enabled = 1 AND auto_reply_groups_enabled = 1');

      // Get service stats
      const activePolling = autoReplyRealtimeService.pollingAccounts.size;
      const lastSeenCount = autoReplyRealtimeService.lastSeenMessages.size;
      const pollingStartCount = autoReplyRealtimeService.pollingStartTimes.size;
      const connectionErrors = autoReplyRealtimeService.connectionErrors.size;

      // Calculate uptime
      const uptime = process.uptime();
      const days = Math.floor(uptime / 86400);
      const hours = Math.floor((uptime % 86400) / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);

      let message = `📊 <b>Auto-Reply Statistics</b>\n\n`;
      
      message += `🔢 <b>Accounts:</b>\n`;
      message += `• Total accounts: ${totalAccounts.rows[0]?.count || 0}\n`;
      message += `• DM auto-reply enabled: ${dmEnabled.rows[0]?.count || 0}\n`;
      message += `• Group auto-reply enabled: ${groupsEnabled.rows[0]?.count || 0}\n`;
      message += `• Both enabled: ${bothEnabled.rows[0]?.count || 0}\n\n`;
      
      message += `⚙️ <b>Service Status:</b>\n`;
      message += `• Active polling: ${activePolling} account(s)\n`;
      message += `• Tracked chats: ${lastSeenCount}\n`;
      message += `• Initialized accounts: ${pollingStartCount}\n`;
      message += `• Connection errors tracked: ${connectionErrors}\n\n`;
      
      message += `📝 <b>Configuration:</b>\n`;
      message += `• Poll interval: 3 seconds\n`;
      message += `• Reply delay: 2-10 seconds (random)\n`;
      message += `• Max dialogs per poll: 50\n`;
      message += `• Mode: 🥷 Stealth (not online 24/7)\n\n`;
      
      message += `⏰ <b>Uptime:</b>\n`;
      message += `• Service running: ${days}d ${hours}h ${minutes}m\n\n`;
      
      message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
      message += `💡 Use /autoreply for account details\n`;
      message += `🔄 Use /autoreply_refresh to restart`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('[ADMIN BOT] Error in /autoreply_stats:', error);
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/autoreply_logs/, async (msg) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      // Get recent auto-reply logs from database
      const logs = await db.query(
        `SELECT * FROM logs 
         WHERE message LIKE '%AUTO_REPLY%' OR message LIKE '%auto_reply%' OR message LIKE '%Auto-Reply%'
         ORDER BY timestamp DESC 
         LIMIT 20`
      );

      if (logs.rows.length === 0) {
        await bot.sendMessage(msg.chat.id, '📭 No auto-reply logs found', { parse_mode: 'HTML' });
        return;
      }

      let message = `📋 <b>Recent Auto-Reply Logs</b> (Last ${logs.rows.length})\n\n`;

      for (const log of logs.rows) {
        const date = new Date(log.timestamp || log.created_at || Date.now());
        const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const status = log.status === 'success' ? '✅' : log.status === 'error' ? '❌' : 'ℹ️';
        
        message += `${status} <b>${time}</b>\n`;
        const logMessage = log.message || log.action || 'No message';
        message += `   ${logMessage.substring(0, 60)}${logMessage.length > 60 ? '...' : ''}\n`;
        message += `\n`;
      }

      message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
      message += `💡 Use /logs for all bot logs`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('[ADMIN BOT] Error in /autoreply_logs:', error);
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // Account operations commands
  bot.onText(/\/account_reconnect (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const accountId = parseInt(match[1]);
      if (isNaN(accountId)) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid account ID. Usage: /account_reconnect 123');
        return;
      }

      await bot.sendMessage(msg.chat.id, `🔄 Reconnecting account ${accountId}...`);

      // Get account info
      const accountResult = await db.query('SELECT user_id, phone FROM accounts WHERE account_id = $1', [accountId]);
      if (!accountResult.rows || accountResult.rows.length === 0) {
        await bot.sendMessage(msg.chat.id, `❌ Account ${accountId} not found`);
        return;
      }

      const userId = accountResult.rows[0]?.user_id;
      const phone = accountResult.rows[0]?.phone;

      // Disconnect if connected
      try {
        const client = accountLinker.getClient(userId, accountId);
        if (client && client.connected) {
          await client.disconnect();
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (e) {
        // Ignore disconnect errors
      }

      // Reconnect
      const client = await accountLinker.getClientAndConnect(userId, accountId);
      
      if (client && client.connected) {
        const me = await client.getMe();
        const message = `✅ <b>Account Reconnected</b>\n\n` +
          `📱 Account ID: <code>${accountId}</code>\n` +
          `📞 Phone: ${phone}\n` +
          `👤 Name: ${me.firstName || 'N/A'}\n` +
          `🆔 Telegram ID: <code>${me.id}</code>\n` +
          `🔌 Status: Connected`;
        
        await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
        logger.logChange('ADMIN', adminUserId, `Reconnected account ${accountId}`);
      } else {
        await bot.sendMessage(msg.chat.id, `❌ Failed to reconnect account ${accountId}`);
      }
    } catch (error) {
      console.error('[ADMIN BOT] Error in /account_reconnect:', error);
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error reconnecting: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/test_autoreply (.+)/, async (msg, match) => {
    if (msg.chat.type !== 'private') return;
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const accountId = parseInt(match[1]);
      if (isNaN(accountId)) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid account ID. Usage: /test_autoreply 123');
        return;
      }

      await bot.sendMessage(msg.chat.id, `🧪 Testing auto-reply for account ${accountId}...`);

      // Get account settings
      const configService = (await import('../services/configService.js')).default;
      const settings = await configService.getAccountSettings(accountId);
      
      if (!settings) {
        await bot.sendMessage(msg.chat.id, `❌ Account ${accountId} not found`);
        return;
      }

      const autoReplyRealtimeService = (await import('../services/autoReplyRealtimeService.js')).default;
      const isPolling = autoReplyRealtimeService.pollingAccounts.has(accountId.toString());

      let message = `🧪 <b>Auto-Reply Test Results</b>\n\n`;
      message += `📱 Account ID: <code>${accountId}</code>\n\n`;
      
      message += `<b>Configuration:</b>\n`;
      message += `📬 DM Auto-Reply: ${settings.autoReplyDmEnabled ? '✅ Enabled' : '❌ Disabled'}\n`;
      if (settings.autoReplyDmEnabled) {
        message += `   Message: "${settings.autoReplyDmMessage?.substring(0, 50)}${settings.autoReplyDmMessage?.length > 50 ? '...' : ''}"\n`;
      }
      message += `👥 Group Auto-Reply: ${settings.autoReplyGroupsEnabled ? '✅ Enabled' : '❌ Disabled'}\n`;
      if (settings.autoReplyGroupsEnabled) {
        message += `   Message: "${settings.autoReplyGroupsMessage?.substring(0, 50)}${settings.autoReplyGroupsMessage?.length > 50 ? '...' : ''}"\n`;
      }
      message += `\n`;
      
      message += `<b>Service Status:</b>\n`;
      message += `🔌 Polling: ${isPolling ? '🟢 Active' : '🔴 Inactive'}\n`;
      
      if (!isPolling && (settings.autoReplyDmEnabled || settings.autoReplyGroupsEnabled)) {
        message += `\n⚠️ <b>Warning:</b> Auto-reply is enabled but not polling!\n`;
        message += `💡 Try: /autoreply_refresh`;
      } else if (isPolling && !settings.autoReplyDmEnabled && !settings.autoReplyGroupsEnabled) {
        message += `\n⚠️ <b>Warning:</b> Polling but auto-reply is disabled!\n`;
      } else if (isPolling) {
        message += `\n✅ <b>Status:</b> Auto-reply is working correctly\n`;
        message += `📝 Send a test message to verify responses`;
      }

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
      logger.logChange('ADMIN', adminUserId, `Tested auto-reply for account ${accountId}`);
    } catch (error) {
      console.error('[ADMIN BOT] Error in /test_autoreply:', error);
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error testing: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/health_check/, async (msg) => {
    if (msg.chat.type !== 'private') return;
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      await bot.sendMessage(msg.chat.id, '🏥 Running comprehensive health check...');

      // Database check
      let dbStatus = '✅ Healthy';
      let dbLatency = 0;
      try {
        const start = Date.now();
        await db.query('SELECT 1');
        dbLatency = Date.now() - start;
        if (dbLatency > 1000) dbStatus = '⚠️ Slow';
      } catch (error) {
        dbStatus = `❌ Error: ${error.message.substring(0, 30)}`;
      }

      // Auto-reply service check
      const autoReplyRealtimeService = (await import('../services/autoReplyRealtimeService.js')).default;
      const pollingCount = autoReplyRealtimeService.pollingAccounts.size;
      const expectedPolling = await db.query(
        'SELECT COUNT(*) as count FROM accounts WHERE auto_reply_dm_enabled = 1 OR auto_reply_groups_enabled = 1'
      );
      const autoReplyStatus = pollingCount === (expectedPolling.rows[0]?.count || 0) ? '✅ Healthy' : '⚠️ Mismatch';

      // Broadcast service check
      const activeBroadcasts = automationService.activeBroadcasts?.size || 0;
      const broadcastStatus = '✅ Running';

      // Memory check
      const memUsage = process.memoryUsage();
      const heapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
      const heapTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(2);
      const heapPercent = ((memUsage.heapUsed / memUsage.heapTotal) * 100).toFixed(1);
      const memoryStatus = heapPercent > 90 ? '⚠️ High' : heapPercent > 70 ? '⚠️ Medium' : '✅ Normal';

      // Uptime
      const uptime = process.uptime();
      const days = Math.floor(uptime / 86400);
      const hours = Math.floor((uptime % 86400) / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);

      // Account connection check
      const totalAccounts = await db.query('SELECT COUNT(*) as count FROM accounts');
      const linkedAccounts = accountLinker.linkedAccounts.size;
      const accountStatus = linkedAccounts > 0 ? '✅ Connected' : '⚠️ None linked';

      let message = `🏥 <b>Comprehensive Health Check</b>\n\n`;
      
      message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
      message += `<b>🗄️ Database</b>\n`;
      message += `Status: ${dbStatus}\n`;
      message += `Latency: ${dbLatency}ms\n\n`;
      
      message += `<b>🤖 Auto-Reply Service</b>\n`;
      message += `Status: ${autoReplyStatus}\n`;
      message += `Active polling: ${pollingCount}/${expectedPolling.rows[0]?.count || 0}\n\n`;
      
      message += `<b>📢 Broadcast Service</b>\n`;
      message += `Status: ${broadcastStatus}\n`;
      message += `Active broadcasts: ${activeBroadcasts}\n\n`;
      
      message += `<b>🔑 Accounts</b>\n`;
      message += `Status: ${accountStatus}\n`;
      message += `Total accounts: ${totalAccounts.rows[0]?.count || 0}\n`;
      message += `Linked accounts: ${linkedAccounts}\n\n`;
      
      message += `<b>💾 Memory</b>\n`;
      message += `Status: ${memoryStatus}\n`;
      message += `Usage: ${heapUsedMB}MB / ${heapTotalMB}MB (${heapPercent}%)\n\n`;
      
      message += `<b>⏰ Uptime</b>\n`;
      message += `Running: ${days}d ${hours}h ${minutes}m\n`;
      message += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

      // Overall status
      const hasErrors = dbStatus.includes('❌') || autoReplyStatus.includes('❌');
      const hasWarnings = dbStatus.includes('⚠️') || autoReplyStatus.includes('⚠️') || 
                          memoryStatus.includes('⚠️') || accountStatus.includes('⚠️');
      
      if (hasErrors) {
        message += `🔴 <b>Overall:</b> Critical Issues Detected\n`;
        message += `⚠️ Immediate attention required!`;
      } else if (hasWarnings) {
        message += `🟡 <b>Overall:</b> System Operational (Warnings)\n`;
        message += `💡 Some components need attention`;
      } else {
        message += `🟢 <b>Overall:</b> All Systems Healthy\n`;
        message += `✨ Bot is operating normally`;
      }

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
      logger.logChange('ADMIN', adminUserId, 'Performed health check');
    } catch (error) {
      console.error('[ADMIN BOT] Error in /health_check:', error);
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error running health check: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/cleanup/, async (msg) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      await bot.sendMessage(msg.chat.id, '🧹 Starting cleanup...');

      let cleanupSummary = '';
      let totalCleaned = 0;

      // Clean old logs (older than 30 days)
      try {
        const logsResult = await db.query(
          `DELETE FROM logs WHERE created_at < datetime('now', '-30 days')`
        );
        const logsDeleted = logsResult.rowCount || 0;
        totalCleaned += logsDeleted;
        cleanupSummary += `📋 Logs: ${logsDeleted} old entries removed\n`;
      } catch (e) {
        cleanupSummary += `⚠️ Logs: Error cleaning\n`;
      }

      // Clean old broadcasts (completed, older than 7 days)
      try {
        const broadcastsResult = await db.query(
          `DELETE FROM broadcast_messages 
           WHERE created_at < datetime('now', '-7 days')
           AND broadcast_id IN (
             SELECT id FROM broadcasts WHERE status = 'completed'
           )`
        );
        const broadcastsDeleted = broadcastsResult.rowCount || 0;
        totalCleaned += broadcastsDeleted;
        cleanupSummary += `📢 Broadcast messages: ${broadcastsDeleted} old entries removed\n`;
      } catch (e) {
        cleanupSummary += `⚠️ Broadcasts: Error cleaning\n`;
      }

      // Clean orphaned sessions (accounts deleted but sessions remain)
      try {
        const sessionsResult = await db.query(
          `DELETE FROM sessions 
           WHERE account_id NOT IN (SELECT account_id FROM accounts)`
        );
        const sessionsDeleted = sessionsResult.rowCount || 0;
        totalCleaned += sessionsDeleted;
        cleanupSummary += `🔐 Orphaned sessions: ${sessionsDeleted} removed\n`;
      } catch (e) {
        cleanupSummary += `⚠️ Sessions: Error cleaning\n`;
      }

      // Clean old OTP codes (older than 1 day)
      try {
        const otpResult = await db.query(
          `DELETE FROM otp_codes WHERE created_at < datetime('now', '-1 day')`
        );
        const otpDeleted = otpResult.rowCount || 0;
        totalCleaned += otpDeleted;
        cleanupSummary += `🔢 Expired OTPs: ${otpDeleted} removed\n`;
      } catch (e) {
        cleanupSummary += `⚠️ OTPs: Error cleaning\n`;
      }

      // Run VACUUM to reclaim space (SQLite)
      try {
        await db.query('VACUUM');
        cleanupSummary += `💾 Database: Optimized and compacted\n`;
      } catch (e) {
        cleanupSummary += `⚠️ Database: Could not optimize\n`;
      }

      const message = `✅ <b>Cleanup Complete</b>\n\n` +
        cleanupSummary +
        `\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🗑️ Total items cleaned: <b>${totalCleaned}</b>\n` +
        `✨ Database optimized`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
      logger.logChange('ADMIN', adminUserId, `Cleanup completed: ${totalCleaned} items removed`);
    } catch (error) {
      console.error('[ADMIN BOT] Error in /cleanup:', error);
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error during cleanup: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/ban_user (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const userId = parseInt(match[1]);
      if (isNaN(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid user ID. Usage: /ban_user 123456789');
        return;
      }

      // Check if user exists
      const userResult = await db.query('SELECT * FROM users WHERE user_id = $1', [userId]);
      if (!userResult.rows || userResult.rows.length === 0) {
        await bot.sendMessage(msg.chat.id, `❌ User ${userId} not found`);
        return;
      }

      const user = userResult.rows[0];

      // Add to banned users (using automation service or create banned_users table)
      await db.query(
        `INSERT INTO banned_users (user_id, banned_by, banned_at, reason) 
         VALUES ($1, $2, datetime('now'), 'Banned by admin')
         ON CONFLICT(user_id) DO UPDATE SET banned_at = datetime('now'), banned_by = $2`,
        [userId, adminUserId]
      );

      // Stop any active broadcasts for this user
      const stoppedBroadcasts = [];
      for (const [uid, broadcast] of automationService.activeBroadcasts.entries()) {
        if (parseInt(uid) === userId) {
          await automationService.stopBroadcast(uid, broadcast.accountId);
          stoppedBroadcasts.push(broadcast.accountId);
        }
      }

      const message = `🚫 <b>User Banned</b>\n\n` +
        `👤 User ID: <code>${userId}</code>\n` +
        `📝 Name: ${user.first_name || 'N/A'}\n` +
        `📛 Username: @${user.username || 'N/A'}\n` +
        `📢 Stopped broadcasts: ${stoppedBroadcasts.length}\n\n` +
        `✅ User is now banned from using the bot`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
      logger.logChange('ADMIN', adminUserId, `Banned user ${userId}`);

      // Notify user they're banned (via main bot)
      if (mainBot) {
        try {
          await mainBot.sendMessage(userId, '🚫 You have been banned from using this bot. Contact support if you believe this is an error.');
        } catch (e) {
          // Ignore if can't notify user
        }
      }
    } catch (error) {
      console.error('[ADMIN BOT] Error in /ban_user:', error);
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error banning user: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/unban_user (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const userId = parseInt(match[1]);
      if (isNaN(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid user ID. Usage: /unban_user 123456789');
        return;
      }

      // Get user info for display
      const userResult = await db.query('SELECT username, first_name FROM users WHERE user_id = $1', [userId]);
      const userInfo = userResult.rows[0];
      const username = userInfo?.username ? `@${userInfo.username}` : 'N/A';
      const firstName = userInfo?.first_name || 'Unknown';
      
      // Remove from banned users
      const result = await db.query('DELETE FROM banned_users WHERE user_id = $1', [userId]);
      
      if (!result.rowCount || result.rowCount === 0) {
        await bot.sendMessage(msg.chat.id, `ℹ️ User <b>${firstName}</b> (${username}) - <code>${userId}</code> was not banned`, { parse_mode: 'HTML' });
        return;
      }

      const message = `✅ <b>User Unbanned</b>\n\n` +
        `👤 User: <b>${firstName}</b> (${username})\n` +
        `🆔 User ID: <code>${userId}</code>\n\n` +
        `User can now use the bot again`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
      logger.logChange('ADMIN', adminUserId, `Unbanned user ${userId}`);

      // Notify user they're unbanned
      if (mainBot) {
        try {
          await mainBot.sendMessage(userId, '✅ Your ban has been lifted. You can now use the bot again. Welcome back!');
        } catch (e) {
          // Ignore if can't notify user
        }
      }
    } catch (error) {
      console.error('[ADMIN BOT] Error in /unban_user:', error);
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error unbanning user: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/message_user (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const parts = match[1].split(' ');
      if (parts.length < 2) {
        await bot.sendMessage(msg.chat.id, '❌ Usage: /message_user <user_id> <message>');
        return;
      }

      const userId = parseInt(parts[0]);
      const message = parts.slice(1).join(' ');

      if (isNaN(userId)) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid user ID');
        return;
      }

      // Get user info for display
      const userResult = await db.query('SELECT username, first_name FROM users WHERE user_id = $1', [userId]);
      const userInfo = userResult.rows[0];
      const username = userInfo?.username ? `@${userInfo.username}` : 'N/A';
      const firstName = userInfo?.first_name || 'Unknown';

      if (!mainBot) {
        await bot.sendMessage(msg.chat.id, '❌ Main bot not available');
        return;
      }

      // Send message to user
      await mainBot.sendMessage(userId, `📨 <b>Message from Admin:</b>\n\n${message}`, { parse_mode: 'HTML' });

      await bot.sendMessage(msg.chat.id, `✅ Message sent to user <b>${firstName}</b> (${username}) - <code>${userId}</code>`, { parse_mode: 'HTML' });
      logger.logChange('ADMIN', adminUserId, `Sent message to user ${userId}`);
    } catch (error) {
      console.error('[ADMIN BOT] Error in /message_user:', error);
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error sending message: ${safeErrorMessage}`);
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

      // Get user info for display
      const userResult = await db.query('SELECT username, first_name FROM users WHERE user_id = $1', [targetUserId]);
      const userInfo = userResult.rows[0];
      const username = userInfo?.username ? `@${userInfo.username}` : 'N/A';
      const firstName = userInfo?.first_name || 'Unknown';
      
      const subscription = await premiumService.getSubscription(targetUserId);
      const isPremium = await premiumService.isPremium(targetUserId);

      let message = `╔═══════════════════════════╗
║  👤 <b>USER PREMIUM STATUS</b>  ║
╚═══════════════════════════╝\n\n`;
      message += `👤 <b>User:</b> ${firstName} (${username})\n`;
      message += `🆔 <b>User ID:</b> <code>${targetUserId}</code>\n\n`;
      
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

  // /premium_revoke <user_id> command - Revoke premium subscription
  bot.onText(/\/premium_revoke (.+)/, async (msg, match) => {
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

      // Get user info for display
      const userResult = await db.query('SELECT username, first_name FROM users WHERE user_id = $1', [targetUserId]);
      const userInfo = userResult.rows[0];
      const username = userInfo?.username || 'N/A';
      const firstName = userInfo?.first_name || 'N/A';

      // Cancel the subscription
      const result = await premiumService.cancelSubscription(targetUserId);

      if (result.success) {
        const message = `╔═══════════════════════════╗
║  🚫 <b>PREMIUM REVOKED</b>      ║
╚═══════════════════════════╝

👤 <b>User:</b> ${firstName} (@${username})
🆔 <b>User ID:</b> <code>${targetUserId}</code>

✅ Premium subscription has been cancelled.

<i>User will lose premium access immediately.</i>`;
        
        await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
        logger.logChange('ADMIN', adminUserId, `Revoked premium for user ${targetUserId} (@${username})`);
      } else {
        await bot.sendMessage(
          msg.chat.id, 
          `❌ <b>Failed to Revoke Premium</b>\n\n<code>${result.error || 'Unknown error'}</code>`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
      logger.logError('ADMIN', adminUserId, error, 'Failed to revoke premium');
    }
  });

  // /premium_cancel <user_id> command - Alias for revoke
  bot.onText(/\/premium_cancel (.+)/, async (msg, match) => {
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

      const userResult = await db.query('SELECT username, first_name FROM users WHERE user_id = $1', [targetUserId]);
      const userInfo = userResult.rows[0];
      const username = userInfo?.username || 'N/A';
      const firstName = userInfo?.first_name || 'N/A';

      const result = await premiumService.cancelSubscription(targetUserId);

      if (result.success) {
        const message = `╔═══════════════════════════╗
║  🚫 <b>PREMIUM CANCELLED</b>    ║
╚═══════════════════════════╝

👤 <b>User:</b> ${firstName} (@${username})
🆔 <b>User ID:</b> <code>${targetUserId}</code>

✅ Premium subscription has been cancelled.

<i>User will lose premium access immediately.</i>`;
        
        await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
        logger.logChange('ADMIN', adminUserId, `Cancelled premium for user ${targetUserId} (@${username})`);
      } else {
        await bot.sendMessage(
          msg.chat.id, 
          `❌ <b>Failed to Cancel Premium</b>\n\n<code>${result.error || 'Unknown error'}</code>`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
      logger.logError('ADMIN', adminUserId, error, 'Failed to cancel premium');
    }
  });

  // Payment verification admin commands
  bot.onText(/\/payment_pending/, async (msg) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const paymentVerificationService = (await import('../services/paymentVerificationService.js')).default;
      const pendingSubmissions = await paymentVerificationService.getPendingSubmissions();

      if (pendingSubmissions.length === 0) {
        await bot.sendMessage(msg.chat.id, '📭 No pending payment submissions.');
        return;
      }

      let message = `╔═══════════════════════════╗\n║  📋 <b>PENDING PAYMENTS</b>    ║\n╚═══════════════════════════╝\n\n`;
      
      for (const submission of pendingSubmissions.slice(0, 10)) {
        message += `┌───────────────────────────┐\n`;
        message += `│ <b>ID:</b> ${submission.id}\n`;
        message += `│ <b>User:</b> ${submission.user_id} (@${submission.username || 'N/A'})\n`;
        message += `│ <b>TXN ID:</b> <code>${submission.transaction_id}</code>\n`;
        message += `│ <b>Amount:</b> ₹${submission.amount}\n`;
        message += `│ <b>Method:</b> ${submission.payment_method || 'N/A'}\n`;
        message += `│ <b>Gateway:</b> ${submission.payment_gateway || 'Manual'}\n`;
        message += `│ <b>Created:</b> ${new Date(submission.created_at).toLocaleString()}\n`;
        message += `└───────────────────────────┘\n\n`;
      }

      message += `\n<b>Commands:</b>\n/payment_verify [ID] - Verify payment\n/payment_reject [ID] [reason] - Reject payment`;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/payment_verify (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const submissionId = parseInt(match[1]);
      if (isNaN(submissionId)) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid submission ID');
        return;
      }

      const paymentVerificationService = (await import('../services/paymentVerificationService.js')).default;
      const result = await paymentVerificationService.adminVerifyPayment(submissionId, adminUserId);

      if (result.success) {
        const expiresAt = new Date(result.subscription.expires_at);
        const expiresAtFormatted = expiresAt.toLocaleDateString('en-IN', { 
          day: 'numeric', 
          month: 'long', 
          year: 'numeric' 
        });

        await bot.sendMessage(
          msg.chat.id,
          `✅ <b>Payment Verified</b>\n\nPremium subscription activated.\n\n<b>Expires:</b> ${expiresAtFormatted}`,
          { parse_mode: 'HTML' }
        );
      } else {
        await bot.sendMessage(msg.chat.id, `❌ Failed: ${result.error}`, { parse_mode: 'HTML' });
      }
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  bot.onText(/\/payment_reject (.+)/, async (msg, match) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const parts = match[1].split(' ');
      const submissionId = parseInt(parts[0]);
      const reason = parts.slice(1).join(' ') || 'No reason provided';

      if (isNaN(submissionId)) {
        await bot.sendMessage(msg.chat.id, '❌ Invalid submission ID');
        return;
      }

      const paymentVerificationService = (await import('../services/paymentVerificationService.js')).default;
      const result = await paymentVerificationService.adminRejectPayment(submissionId, adminUserId, reason);

      if (result.success) {
        await bot.sendMessage(msg.chat.id, `✅ Payment rejected: ${reason}`, { parse_mode: 'HTML' });
      } else {
        await bot.sendMessage(msg.chat.id, `❌ Failed: ${result.error}`, { parse_mode: 'HTML' });
      }
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error, false);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${safeErrorMessage}`);
    }
  });

  // /links command - Collect all group links from all accounts and return as text file
  bot.onText(/\/links/, async (msg) => {
    const adminUserId = validateUserId(msg.from?.id);
    if (!adminUserId || !isAdmin(adminUserId)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      // Send status message
      const statusMsg = await bot.sendMessage(
        msg.chat.id,
        '🔗 Collecting group links from all accounts...\n\n⏳ This may take a while, please wait.',
        { parse_mode: 'HTML' }
      );

      // Get all active accounts
      const accounts = await db.query(
        'SELECT account_id, user_id, phone FROM accounts WHERE is_active = TRUE'
      );

      if (accounts.rows.length === 0) {
        await bot.editMessageText('❌ No active accounts found.', {
          chat_id: msg.chat.id,
          message_id: statusMsg.message_id,
        });
        return;
      }

      const allLinks = new Set(); // Use Set to automatically handle duplicates
      let processedAccounts = 0;
      let totalGroups = 0;

      // Process each account
      for (const account of accounts.rows) {
        try {
          const accountId = account.account_id;
          let client = null;

          try {
            // Get client for this account
            client = await accountLinker.getClientAndConnect(null, accountId);
            if (!client) {
              console.log(`[LINKS] Skipping account ${accountId} - client not available`);
              continue;
            }

            // Get dialogs for this account
            let dialogs = [];
            try {
              dialogs = await client.getDialogs();
            } catch (dialogsError) {
              // Check if it's a session revocation error (AUTH_KEY_UNREGISTERED or SESSION_REVOKED)
              const errorMessage = dialogsError.message || dialogsError.toString() || '';
              const errorCode = dialogsError.code || dialogsError.errorCode || dialogsError.response?.error_code;
              const errorMsg = dialogsError.errorMessage || '';
              const isSessionRevoked = 
                errorMsg === 'SESSION_REVOKED' || 
                errorMsg === 'AUTH_KEY_UNREGISTERED' ||
                (errorCode === 401 && (errorMessage.includes('SESSION_REVOKED') || errorMessage.includes('AUTH_KEY_UNREGISTERED'))) ||
                errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
                errorMessage.includes('SESSION_REVOKED');
              
              if (isSessionRevoked) {
                console.log(`[LINKS] Session revoked for account ${accountId} (detected in getDialogs) - marking for re-authentication`);
                try {
                  await accountLinker.handleSessionRevoked(accountId);
                } catch (revokeError) {
                  console.log(`[LINKS] Error handling session revocation for account ${accountId}: ${revokeError.message}`);
                }
                // Skip this account and continue to next
                continue;
              }
              // Re-throw if it's not a session error
              throw dialogsError;
            }
            const groups = dialogs.filter(dialog => (dialog.isGroup || dialog.isChannel));

            // Collect links from this account's groups (silent mode to reduce logs)
            const accountLinks = await groupService.collectGroupLinks(client, accountId, groups, true);
            
            // Add to master set (automatically handles duplicates)
            accountLinks.forEach(link => allLinks.add(link));
            totalGroups += groups.length;
            processedAccounts++;

            // Disconnect client
            if (client && client.connected) {
              await client.disconnect();
            }
          } catch (accountError) {
            // Check if it's a session revocation error (AUTH_KEY_UNREGISTERED or SESSION_REVOKED)
            const errorMessage = accountError.message || accountError.toString() || '';
            const errorCode = accountError.code || accountError.errorCode || accountError.response?.error_code;
            const errorMsg = accountError.errorMessage || '';
            const isSessionRevoked = 
              errorMsg === 'SESSION_REVOKED' || 
              errorMsg === 'AUTH_KEY_UNREGISTERED' ||
              (errorCode === 401 && (errorMessage.includes('SESSION_REVOKED') || errorMessage.includes('AUTH_KEY_UNREGISTERED'))) ||
              errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
              errorMessage.includes('SESSION_REVOKED');
            
            if (isSessionRevoked) {
              console.log(`[LINKS] Session revoked for account ${accountId} (detected in outer catch) - marking for re-authentication`);
              try {
                await accountLinker.handleSessionRevoked(accountId);
              } catch (revokeError) {
                console.log(`[LINKS] Error handling session revocation for account ${accountId}: ${revokeError.message}`);
              }
              // Skip logging and continue to next account
              if (client && client.connected) {
                try {
                  await client.disconnect();
                } catch (disconnectError) {
                  // Ignore disconnect errors
                }
              }
              continue;
            }
            
            logger.logError('LINKS', accountId, accountError, `Error processing account ${accountId}`);
            if (client && client.connected) {
              try {
                await client.disconnect();
              } catch (disconnectError) {
                // Ignore disconnect errors
              }
            }
            continue;
          }
        } catch (error) {
          logger.logError('LINKS', account.account_id, error, `Error processing account ${account.account_id}`);
          continue;
        }
      }

      // Convert Set to Array and sort
      const uniqueLinks = Array.from(allLinks).sort();

      if (uniqueLinks.length === 0) {
        await bot.editMessageText(
          '❌ No group links found. Make sure accounts have groups and you have permission to access invite links.',
          {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id,
          }
        );
        return;
      }

      // Create text file content
      const fileContent = uniqueLinks.join('\n');
      const fileName = `group_links_${Date.now()}.txt`;

      // Get directory for temporary files
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const tempDir = path.join(__dirname, '../../temp');
      
      // Ensure temp directory exists
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const filePath = path.join(tempDir, fileName);

      // Write file
      fs.writeFileSync(filePath, fileContent, 'utf8');

      // Send file
      await bot.sendDocument(
        msg.chat.id,
        filePath,
        {
          caption: `✅ <b>Group Links Collected</b>\n\n` +
            `📊 <b>Statistics:</b>\n` +
            `• Accounts Processed: ${processedAccounts}/${accounts.rows.length}\n` +
            `• Total Groups: ${totalGroups}\n` +
            `• Unique Links: ${uniqueLinks.length}\n\n` +
            `<i>File generated at ${new Date().toLocaleString()}</i>`,
          parse_mode: 'HTML'
        }
      );

      // Delete status message
      await bot.deleteMessage(msg.chat.id, statusMsg.message_id);

      // Clean up temp file after a delay
      setTimeout(() => {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
      }, 60000); // Delete after 1 minute

      logger.logChange('ADMIN_LINKS', adminUserId, `Collected ${uniqueLinks.length} unique group links from ${processedAccounts} accounts`);
    } catch (error) {
      logger.logError('LINKS', adminUserId, error, 'Error collecting group links');
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
