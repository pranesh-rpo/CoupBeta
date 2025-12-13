import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import db from './database/db.js';
import { initializeSchema } from './database/schema.js';
import accountLinker from './services/accountLinker.js';
import messageManager from './services/messageManager.js';
import adminNotifier from './services/adminNotifier.js';
import userService from './services/userService.js';
import automationService from './services/automationService.js';
import logger, { colors, logError } from './utils/logger.js';
import { safeAnswerCallback } from './utils/safeEdit.js';

// Filter out normal Telegram client connection/reconnection logs
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = function(...args) {
  const message = args.join(' ');
  // Filter out Telegram client connection/reconnection info logs
  if (
    message.includes('[Connecting to') ||
    message.includes('[connection closed]') ||
    message.includes('[Connection to') ||
    message.includes('[Handling reconnect!]') ||
    message.includes('[Connection closed while receiving data]') ||
    message.includes('[Started reconnecting]') ||
    message.includes('[Reconnect]') ||
    message.includes('[Disconnecting from')
  ) {
    return; // Suppress these normal connection management logs
  }
  originalConsoleLog.apply(console, args);
};

console.warn = function(...args) {
  const message = args.join(' ');
  // Filter out Telegram client connection warnings
  if (
    message.includes('Connection closed') ||
    message.includes('connection closed') ||
    message.includes('while receiving data') ||
    message.includes('[Started reconnecting]') ||
    message.includes('[Reconnect]') ||
    message.includes('[Disconnecting from')
  ) {
    return; // Suppress these normal connection management warnings
  }
  originalConsoleWarn.apply(console, args);
};

console.error = function(...args) {
  // Check if any argument is an Error object
  let isTimeoutError = false;
  let isConnectionError = false;
  
  // First, check all arguments for Error objects
  for (const arg of args) {
    if (arg instanceof Error) {
      const errorMessage = arg.message || '';
      const errorStack = arg.stack || '';
      
      // Check for TIMEOUT errors from telegram client update loop
      // Match: "TIMEOUT" message OR any message with TIMEOUT and stack containing updates.js
      if (errorMessage === 'TIMEOUT' || 
          errorMessage.includes('TIMEOUT') ||
          (errorStack && errorStack.includes('telegram/client/updates.js') && errorStack.includes('TIMEOUT'))) {
        isTimeoutError = true;
        break;
      }
      
      // Check for "Not connected" errors during reconnection
      if ((errorMessage === 'Not connected' || errorMessage.includes('Not connected')) && 
          errorStack.includes('telegram/network/connection/Connection.js')) {
        isConnectionError = true;
        break;
      }
    }
  }
  
  // If it's a timeout error, suppress it
  if (isTimeoutError) {
    return; // Suppress these normal timeout errors
  }
  
  // If it's a connection error, suppress it
  if (isConnectionError) {
    return; // Suppress these normal reconnection errors
  }
  
  // Check the joined message string as well (for cases where error is logged as string)
  const message = args.join(' ');
  
  // Filter out TIMEOUT errors from message string - check for both "Error: TIMEOUT" and stack trace
  if ((message.includes('Error: TIMEOUT') || message.includes('TIMEOUT')) && 
      message.includes('telegram/client/updates.js')) {
    return; // Suppress these normal timeout errors
  }
  
  // Also check if message starts with "Error: TIMEOUT" (common format)
  if (message.trim().startsWith('Error: TIMEOUT')) {
    return; // Suppress these normal timeout errors
  }
  
  // Filter out "Not connected" errors during reconnection
  if (message.includes('Error: Not connected') && message.includes('telegram/network/connection/Connection.js')) {
    return; // Suppress these normal reconnection errors
  }
  
  // Filter out connection-related messages
  if (message.includes('Connection closed') || 
      message.includes('connection closed') ||
      message.includes('Started reconnecting') ||
      message.includes('[Reconnect]') ||
      message.includes('[Disconnecting from') ||
      message.includes('[Disconnecting...]')) {
    return; // Normal connection management
  }
  
  originalConsoleError.apply(console, args);
};
import {
  handleStart,
  handleMainMenu,
  handleLink,
  handleLinkButton,
  handlePhoneNumber,
  setPendingPhoneNumbersReference,
  handleOTPCallback,
  handleSetStartMessage,
  handleSetStartMessageButton,
  handleStartBroadcast,
  handleStartBroadcastButton,
  handleStopBroadcast,
  handleStopBroadcastButton,
  handleStopCallback,
  handleStatus,
  handleStatusButton,
  handlePasswordInput,
  handleAccountButton,
  handleSwitchAccountButton,
  handleSwitchAccount,
  handleDeleteAccount,
  handleVerifyChannel,
  handleGroupsButton,
  handleRefreshGroups,
  handleListGroups,
  handleABMessagesButton,
  handleABSetMessage,
  handleABMessageInput,
  handleABViewMessages,
  handleSavedTemplatesButton,
  handleTemplateSync,
  handleTemplateSelect,
  handleTemplateClear,
  handleApplyTags,
} from './handlers/commandHandler.js';
import {
  handleConfigButton,
  handleConfigRateLimit,
  handleConfigRateLimitPreset,
  handleConfigQuietHours,
  handleQuietHoursSet,
  handleQuietHoursView,
  handleQuietHoursClear,
  handleQuietHoursInput,
  handleConfigAB,
  handleConfigABMode,
  handleConfigSchedule,
  handleScheduleSet,
  handleScheduleView,
  handleScheduleClear,
  handleScheduleInput,
  handleConfigMention,
  handleConfigMentionToggle,
  handleConfigMentionCount,
} from './handlers/configHandlers.js';
import {
  handleStatsButton,
  handleTopGroups,
  handleDetailedStats,
  handleProblematicGroups,
  handleABResults,
} from './handlers/statsHandlers.js';
import notificationService from './services/notificationService.js';
import { initializeAdminBot } from './handlers/adminBotHandlers.js';
import { createMainMenu, createBackButton } from './handlers/keyboardHandler.js';

// Initialize database, schema, and services
(async () => {
  try {
    // Initialize admin notifier first (for error notifications)
    await adminNotifier.initialize();
    
    // Initialize database connection
    await db.connect();
    
    // Initialize database schema
    await initializeSchema();
    
    // Initialize message manager
    await messageManager.initialize();
    console.log('✅ Message manager initialized');
    
    // Initialize account linker
    await accountLinker.initialize();
    console.log('✅ Account linker initialized');
    
    // Start periodic cleanup for stopped broadcasts (every hour)
    setInterval(() => {
      automationService.cleanupStoppedBroadcasts();
    }, 60 * 60 * 1000); // 1 hour
    console.log('✅ Broadcast cleanup scheduler started');
    
    // Notify admins of successful startup
    await adminNotifier.notifyEvent('BOT_STARTED', 'Bot started successfully', {});
  } catch (error) {
    logError('Error initializing services:', error);
    // Send startup error to admins
    await adminNotifier.notifyStartupError(error).catch(() => {
      // Silently fail if admin notifier isn't configured
    });
    process.exit(1);
  }
})();

    // Initialize bot
const bot = new TelegramBot(config.botToken, { polling: true });

// Initialize notification service
notificationService.setBot(bot);

// Initialize admin bot (pass main bot instance for admin broadcasts)
initializeAdminBot(bot);
console.log('✅ Admin bot initialized');

console.log('🤖 Bot is running...');

// Store pending inputs
const pendingPhoneNumbers = new Set();
const pendingStartMessages = new Set();
const pendingPasswords = new Set();
const pendingQuietHoursInputs = new Map(); // userId -> { accountId, type: 'start' | 'end' }
const pendingABMessages = new Map(); // userId -> { accountId, variant: 'A' | 'B' }
const pendingScheduleInputs = new Map(); // userId -> { accountId, type: 'schedule' }

// Set the reference in commandHandler so it can set pending state when redirecting to link
setPendingPhoneNumbersReference(pendingPhoneNumbers);

// Pending state timeout (5 minutes)
const PENDING_STATE_TIMEOUT = 5 * 60 * 1000;

// Helper function to add pending state with automatic timeout cleanup
function addPendingStateWithTimeout(setOrMap, userId, data = null) {
  if (setOrMap instanceof Set) {
    setOrMap.add(userId);
  } else if (setOrMap instanceof Map) {
    setOrMap.set(userId, data);
  }
  
  // Set timeout to clear pending state
  setTimeout(() => {
    if (setOrMap instanceof Set) {
      if (setOrMap.has(userId)) {
        setOrMap.delete(userId);
        console.log(`[CLEANUP] Cleared pending state for user ${userId} after timeout (${setOrMap.constructor.name})`);
      }
    } else if (setOrMap instanceof Map) {
      if (setOrMap.has(userId)) {
        setOrMap.delete(userId);
        console.log(`[CLEANUP] Cleared pending state for user ${userId} after timeout (Map)`);
      }
    }
  }, PENDING_STATE_TIMEOUT);
}

// Command handlers
bot.onText(/\/start/, async (msg) => {
  if (!msg.from) {
    console.log('[ERROR] /start command received without from field:', msg);
    return;
  }
  await ensureUserStored(msg);
  await handleStart(bot, msg);
});

// Command shortcuts
bot.onText(/\/send/, async (msg) => {
  if (!msg.from) {
    console.log('[ERROR] /send command received without from field:', msg);
    return;
  }
  await ensureUserStored(msg);
  await handleStartBroadcast(bot, msg);
});

bot.onText(/\/stop/, async (msg) => {
  if (!msg.from) {
    console.log('[ERROR] /stop command received without from field:', msg);
    return;
  }
  await ensureUserStored(msg);
  await handleStopBroadcast(bot, msg);
});

bot.onText(/\/status/, async (msg) => {
  if (!msg.from) {
    console.log('[ERROR] /status command received without from field:', msg);
    return;
  }
  await ensureUserStored(msg);
  await handleStatus(bot, msg);
});

bot.onText(/\/help/, async (msg) => {
  if (!msg.from) {
    console.log('[ERROR] /help command received without from field:', msg);
    return;
  }
  if (!msg.chat || !msg.chat.id) {
    console.log('[ERROR] /help command received without chat.id:', msg);
    return;
  }
  await ensureUserStored(msg);
  
  const helpMessage = `📖 <b>Bot Commands</b>\n\n` +
    `<b>Quick Commands:</b>\n` +
    `/start - Show main menu\n` +
    `/send - Start broadcast\n` +
    `/stop - Stop broadcast\n` +
    `/status - Check status\n` +
    `/help - Show this help\n\n` +
    `<b>Main Features:</b>\n` +
    `• Link multiple accounts\n` +
    `• Set messages\n` +
    `• A/B testing\n` +
    `• Saved message templates\n` +
    `• Group management\n` +
    `• Broadcast statistics\n` +
    `• Configuration settings\n\n` +
    `Use buttons in the menu for full access to all features.`;
  
  await bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'HTML' });
});

// Helper function to check if user is admin
function isAdmin(userId) {
  if (!config.adminIds || config.adminIds.length === 0) {
    return false;
  }
  const userIdStr = userId.toString();
  const userIdNum = parseInt(userId);
  return config.adminIds.includes(userIdStr) || 
         config.adminIds.includes(userIdNum) ||
         config.adminIds.some(id => id.toString() === userIdStr);
}

// Store last admin broadcast message
let lastAdminBroadcast = null;

// Admin broadcast commands
bot.onText(/\/abroadcast(?:\s+(.+))?/, async (msg) => {
  await ensureUserStored(msg);
  
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  console.log(`[ADMIN_BROADCAST] Command received from user ${userId}`);

  // Check if user is admin
  if (!isAdmin(userId)) {
    console.log(`[ADMIN_BROADCAST] Unauthorized access attempt from user ${userId}`);
    await bot.sendMessage(chatId, '❌ You are not authorized to use this command.');
    return;
  }

  // Extract message from command
  const commandText = msg.text || '';
  const match = commandText.match(/\/abroadcast(?:\s+(.+))?/);
  
  if (!match || !match[1] || !match[1].trim()) {
    await bot.sendMessage(
      chatId,
      '❌ Please provide a message to broadcast.\n\nUsage: <code>/abroadcast Your message here</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  try {
    const broadcastMessage = match[1].trim();
    lastAdminBroadcast = broadcastMessage; // Store for /abroadcast_last

    // Send status message
    const statusMsg = await bot.sendMessage(
      chatId,
      '📢 Starting admin broadcast...\n\n⏳ Please wait, this may take a while.',
      { parse_mode: 'HTML' }
    );

    // Get ALL users from ALL tables that might have user_id
    // This includes: users, accounts, logs, audit_logs, pending_verifications
    // This way we can find users even if the users table was cleared
    const allUsersQuery = `
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM users
        UNION
        SELECT user_id FROM accounts WHERE user_id IS NOT NULL
        UNION
        SELECT user_id FROM logs WHERE user_id IS NOT NULL
        UNION
        SELECT user_id FROM audit_logs WHERE user_id IS NOT NULL
        UNION
        SELECT user_id FROM pending_verifications WHERE user_id IS NOT NULL
      ) AS all_users
      ORDER BY user_id
    `;
    
    const users = await db.query(allUsersQuery);
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
      await bot.editMessageText('❌ No users found in database. Users will be added automatically when they interact with the bot.', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
      return;
    }

    console.log(`[ADMIN_BROADCAST] Starting broadcast to ${userIds.length} users (found from all tables: users, accounts, logs, audit_logs, pending_verifications)`);
    let successCount = 0;
    let failedCount = 0;

    // Send message to each user
    for (const targetUserId of userIds) {
      try {
        await bot.sendMessage(targetUserId, broadcastMessage, { parse_mode: 'HTML' });
        successCount++;
        logger.logChange('ADMIN_BROADCAST', userId, `Sent broadcast to user ${targetUserId}`);
      } catch (error) {
        failedCount++;
        // Log but don't stop - continue with other users
        console.log(`[ADMIN_BROADCAST] Failed to send to user ${targetUserId}: ${error.message}`);
        logger.logError('ADMIN_BROADCAST', targetUserId, error, `Failed to send broadcast to user ${targetUserId}`);
      }

      // Small delay to avoid rate limiting (100ms = 10 messages/second, safer than 50ms)
      await new Promise(resolve => setTimeout(resolve, 100));
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
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'HTML',
    });

    logger.logChange('ADMIN_BROADCAST', userId, `Admin broadcast completed. Success: ${successCount}, Failed: ${failedCount}`);
  } catch (error) {
    console.error('[ADMIN_BROADCAST] Error:', error);
    logger.logError('ADMIN_BROADCAST', userId, error, 'Admin broadcast error');
    await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

bot.onText(/\/abroadcast_last/, async (msg) => {
  await ensureUserStored(msg);
  
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  console.log(`[ADMIN_BROADCAST] /abroadcast_last command received from user ${userId}`);

  // Check if user is admin
  if (!isAdmin(userId)) {
    console.log(`[ADMIN_BROADCAST] Unauthorized access attempt from user ${userId}`);
    await bot.sendMessage(chatId, '❌ You are not authorized to use this command.');
    return;
  }

  if (!lastAdminBroadcast) {
    await bot.sendMessage(chatId, '❌ No previous broadcast found. Use /abroadcast <message> first.');
    return;
  }

  try {
    // Send status message
    const statusMsg = await bot.sendMessage(
      chatId,
      '📢 Resending last admin broadcast...\n\n⏳ Please wait, this may take a while.',
      { parse_mode: 'HTML' }
    );

    // Get ALL users from ALL tables that might have user_id
    // This includes: users, accounts, logs, audit_logs, pending_verifications
    // This way we can find users even if the users table was cleared
    const allUsersQuery = `
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM users
        UNION
        SELECT user_id FROM accounts WHERE user_id IS NOT NULL
        UNION
        SELECT user_id FROM logs WHERE user_id IS NOT NULL
        UNION
        SELECT user_id FROM audit_logs WHERE user_id IS NOT NULL
        UNION
        SELECT user_id FROM pending_verifications WHERE user_id IS NOT NULL
      ) AS all_users
      ORDER BY user_id
    `;
    
    const users = await db.query(allUsersQuery);
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
      await bot.editMessageText('❌ No users found in database. Users will be added automatically when they interact with the bot.', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
      return;
    }

    console.log(`[ADMIN_BROADCAST] Resending last broadcast to ${userIds.length} users (found from all tables: users, accounts, logs, audit_logs, pending_verifications)`);
    let successCount = 0;
    let failedCount = 0;

    // Send message to each user
    for (const targetUserId of userIds) {
      try {
        await bot.sendMessage(targetUserId, lastAdminBroadcast, { parse_mode: 'HTML' });
        successCount++;
        logger.logChange('ADMIN_BROADCAST', userId, `Resent broadcast to user ${targetUserId}`);
      } catch (error) {
        failedCount++;
        console.log(`[ADMIN_BROADCAST] Failed to resend to user ${targetUserId}: ${error.message}`);
        logger.logError('ADMIN_BROADCAST', targetUserId, error, `Failed to resend broadcast to user ${targetUserId}`);
      }

      // Small delay to avoid rate limiting (100ms = 10 messages/second, safer than 50ms)
      await new Promise(resolve => setTimeout(resolve, 100));
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
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'HTML',
    });

    logger.logChange('ADMIN_BROADCAST', userId, `Last broadcast resent. Success: ${successCount}, Failed: ${failedCount}`);
  } catch (error) {
    console.error('[ADMIN_BROADCAST] Error:', error);
    logger.logError('ADMIN_BROADCAST', userId, error, 'Resend last broadcast error');
    await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

// Helper function to ensure user is stored in database
async function ensureUserStored(msg) {
  if (msg.from) {
    const userId = msg.from.id;
    const username = msg.from.username || null;
    const firstName = msg.from.first_name || null;
    
    try {
      // Try to get user, if not exists, add them
      const user = await userService.getUser(userId);
      if (!user) {
        await userService.addUser(userId, username, firstName);
        console.log(`[USER] Auto-added user ${userId} from interaction`);
      }
    } catch (error) {
      // Silently fail - don't block the interaction
      console.log(`[USER] Failed to ensure user stored: ${error.message}`);
    }
  }
}

// Handle text input (phone numbers, messages)
bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  // Ensure user is stored in database (for any interaction)
  await ensureUserStored(msg);
  
  // Skip commands
  if (msg.text?.startsWith('/')) {
    return;
  }
  
  // Log all incoming messages for debugging
  console.log(`[MESSAGE HANDLER] User ${userId} sent message: "${msg.text?.substring(0, 50) || 'non-text'}"`);
  console.log(`[MESSAGE HANDLER] Pending states - Phone: ${pendingPhoneNumbers.has(userId)}, StartMsg: ${pendingStartMessages.has(userId)}, Password: ${pendingPasswords.has(userId)}, AB: ${pendingABMessages.has(userId)}, QuietHours: ${pendingQuietHoursInputs.has(userId)}, Schedule: ${pendingScheduleInputs.has(userId)}`);
  
  if (pendingPhoneNumbers.has(userId)) {
    pendingPhoneNumbers.delete(userId);
    
    // Strip all spaces and other whitespace characters from phone number
    // Users might type "+1 234 567 8900" which should be normalized to "+12345678900"
    const phoneNumber = msg.text?.trim().replace(/\s+/g, '');
    
    // Validate phone number format (E.164: + followed by 1-15 digits)
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (phoneNumber && phoneRegex.test(phoneNumber)) {
      await handlePhoneNumber(bot, msg, phoneNumber);
    } else {
      await bot.sendMessage(
        chatId,
        '❌ Invalid phone number format. Please use international format (e.g., +1234567890 or +1 234 567 8900)\n\n💡 <b>Tip:</b> Spaces are automatically removed, just include country code.\n\nTry the "Link Account" button again.',
        { parse_mode: 'HTML', ...createMainMenu() }
      );
    }
  } else if (pendingStartMessages.has(userId)) {
    // Don't delete from pendingStartMessages yet - let handleSetStartMessage handle it
    // This way, if it returns early (e.g., empty message), the state persists for retry
    const result = await handleSetStartMessage(bot, msg);
    // Only remove from pending if message was successfully processed
    if (result === true) {
      pendingStartMessages.delete(userId);
      logger.logChange('MESSAGE_STATE', userId, 'Start message input completed');
    } else {
      logger.logChange('MESSAGE_STATE', userId, 'Start message input still pending (retry needed)');
    }
  } else if (pendingABMessages.has(userId)) {
    const pendingData = pendingABMessages.get(userId);
    if (!pendingData) {
      // Invalid state, clear it
      pendingABMessages.delete(userId);
      console.log(`[MESSAGE HANDLER] Invalid pending AB message state for user ${userId}, cleared`);
      return;
    }
    const { accountId, variant } = pendingData;
    pendingABMessages.delete(userId);
    await handleABMessageInput(bot, msg, accountId, variant);
  } else if (pendingPasswords.has(userId)) {
    pendingPasswords.delete(userId);
    const password = msg.text?.trim();
    if (password) {
      await handlePasswordInput(bot, msg, password);
    } else {
      await bot.sendMessage(
        chatId,
        '❌ Please provide a valid password.\n\nTry the "Link Account" button again.',
        createMainMenu()
      );
    }
  } else if (pendingQuietHoursInputs.has(userId)) {
    const pendingData = pendingQuietHoursInputs.get(userId);
    if (!pendingData || !pendingData.accountId) {
      // Invalid state, clear it
      pendingQuietHoursInputs.delete(userId);
      console.log(`[MESSAGE HANDLER] Invalid pending quiet hours state for user ${userId}, cleared`);
      return;
    }
    const { accountId } = pendingData;
    pendingQuietHoursInputs.delete(userId);
    await handleQuietHoursInput(bot, msg, accountId);
  } else if (pendingScheduleInputs.has(userId)) {
    const pendingData = pendingScheduleInputs.get(userId);
    if (!pendingData || !pendingData.accountId) {
      // Invalid state, clear it
      pendingScheduleInputs.delete(userId);
      console.log(`[MESSAGE HANDLER] Invalid pending schedule state for user ${userId}, cleared`);
      return;
    }
    const { accountId } = pendingData;
    pendingScheduleInputs.delete(userId);
    await handleScheduleInput(bot, msg, accountId);
  } else {
    // Normal message not in any pending state - ignore it
    console.log(`[MESSAGE HANDLER] User ${userId} sent normal message but not in any pending state - ignoring`);
  }
});

// Handle callback queries (buttons, OTP keypad)
bot.on('callback_query', async (callbackQuery) => {
  // Validate callback query structure
  if (!callbackQuery.from || !callbackQuery.from.id) {
    console.log('[ERROR] Callback query received without from field:', callbackQuery);
    return;
  }
  if (!callbackQuery.message || !callbackQuery.message.chat || !callbackQuery.message.chat.id) {
    console.log('[ERROR] Callback query received without message or chat.id:', callbackQuery);
    // Try to answer callback to prevent user waiting
    try {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Error: Invalid callback query',
        show_alert: true,
      });
    } catch (e) {
      // Ignore if callback already expired
    }
    return;
  }
  if (!callbackQuery.data) {
    console.log('[ERROR] Callback query received without data:', callbackQuery);
    try {
      await bot.answerCallbackQuery(callbackQuery.id);
    } catch (e) {
      // Ignore if callback already expired
    }
    return;
  }
  
  // Ensure user is stored in database (for any interaction)
  await ensureUserStored(callbackQuery);
  
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;
  const username = callbackQuery.from.username || 'Unknown';
  const chatId = callbackQuery.message.chat.id;

  // Log every button click (following project rules)
  const buttonName = data.startsWith('otp_') ? `OTP_${data.replace('otp_', '')}` :
                    data.startsWith('switch_account_') ? `Switch Account ${data.replace('switch_account_', '')}` :
                    data.startsWith('delete_account_') ? `Delete Account ${data.replace('delete_account_', '')}` :
                    data === 'btn_main_menu' ? 'Main Menu' :
                    data === 'btn_account' ? 'Account' :
                    data === 'btn_link' ? 'Link Account' :
                    data === 'btn_set_start_msg' ? 'Set Message' :
                    data === 'btn_start_broadcast' ? 'Start Broadcast' :
                    data === 'btn_stop_broadcast' ? 'Stop Broadcast' :
                    data === 'btn_status' ? 'Status' :
                    data === 'btn_switch_account' ? 'Switch Account' :
                    data === 'btn_verify_channel' ? 'Verify Channel' :
                    data === 'btn_groups' ? 'Groups' :
                    data === 'btn_refresh_groups' ? 'Refresh Groups' :
                    data === 'btn_list_groups' ? 'List Groups' :
                    data === 'btn_join_groups' ? 'Join Groups' :
                    data === 'btn_mention' ? 'Mentions' :
                    data === 'stop_broadcast' ? 'Stop Broadcast (Callback)' :
                    data;
  
  logger.logButtonClick(userId, username, buttonName, chatId);

  try {
    if (data.startsWith('otp_')) {
      const result = await handleOTPCallback(bot, callbackQuery);
      if (result === true) {
        addPendingStateWithTimeout(pendingPasswords, userId);
        logger.logChange('PASSWORD_AUTH', userId, 'Password authentication required');
      }
    } else if (data === 'btn_main_menu') {
      // Clear all pending states when returning to main menu
      // userId is already declared above, no need to redeclare
      if (pendingPhoneNumbers.has(userId)) {
        pendingPhoneNumbers.delete(userId);
        console.log(`[CALLBACK] Cleared pending phone number state for user ${userId}`);
      }
      if (pendingStartMessages.has(userId)) {
        pendingStartMessages.delete(userId);
        console.log(`[CALLBACK] Cleared pending start message state for user ${userId}`);
      }
      if (pendingPasswords.has(userId)) {
        pendingPasswords.delete(userId);
        console.log(`[CALLBACK] Cleared pending password state for user ${userId}`);
      }
      if (pendingABMessages.has(userId)) {
        pendingABMessages.delete(userId);
        console.log(`[CALLBACK] Cleared pending AB message state for user ${userId}`);
      }
      if (pendingQuietHoursInputs.has(userId)) {
        pendingQuietHoursInputs.delete(userId);
        console.log(`[CALLBACK] Cleared pending quiet hours state for user ${userId}`);
      }
      if (pendingScheduleInputs.has(userId)) {
        pendingScheduleInputs.delete(userId);
        console.log(`[CALLBACK] Cleared pending schedule state for user ${userId}`);
      }
      await handleMainMenu(bot, callbackQuery);
    } else if (data === 'btn_account') {
      await handleAccountButton(bot, callbackQuery);
    } else if (data === 'btn_link') {
      const result = await handleLinkButton(bot, callbackQuery);
      if (result) {
        addPendingStateWithTimeout(pendingPhoneNumbers, userId);
        logger.logChange('PHONE_INPUT', userId, 'Waiting for phone number input');
      }
    } else if (data === 'btn_set_start_msg') {
      await handleSetStartMessageButton(bot, callbackQuery);
      addPendingStateWithTimeout(pendingStartMessages, userId);
      console.log(`[CALLBACK] User ${userId} clicked "Set Message" - added to pendingStartMessages`);
      logger.logChange('MESSAGE_INPUT', userId, 'Waiting for message input');
    } else if (data === 'btn_start_broadcast') {
      // Note: handleStartBroadcastButton will check and redirect to link account if needed
      // The pending state will be set in that handler
      await handleStartBroadcastButton(bot, callbackQuery);
    } else if (data === 'btn_stop_broadcast') {
      await handleStopBroadcastButton(bot, callbackQuery);
    } else if (data === 'btn_status') {
      await handleStatusButton(bot, callbackQuery);
    } else if (data === 'btn_switch_account') {
      await handleSwitchAccountButton(bot, callbackQuery);
    } else if (data === 'btn_verify_channel') {
      await handleVerifyChannel(bot, callbackQuery);
    } else if (data === 'btn_apply_tags') {
      await handleApplyTags(bot, callbackQuery);
    } else if (data === 'btn_groups') {
      await handleGroupsButton(bot, callbackQuery);
    } else if (data === 'btn_refresh_groups') {
      await handleRefreshGroups(bot, callbackQuery);
    } else if (data === 'btn_list_groups') {
      await handleListGroups(bot, callbackQuery);
    } else if (data === 'btn_config') {
      await handleConfigButton(bot, callbackQuery);
    } else if (data === 'btn_mention') {
      await handleConfigMention(bot, callbackQuery);
    } else if (data === 'btn_config_rate_limit') {
      await handleConfigRateLimit(bot, callbackQuery);
    } else if (data.startsWith('config_rate_')) {
      const preset = data.replace('config_rate_', '');
      await handleConfigRateLimitPreset(bot, callbackQuery, preset);
    } else if (data === 'btn_config_quiet_hours') {
      await handleConfigQuietHours(bot, callbackQuery);
    } else if (data === 'config_quiet_set') {
      const result = await handleQuietHoursSet(bot, callbackQuery);
      if (result) {
        addPendingStateWithTimeout(pendingQuietHoursInputs, userId, result);
      }
    } else if (data === 'config_quiet_view') {
      await handleQuietHoursView(bot, callbackQuery);
    } else if (data === 'config_quiet_clear') {
      await handleQuietHoursClear(bot, callbackQuery);
    } else if (data === 'btn_config_ab') {
      await handleConfigAB(bot, callbackQuery);
    } else if (data.startsWith('config_ab_')) {
      const mode = data.replace('config_ab_', '');
      await handleConfigABMode(bot, callbackQuery, mode);
    } else if (data === 'btn_config_schedule') {
      await handleConfigSchedule(bot, callbackQuery);
    } else if (data === 'config_schedule_normal') {
      const result = await handleScheduleSet(bot, callbackQuery);
      if (result) {
        addPendingStateWithTimeout(pendingScheduleInputs, userId, result);
      }
    } else if (data === 'config_schedule_view') {
      await handleScheduleView(bot, callbackQuery);
    } else if (data === 'config_schedule_clear') {
      await handleScheduleClear(bot, callbackQuery);
    } else if (data === 'btn_mention' || data === 'btn_config_mention') {
      await handleConfigMention(bot, callbackQuery);
    } else if (data === 'config_mention_enable') {
      await handleConfigMentionToggle(bot, callbackQuery, true);
    } else if (data === 'config_mention_disable') {
      await handleConfigMentionToggle(bot, callbackQuery, false);
    } else if (data.startsWith('config_mention_count_')) {
      const count = parseInt(data.replace('config_mention_count_', ''));
      if (isNaN(count) || ![1, 3, 5].includes(count)) {
        await safeAnswerCallback(bot, callbackQuery.id, {
          text: 'Invalid mention count. Must be 1, 3, or 5.',
          show_alert: true,
        });
        return;
      }
      await handleConfigMentionCount(bot, callbackQuery, count);
    } else if (data === 'btn_ab_messages') {
      await handleABMessagesButton(bot, callbackQuery);
    } else if (data === 'ab_set_a') {
      const result = await handleABSetMessage(bot, callbackQuery, 'A');
      if (result) {
        addPendingStateWithTimeout(pendingABMessages, userId, result);
      }
    } else if (data === 'ab_set_b') {
      const result = await handleABSetMessage(bot, callbackQuery, 'B');
      if (result) {
        addPendingStateWithTimeout(pendingABMessages, userId, result);
      }
    } else if (data === 'ab_view_messages') {
      await handleABViewMessages(bot, callbackQuery);
    } else if (data === 'btn_saved_templates') {
      await handleSavedTemplatesButton(bot, callbackQuery);
    } else if (data === 'template_sync') {
      await handleTemplateSync(bot, callbackQuery);
    } else if (data.startsWith('template_select_')) {
      const slot = data.replace('template_select_', '');
      await handleTemplateSelect(bot, callbackQuery, slot);
    } else if (data.startsWith('template_clear_')) {
      const slot = data.replace('template_clear_', '');
      await handleTemplateClear(bot, callbackQuery, slot);
    } else if (data === 'btn_stats') {
      await handleStatsButton(bot, callbackQuery);
    } else if (data === 'stats_top_groups') {
      await handleTopGroups(bot, callbackQuery);
    } else if (data === 'stats_detailed') {
      await handleDetailedStats(bot, callbackQuery);
    } else if (data === 'stats_problematic') {
      await handleProblematicGroups(bot, callbackQuery);
    } else if (data === 'stats_ab') {
      await handleABResults(bot, callbackQuery);
    } else if (data.startsWith('switch_account_')) {
      const accountId = parseInt(data.replace('switch_account_', ''));
      if (isNaN(accountId)) {
        await safeAnswerCallback(bot, callbackQuery.id, {
          text: 'Invalid account ID',
          show_alert: true,
        });
        return;
      }
      await handleSwitchAccount(bot, callbackQuery, accountId);
    } else if (data.startsWith('delete_account_')) {
      const accountId = parseInt(data.replace('delete_account_', ''));
      if (isNaN(accountId)) {
        await safeAnswerCallback(bot, callbackQuery.id, {
          text: 'Invalid account ID',
          show_alert: true,
        });
        return;
      }
      await handleDeleteAccount(bot, callbackQuery, accountId);
    } else if (data === 'stop_broadcast') {
      await handleStopCallback(bot, callbackQuery);
    }
  } catch (error) {
    // Check if it's a "message not modified" error - these should be handled by safeEditMessage
    // But if it still reaches here, handle it gracefully
    const errorMessage = (error.message || error.toString() || '').toLowerCase();
    const isNotModified = 
      errorMessage.includes('message is not modified') ||
      errorMessage.includes('message not modified') ||
      errorMessage.includes('specified new message content and reply markup are exactly the same') ||
      errorMessage.includes('bad request: message is not modified') ||
      (errorMessage.includes('etelegram: 400') && errorMessage.includes('message is not modified'));
    
    if (isNotModified) {
      // This is expected - message content didn't change, just answer the callback silently
      logger.logInfo('CALLBACK_QUERY', `Message not modified for button ${buttonName} - handled gracefully`, userId);
      await safeAnswerCallback(bot, callbackQuery.id);
      return;
    }
    
    // Log other errors
    logger.logError('CALLBACK_QUERY', userId, error, `Button: ${buttonName}`);
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'An error occurred. Please try again.',
      show_alert: true,
    });
  }
});

// Error handling
bot.on('polling_error', (error) => {
  logger.logError('POLLING', null, error, 'Telegram polling error');
});

bot.on('error', (error) => {
  logError('Bot error:', error);
});

// Handle unhandled promise rejections (filter out normal Telegram client errors)
process.on('unhandledRejection', (reason, promise) => {
  // Filter out timeout errors from Telegram client update loop - these are normal
  if (reason && typeof reason === 'object') {
    const errorMessage = reason.message || '';
    const errorStack = reason.stack || '';
    
    // Filter TIMEOUT errors (check both message and stack)
    if (errorMessage === 'TIMEOUT' || 
        (errorMessage.includes('TIMEOUT') && errorStack.includes('telegram/client/updates.js'))) {
      return; // Timeout errors in update loop are expected - don't log as errors
    }
    
    // Filter "Not connected" errors during reconnection
    if (errorMessage === 'Not connected' && errorStack.includes('telegram/network/connection/Connection.js')) {
      return; // Normal reconnection behavior
    }
    
    // Filter connection closed warnings
    if (errorMessage.includes('Connection closed') || errorMessage.includes('connection closed')) {
      return; // Normal connection management
    }
  }
  
  // Log other unhandled rejections
  if (reason instanceof Error) {
    logError('Unhandled Promise Rejection:', reason);
  } else {
    console.error('Unhandled Promise Rejection:', reason);
  }
});

// Handle uncaught exceptions (filter out normal Telegram client errors)
process.on('uncaughtException', (error) => {
  const errorMessage = error.message || '';
  const errorStack = error.stack || '';
  
  // Filter out timeout errors from Telegram client update loop
  if (errorMessage === 'TIMEOUT' || 
      (errorMessage.includes('TIMEOUT') && errorStack.includes('telegram/client/updates.js'))) {
    // Timeout errors in update loop are expected - don't log as errors
    return;
  }
  
  // Filter out connection-related errors from Telegram client - these are normal during reconnections
  // Filter "Not connected" errors during reconnection
  if (errorMessage === 'Not connected' && errorStack.includes('telegram/network/connection/Connection.js')) {
    return; // Normal reconnection behavior
  }
  
  // Filter connection closed warnings
  if (errorMessage.includes('Connection closed') || errorMessage.includes('connection closed')) {
    return; // Normal connection management
  }
  
  logError('Uncaught Exception:', error);
  // Don't exit on uncaught exceptions - let the process continue
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down bot...');
  bot.stopPolling();
  try {
    await Promise.race([
      db.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB close timeout')), 5000))
    ]);
  } catch (error) {
    console.error('Error closing database:', error);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down bot...');
  bot.stopPolling();
  try {
    await Promise.race([
      db.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB close timeout')), 5000))
    ]);
  } catch (error) {
    console.error('Error closing database:', error);
  }
  process.exit(0);
});
