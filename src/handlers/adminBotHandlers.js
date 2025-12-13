/**
 * Admin Bot Handlers
 * Handles admin bot commands and controls
 */

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import db from '../database/db.js';
import accountLinker from '../services/accountLinker.js';
import automationService from '../services/automationService.js';
import logger from '../utils/logger.js';
import adminNotifier from '../services/adminNotifier.js';

let adminBot = null;
let mainBot = null; // Reference to main bot for sending messages to users
let lastAdminBroadcast = null; // Store last broadcast message

/**
 * Initialize admin bot
 */
export function initializeAdminBot(mainBotInstance = null) {
  if (!config.adminBotToken) {
    console.log('[ADMIN BOT] Admin bot token not configured');
    return null;
  }

  try {
    adminBot = new TelegramBot(config.adminBotToken, { polling: true });
    mainBot = mainBotInstance; // Store reference to main bot
    console.log('[ADMIN BOT] Admin bot initialized');
    console.log(`[ADMIN BOT] Main bot instance ${mainBot ? 'is set' : 'is NOT set'}`);

    // Add error handler
    adminBot.on('polling_error', (error) => {
      console.error('[ADMIN BOT] Polling error:', error);
      logger.logError('ADMIN_BOT', null, error, 'Admin bot polling error');
    });

    adminBot.on('error', (error) => {
      console.error('[ADMIN BOT] Error:', error);
      logger.logError('ADMIN_BOT', null, error, 'Admin bot error');
    });

    // Register admin commands
    registerAdminCommands(adminBot);
    
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
      `<b>Available Commands:</b>\n` +
      `/stats - View bot statistics\n` +
      `/users - List all users\n` +
      `/accounts - List all accounts\n` +
      `/broadcasts - View active broadcasts\n` +
      `/logs - View recent logs\n` +
      `/errors - View recent errors\n` +
      `/notify <message> - Send notification to all admins\n` +
      `/abroadcast <message> - Broadcast message to all users\n` +
      `/abroadcast_last - Resend last broadcast message\n` +
      `/user <id> - Get user details\n` +
      `/account <id> - Get account details\n` +
      `/stop_broadcast <user_id> - Stop user's broadcast\n` +
      `/help - Show this help`;

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
      await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
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
      await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
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
      await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
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
      await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
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
      await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
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
      await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
    }
  });

  // /user <id> command
  bot.onText(/\/user (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    try {
      const userId = BigInt(match[1]);
      const user = await db.query('SELECT * FROM users WHERE user_id = $1', [userId]);
      
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
      await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
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
      const result = await automationService.stopBroadcast(userId);
      
      if (result.success) {
        await bot.sendMessage(msg.chat.id, `✅ Broadcast stopped for user ${userId}`);
        logger.logChange('ADMIN', msg.from.id, `Stopped broadcast for user ${userId}`);
      } else {
        await bot.sendMessage(msg.chat.id, `❌ ${result.error}`);
      }
    } catch (error) {
      await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
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
      await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
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

      // Send message to each user
      for (const userId of userIds) {
        try {
          await mainBot.sendMessage(userId, broadcastMessage, { parse_mode: 'HTML' });
          successCount++;
          logger.logChange('ADMIN_BROADCAST', msg.from.id, `Sent broadcast to user ${userId}`);
        } catch (error) {
          failedCount++;
          failedUsers.push(userId);
          // Log but don't stop - continue with other users
          console.log(`[ADMIN_BROADCAST] Failed to send to user ${userId}: ${error.message}`);
          logger.logError('ADMIN_BROADCAST', userId, error, `Failed to send broadcast to user ${userId}`);
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
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
        await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
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

      // Send message to each user
      for (const userId of userIds) {
        try {
          await mainBot.sendMessage(userId, lastAdminBroadcast, { parse_mode: 'HTML' });
          successCount++;
          logger.logChange('ADMIN_BROADCAST', msg.from.id, `Resent broadcast to user ${userId}`);
        } catch (error) {
          failedCount++;
          console.log(`[ADMIN_BROADCAST] Failed to resend to user ${userId}: ${error.message}`);
          logger.logError('ADMIN_BROADCAST', userId, error, `Failed to resend broadcast to user ${userId}`);
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
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
      await bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
    }
  });

  // /help command
  bot.onText(/\/help/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '❌ Unauthorized');
      return;
    }

    const helpMessage = `👑 <b>Admin Bot Commands</b>\n\n` +
      `<b>Statistics:</b>\n` +
      `/stats - View bot statistics\n` +
      `/users - List all users\n` +
      `/accounts - List all accounts\n` +
      `/broadcasts - View active broadcasts\n\n` +
      `<b>Monitoring:</b>\n` +
      `/logs - View recent logs\n` +
      `/errors - View recent errors\n` +
      `/user <id> - Get user details\n\n` +
      `<b>Control:</b>\n` +
      `/stop_broadcast <user_id> - Stop user's broadcast\n` +
      `/notify <message> - Send notification to admins\n` +
      `/abroadcast <message> - Broadcast to all users\n` +
      `/abroadcast_last - Resend last broadcast\n\n` +
      `<b>Help:</b>\n` +
      `/help - Show this help`;

    await bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'HTML' });
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
