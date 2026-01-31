import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import db from './database/db.js';
import { initializeSchema } from './database/schema.js';
import accountLinker from './services/accountLinker.js';
import messageManager from './services/messageManager.js';
import adminNotifier from './services/adminNotifier.js';
import userService from './services/userService.js';
import automationService from './services/automationService.js';
// Note: automationService is already imported above, using it for blockedUsers tracking
import logger, { colors, logError } from './utils/logger.js';
import { safeAnswerCallback } from './utils/safeEdit.js';
import { isFloodWaitError, extractWaitTime, waitForFloodError, safeBotApiCall } from './utils/floodWaitHandler.js';
import { validateUserId, validateAccountId, sanitizeCallbackData, validateCallbackData, sanitizeErrorMessage, adminCommandRateLimiter, verifyAccountOwnership, sanitizeString } from './utils/security.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCK_FILE = path.join(__dirname, '..', '.bot.lock');

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
  
  // Filter out Telegram client flood wait info logs (these are normal and expected)
  if (
    message.includes('Sleeping for') && 
    message.includes('on flood wait') ||
    message.includes('[INFO]') && 
    message.includes('flood wait') &&
    message.includes('messages.GetDialogs')
  ) {
    return; // Suppress these normal flood wait handling logs from Telegram library
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
  let isBinaryReaderError = false;
  
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
      
      // Check for BinaryReader errors (recoverable MTProto errors)
      if (errorMessage.includes('readUInt32LE') || 
          errorMessage.includes('BinaryReader') || 
          errorMessage.includes('Cannot read properties of undefined') ||
          (errorStack && errorStack.includes('BinaryReader'))) {
        isBinaryReaderError = true;
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
  
  // If it's a BinaryReader error, suppress it (recoverable MTProto errors)
  if (isBinaryReaderError) {
    return; // Suppress these recoverable MTProto errors
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
  
  // Filter out BinaryReader errors (recoverable MTProto errors)
  if (message.includes('readUInt32LE') || 
      message.includes('BinaryReader') || 
      message.includes('Cannot read properties of undefined') ||
      (message.includes('BinaryReader') && message.includes('MTProtoSender'))) {
    return; // Suppress these recoverable MTProto errors
  }
  
  // Filter out "Unhandled error while receiving data" messages that contain BinaryReader errors
  if (message.includes('Unhandled error while receiving data') && 
      (message.includes('BinaryReader') || message.includes('readUInt32LE') || message.includes('Cannot read properties of undefined'))) {
    return; // Suppress these recoverable MTProto errors
  }
  
  // Filter out BinaryReader errors in any format (including "[ERROR] - [Unhandled error while receiving data]")
  // This catches errors logged by the Telegram library itself
  if (message.includes('readUInt32LE') || 
      (message.includes('BinaryReader') && (message.includes('MTProtoSender') || message.includes('BinaryReader.readInt')))) {
    return; // Suppress these recoverable MTProto errors
  }
  
  // Catch the specific error format: "[ERROR] - [Unhandled error while receiving data]" followed by BinaryReader error
  if ((message.includes('[ERROR]') || message.includes('ERROR')) && 
      message.includes('Unhandled error while receiving data')) {
    // Check if any of the args contain BinaryReader error details
    for (const arg of args) {
      if (arg instanceof Error) {
        const argMsg = arg.message || '';
        const argStack = arg.stack || '';
        if (argMsg.includes('readUInt32LE') || 
            argMsg.includes('BinaryReader') ||
            argStack.includes('BinaryReader')) {
          return; // Suppress these recoverable MTProto errors
        }
      } else if (typeof arg === 'string' && 
                 (arg.includes('readUInt32LE') || arg.includes('BinaryReader'))) {
        return; // Suppress these recoverable MTProto errors
      }
    }
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
  
  // Additional filter: Catch "[ERROR] - [Unhandled error while receiving data]" with BinaryReader errors
  if (message.includes('[ERROR]') && 
      message.includes('Unhandled error while receiving data') &&
      (message.includes('BinaryReader') || message.includes('readUInt32LE') || message.includes('Cannot read properties of undefined'))) {
    return; // Suppress these recoverable MTProto errors
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
  handleMessagesMenu,
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
  handleMessagePoolButton,
  handlePoolAddMessage,
  handlePoolMessageInput,
  handlePoolViewMessages,
  handlePoolDeleteMessage,
  handlePoolModeChange,
  handlePoolToggle,
  handlePoolClear,
  handleApplyTags,
  handlePremium,
  handlePremiumFAQ,
  handlePremiumBenefits,
  handleLoginSharePhone,
  handleSharePhoneConfirm,
  handleLoginTypePhone,
  handleLoginCancel,
  handleCheckPaymentStatus,
} from './handlers/commandHandler.js';
import {
  handleConfigButton,
  handleIntervalMenu,
  handleConfigCustomInterval,
  handleCustomIntervalInput,
  handleConfigGroupDelay,
  handleGroupDelayInput,
  handleConfigForwardMode,
  handleConfigQuietHours,
  handleQuietHoursSet,
  handleQuietHoursView,
  handleQuietHoursClear,
  handleQuietHoursInput,
  handleConfigSchedule,
  handleScheduleSet,
  handleScheduleView,
  handleScheduleClear,
  handleScheduleInput,
  handleConfigMention,
  handleConfigMentionToggle,
  handleConfigMentionCount,
  handleConfigGroupBlacklist,
  handleBlacklistSearch,
  handleBlacklistSearchInput,
  handleBlacklistAdd,
  handleBlacklistView,
  handleBlacklistRemove,
  handleAutoReplyMenu,
  handleConfigAutoReplyDm,
  handleAutoReplyDmToggle,
  handleAutoReplyDmSetMessage,
  handleAutoReplyDmMessageInput,
  handleConfigAutoReplyGroups,
  handleAutoReplyGroupsToggle,
  handleAutoReplyGroupsSetMessage,
  handleAutoReplyGroupsMessageInput,
  handleAutoReplySetInterval,
  handleAutoReplyIntervalSelect,
  handleAutoReplyIntervalCustom,
  handleAutoReplyIntervalInput,
} from './handlers/configHandlers.js';
import {
  handleStatsButton,
  handleStatsPeriod,
  handleTopGroups,
  handleDetailedStats,
  handleProblematicGroups,
  handleABResults,
  handleStatsTrends,
} from './handlers/statsHandlers.js';
import notificationService from './services/notificationService.js';
import channelVerificationService from './services/channelVerificationService.js';
import { initializeAdminBot } from './handlers/adminBotHandlers.js';
import { createMainMenu, createBackButton } from './handlers/keyboardHandler.js';
import express from 'express';
import paymentVerificationService from './services/paymentVerificationService.js';
import premiumService from './services/premiumService.js';

// Environment validation
function validateEnvironment() {
  const required = ['BOT_TOKEN', 'API_ID', 'API_HASH'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  
  // SQLite doesn't require database connection settings
  // DB_PATH is optional (defaults to ./data/bot.db)
  
  console.log('✅ Environment validation passed');
}

// Process lock to prevent multiple instances
function checkProcessLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      // Check if the process in the lock file is still running
      const lockContent = fs.readFileSync(LOCK_FILE, 'utf8');
      const lockData = JSON.parse(lockContent);
      const lockPid = lockData.pid;
      
      try {
        // Check if process is still running (Unix/Mac)
        process.kill(lockPid, 0); // Signal 0 doesn't kill, just checks if process exists
        // Process is still running - another instance exists
        console.error('❌ Another bot instance is already running (PID: ' + lockPid + ')');
        console.error('   Please stop the existing instance before starting a new one.');
        console.error('   If the process is stuck, delete the lock file: ' + LOCK_FILE);
        process.exit(1);
      } catch (error) {
        // Process doesn't exist - stale lock file, remove it
        console.log('⚠️  Found stale lock file (process ' + lockPid + ' not running). Removing...');
        fs.unlinkSync(LOCK_FILE);
      }
    }
    
    // Create lock file
    const lockData = {
      pid: process.pid,
      started: new Date().toISOString()
    };
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lockData, null, 2));
    console.log('✅ Process lock acquired (PID: ' + process.pid + ')');
    
    // Clean up lock file on exit
    const cleanupLock = () => {
      try {
        if (fs.existsSync(LOCK_FILE)) {
          fs.unlinkSync(LOCK_FILE);
          console.log('✅ Process lock released');
        }
      } catch (error) {
        // Ignore errors during cleanup
      }
    };
    
    process.on('exit', cleanupLock);
    process.on('SIGINT', cleanupLock);
    process.on('SIGTERM', cleanupLock);
    process.on('SIGUSR2', cleanupLock);
    process.on('uncaughtException', (error) => {
      cleanupLock();
      throw error;
    });
  } catch (error) {
    console.error('❌ Error managing process lock:', error);
    process.exit(1);
  }
}

// Initialize database, schema, and services
(async () => {
  try {
    // Check for process lock first
    checkProcessLock();
    
    // Validate environment variables first
    validateEnvironment();
    
    console.log(`🚀 Starting bot in ${process.env.NODE_ENV || 'development'} mode...`);
    console.log(`📅 Started at: ${new Date().toISOString()}`);
    
    // Initialize admin notifier first (for error notifications)
    await adminNotifier.initialize();
    
    // Initialize database connection
    console.log('[INIT] Connecting to database...');
    await db.connect();
    
    // Initialize database schema
    console.log('[INIT] Initializing database schema...');
    await initializeSchema();
    
    // Initialize message manager
    console.log('[INIT] Initializing message manager...');
    await messageManager.initialize();
    console.log('✅ Message manager initialized');
    
    // Initialize account linker
    console.log('[INIT] Initializing account linker...');
    await accountLinker.initialize();
    console.log('✅ Account linker initialized');
    
    // Auto-reply interval service disabled - using real-time mode only
    console.log('[INIT] Auto-reply using real-time mode (interval service disabled)');
    
    // Start auto-reply connection manager (keeps clients connected for real-time auto-reply)
    console.log('[INIT] Starting auto-reply connection manager...');
    const autoReplyConnectionManager = (await import('./services/autoReplyConnectionManager.js')).default;
    autoReplyConnectionManager.start();
    console.log('✅ Auto-reply connection manager started');
    
    // Start periodic cleanup for stopped broadcasts (every hour)
    setInterval(() => {
      automationService.cleanupStoppedBroadcasts();
    }, 60 * 60 * 1000); // 1 hour
    console.log('✅ Broadcast cleanup scheduler started');
    
    // Start periodic cleanup for anti-freeze tracking (every 6 hours)
    setInterval(() => {
      automationService.cleanupAntiFreezeTracking();
    }, 6 * 60 * 60 * 1000); // 6 hours
    console.log('✅ Anti-freeze tracking cleanup scheduler started');
    
    // Start periodic cleanup for blocked users (every 12 hours)
    setInterval(() => {
      automationService.cleanupBlockedUsers();
    }, 12 * 60 * 60 * 1000); // 12 hours
    console.log('✅ Blocked users cleanup scheduler started');
    
    // Start periodic cleanup for pending verifications (every 30 minutes)
    setInterval(() => {
      accountLinker.cleanupPendingVerifications();
    }, 30 * 60 * 1000); // 30 minutes
    console.log('✅ Pending verifications cleanup scheduler started');
    
    // Start memory monitoring (every hour)
    setInterval(() => {
      const memUsage = process.memoryUsage();
      const memUsageMB = {
        rss: Math.round(memUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024)
      };
      
      console.log(`[MEMORY MONITOR] RSS: ${memUsageMB.rss}MB, Heap: ${memUsageMB.heapUsed}/${memUsageMB.heapTotal}MB`);
      
      // Warn if memory usage is very high (more than 2.5GB)
      if (memUsageMB.rss > 2500) {
        console.warn(`[MEMORY WARNING] High memory usage: ${memUsageMB.rss}MB. Consider restarting the bot if it exceeds 3GB.`);
        // Try to force garbage collection if available
        if (global.gc) {
          console.log('[MEMORY] Running garbage collection...');
          global.gc();
        }
      }
    }, 60 * 60 * 1000); // 1 hour
    console.log('✅ Memory monitoring started');
    
    // Notify admins of successful startup
    await adminNotifier.notifyEvent('BOT_STARTED', 'Bot started successfully', {
      mode: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    });
    
    console.log('✅ All services initialized successfully');
  } catch (error) {
    logError('❌ Error initializing services:', error);
    
    // Check if it's a database connection error
    const isDbError = 
      error.message?.includes('ECONNREFUSED') ||
      error.message?.includes('Connection refused') ||
      error.code === 'ECONNREFUSED' ||
      error.message?.includes('Connection terminated') ||
      error.message?.includes('Connection closed');
    
    if (isDbError) {
      console.error('');
      console.error('═══════════════════════════════════════════════════════');
      console.error('❌ DATABASE CONNECTION FAILED');
      console.error('═══════════════════════════════════════════════════════');
      console.error('');
      console.error('The bot cannot connect to SQLite database.');
      console.error('');
      console.error('Troubleshooting steps:');
      console.error('1. Check if the database directory exists and is writable:');
      console.error('   mkdir -p ./data');
      console.error('   chmod 755 ./data');
      console.error('');
      console.error('2. Verify database path in .env file (optional):');
      console.error('   DB_PATH=./data/bot.db (defaults to ./data/bot.db if not set)');
      console.error('');
      console.error('3. Check file permissions:');
      console.error('   ls -la ./data/bot.db');
      console.error('');
      console.error('═══════════════════════════════════════════════════════');
      console.error('');
    }
    
    // Send startup error to admins
    await adminNotifier.notifyStartupError(error).catch(() => {
      // Silently fail if admin notifier isn't configured
    });
    
    console.error('❌ Failed to start bot. Exiting...');
    
    // For database errors, exit with code 2 to distinguish from other errors
    // PM2 can be configured to not restart on exit code 2
    process.exit(isDbError ? 2 : 1);
  }
})();

// Initialize bot with polling (autoStart: false so we can delete webhook first)
const bot = new TelegramBot(config.botToken, { 
  polling: {
    interval: 300, // Polling interval in milliseconds
    autoStart: false, // We'll start after deleting webhook if needed
    params: {
      timeout: 10, // Long polling timeout in seconds
      allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member']
    }
  }
});

// Delete any existing webhook before starting polling
(async () => {
  try {
    // Use safeBotApiCall to handle potential floodwait errors during startup
    await safeBotApiCall(
      () => bot.deleteWebHook({ drop_pending_updates: false }),
      { maxRetries: 3, bufferSeconds: 1, throwOnFailure: false }
    );
    console.log('✅ Deleted any existing webhook');
  } catch (error) {
    // Check if it's a floodwait error
    if (isFloodWaitError(error)) {
      const waitSeconds = extractWaitTime(error);
      console.warn(`[FLOOD_WAIT] ⚠️ Rate limited while deleting webhook. Waiting ${waitSeconds + 1}s...`);
      await waitForFloodError(error, 1);
      // Retry once
      try {
        await bot.deleteWebHook({ drop_pending_updates: false });
        console.log('✅ Deleted any existing webhook (after retry)');
      } catch (retryError) {
        console.log('ℹ️ No existing webhook to delete (or error deleting):', retryError.message);
      }
    } else {
      // Ignore other errors - webhook might not exist
      console.log('ℹ️ No existing webhook to delete (or error deleting):', error.message);
    }
  }
  
  // Start polling
  try {
    await bot.startPolling();
    console.log('✅ Polling started');
  } catch (error) {
    // Check if it's a floodwait error during polling start
    if (isFloodWaitError(error)) {
      const waitSeconds = extractWaitTime(error);
      console.error(`[FLOOD_WAIT] ⚠️ Rate limited while starting polling. Waiting ${waitSeconds + 1}s before retry...`);
      await waitForFloodError(error, 1);
      // Retry starting polling
      await bot.startPolling();
      console.log('✅ Polling started (after retry)');
    } else {
      throw error; // Re-throw non-floodwait errors
    }
  }
})();

// Initialize notification service
notificationService.setBot(bot);

// Initialize channel verification service (monitors users leaving channels)
channelVerificationService.initialize(bot);
console.log('✅ Channel verification service initialized');

// Initialize admin bot (pass main bot instance for admin broadcasts)
initializeAdminBot(bot);
console.log('✅ Admin bot initialized');

// Handle chat_member updates (when users leave/join channels) - for polling mode
bot.on('chat_member', async (msg) => {
  try {
    const chatMemberUpdate = msg;
    const chat = chatMemberUpdate.chat;
    const newMember = chatMemberUpdate.new_chat_member;
    const oldMember = chatMemberUpdate.old_chat_member;
    const user = newMember?.user || chatMemberUpdate.from;
    
    if (chat && user && newMember && oldMember) {
      const chatId = chat.id;
      const userId = user.id;
      const newStatus = newMember.status;
      const oldStatus = oldMember.status;
      
      // Check if user left the channel (status changed to 'left' or 'kicked')
      const userLeft = (newStatus === 'left' || newStatus === 'kicked') && 
                       (oldStatus === 'member' || oldStatus === 'administrator' || oldStatus === 'creator');
      
      if (userLeft) {
        // Check if this is a channel (negative ID means channel/supergroup)
        const isChannel = chatId < 0;
        
        if (isChannel) {
          // Get channel username
          const channelUsername = chat.username;
          
          // Check if this is one of the required updates channels
          const updatesChannels = config.getUpdatesChannels();
          if (updatesChannels.length > 0) {
            const channelUsernames = updatesChannels.map(ch => ch.replace('@', '').toLowerCase());
            const normalizedUsername = channelUsername ? channelUsername.toLowerCase() : null;
            
            if (normalizedUsername && channelUsernames.includes(normalizedUsername)) {
              // User left a required channel - process in background
              channelVerificationService.handleUserLeftChannel(userId, channelUsername).catch(error => {
                console.error(`[CHANNEL_LEAVE] Error handling user leave:`, error.message);
              });
            }
          }
        }
      }
    }
  } catch (error) {
    // Log error but don't block update processing
    console.error('[CHANNEL_LEAVE] Error processing chat_member update:', error.message);
  }
});

console.log('🤖 Bot is running with polling...');

// Store pending inputs
const pendingPhoneNumbers = new Set();
const pendingStartMessages = new Set();
const pendingPasswords = new Set();
const pendingQuietHoursInputs = new Map(); // userId -> { accountId, type: 'start' | 'end' }
const pendingPoolMessages = new Map(); // userId -> { accountId }
const pendingScheduleInputs = new Map(); // userId -> { accountId, type: 'schedule' }
const pendingCustomIntervalInputs = new Map(); // userId -> { accountId }
const pendingGroupDelayInputs = new Map(); // userId -> { accountId }
const pendingBlacklistSearchInputs = new Map(); // userId -> { accountId }
const pendingAutoReplyDmMessageInputs = new Map(); // userId -> { accountId }
const pendingAutoReplyGroupsMessageInputs = new Map(); // userId -> { accountId }
const pendingAutoReplyIntervalInputs = new Map(); // userId -> { accountId }

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
  
  const userId = validateUserId(msg.from?.id);
  if (!userId) {
    console.log('[ADMIN_BROADCAST] Invalid user ID');
    return;
  }
  
  const chatId = msg.chat?.id;
  if (!chatId) {
    console.log('[ADMIN_BROADCAST] Invalid chat ID');
    return;
  }

  console.log(`[ADMIN_BROADCAST] Command received from user ${userId}`);

  // SECURITY: Check if user is admin
  if (!isAdmin(userId)) {
    console.log(`[ADMIN_BROADCAST] Unauthorized access attempt from user ${userId}`);
    await bot.sendMessage(chatId, '❌ You are not authorized to use this command.');
    return;
  }

  // SECURITY: Rate limiting for admin commands
  const rateLimit = adminCommandRateLimiter.checkRateLimit(userId, 5, 60000); // 5 commands per minute
  if (!rateLimit.allowed) {
    console.log(`[ADMIN_BROADCAST] Rate limit exceeded for user ${userId}`);
    await bot.sendMessage(
      chatId,
      `⏳ Rate limit exceeded. Please wait ${Math.ceil(rateLimit.resetIn / 1000)} seconds before trying again.`,
      { parse_mode: 'HTML' }
    );
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

    // CRITICAL: Only send to users who have actually interacted with the bot
    // Telegram ToS prohibits sending unsolicited messages to users who haven't started the bot
    // ONLY include users from 'users' table (users who have used /start)
    // DO NOT include users from 'accounts' table - they may have linked accounts without using /start
    // DO NOT send to users from logs/audit_logs/pending_verifications as they may have never interacted
    // This is CRITICAL to prevent bot deletion by Telegram for ToS violations
    const allUsersQuery = `
      SELECT DISTINCT user_id FROM users
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

    console.log(`[ADMIN_BROADCAST] Starting broadcast to ${userIds.length} users (only users who have interacted with bot)`);
    let successCount = 0;
    let failedCount = 0;

    // CRITICAL: Rate limiting for admin broadcasts
    // Telegram allows ~30 messages/second, but we use ULTRA-CONSERVATIVE limits to prevent bot deletion
    // Reduced to 10 messages/minute (1 per 6 seconds) to stay well below limits and avoid spam detection
    const MIN_DELAY_BETWEEN_MESSAGES = 6000; // 6 seconds between messages (10 messages/minute max) - INCREASED for safety
    const MAX_MESSAGES_PER_MINUTE = 10; // Ultra-conservative limit (reduced from 20)
    
    // Track messages sent in the last minute
    const messageTimestamps = [];
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Send message to each user with proper rate limiting
    for (const targetUserId of userIds) {
      try {
        // Check rate limit: don't exceed MAX_MESSAGES_PER_MINUTE
        const recentMessages = messageTimestamps.filter(ts => ts > oneMinuteAgo);
        if (recentMessages.length >= MAX_MESSAGES_PER_MINUTE) {
          // Calculate wait time until oldest message is 1 minute old
          const oldestMessage = Math.min(...recentMessages);
          const waitTime = 60000 - (now - oldestMessage) + 1000; // Add 1 second buffer
          console.log(`[ADMIN_BROADCAST] Rate limit reached (${recentMessages.length}/${MAX_MESSAGES_PER_MINUTE} messages in last minute). Waiting ${(waitTime / 1000).toFixed(1)}s...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          // Update timestamps after waiting
          const newNow = Date.now();
          const newOneMinuteAgo = newNow - 60000;
          messageTimestamps.splice(0, messageTimestamps.length, ...messageTimestamps.filter(ts => ts > newOneMinuteAgo));
        }

        // CRITICAL: Check if user has blocked the bot (prevent sending to blocked users)
        if (automationService.blockedUsers.has(targetUserId)) {
          const blockedInfo = automationService.blockedUsers.get(targetUserId);
          // Re-check if blocked status is recent (within 24 hours)
          if (blockedInfo && blockedInfo.lastChecked && (Date.now() - blockedInfo.lastChecked) < (24 * 60 * 60 * 1000)) {
            console.log(`[ADMIN_BROADCAST] Skipping user ${targetUserId} - previously blocked`);
            failedCount++;
            continue;
          }
        }

        // Use safeBotApiCall to properly handle flood waits
        const sendResult = await safeBotApiCall(
          () => bot.sendMessage(targetUserId, broadcastMessage, { parse_mode: 'HTML' }),
          { maxRetries: 3, bufferSeconds: 2, throwOnFailure: false }
        );

        if (sendResult) {
          successCount++;
          messageTimestamps.push(Date.now());
          logger.logChange('ADMIN_BROADCAST', userId, `Sent broadcast to user ${targetUserId}`);
          
          // CRITICAL: Remove from blocked list if send succeeded
          if (automationService.blockedUsers.has(targetUserId)) {
            automationService.blockedUsers.delete(targetUserId);
          }
        } else {
          failedCount++;
          console.log(`[ADMIN_BROADCAST] Failed to send to user ${targetUserId} after retries`);
          logger.logError('ADMIN_BROADCAST', targetUserId, new Error('Failed after retries'), `Failed to send broadcast to user ${targetUserId}`);
        }
      } catch (error) {
        failedCount++;
        
        // CRITICAL: Check if user blocked the bot
        const errorMessage = error.message || error.toString() || '';
        const errorCode = error.code || error.errorCode || error.response?.error_code || 'N/A';
        const isBotBlocked = errorMessage.includes('bot was blocked') ||
                            errorMessage.includes('bot blocked') ||
                            errorMessage.includes('BLOCKED') ||
                            errorCode === 403 && (errorMessage.includes('blocked') || errorMessage.includes('forbidden')) ||
                            errorMessage.includes('chat not found');
        
        if (isBotBlocked) {
          // CRITICAL: Mark user as blocked to prevent future sends
          automationService.blockedUsers.set(targetUserId, {
            blocked: true,
            lastChecked: Date.now()
          });
          console.log(`[ADMIN_BROADCAST] User ${targetUserId} has blocked the bot - added to blocked list`);
        }
        
        // Log but don't stop - continue with other users
        console.log(`[ADMIN_BROADCAST] Failed to send to user ${targetUserId}: ${error.message}`);
        logger.logError('ADMIN_BROADCAST', targetUserId, error, `Failed to send broadcast to user ${targetUserId}`);
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
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'HTML',
    });

    logger.logChange('ADMIN_BROADCAST', userId, `Admin broadcast completed. Success: ${successCount}, Failed: ${failedCount}`);
  } catch (error) {
    console.error('[ADMIN_BROADCAST] Error:', error);
    logger.logError('ADMIN_BROADCAST', userId, error, 'Admin broadcast error');
    // SECURITY: Sanitize error message to prevent information leakage
    const safeErrorMessage = sanitizeErrorMessage(error, false);
    await bot.sendMessage(chatId, `❌ Error: ${safeErrorMessage}`);
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

    // CRITICAL: Only send to users who have actually interacted with the bot
    // Telegram ToS prohibits sending unsolicited messages to users who haven't started the bot
    // ONLY include users from 'users' table (users who have used /start)
    // DO NOT include users from 'accounts' table - they may have linked accounts without using /start
    // DO NOT send to users from logs/audit_logs/pending_verifications as they may have never interacted
    // This is CRITICAL to prevent bot deletion by Telegram for ToS violations
    const allUsersQuery = `
      SELECT DISTINCT user_id FROM users
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

    console.log(`[ADMIN_BROADCAST] Resending last broadcast to ${userIds.length} users (only users who have interacted with bot)`);
    let successCount = 0;
    let failedCount = 0;

    // CRITICAL: Rate limiting for admin broadcasts
    // Telegram allows ~30 messages/second, but we use ULTRA-CONSERVATIVE limits to prevent bot deletion
    // Reduced to 10 messages/minute (1 per 6 seconds) to stay well below limits and avoid spam detection
    const MIN_DELAY_BETWEEN_MESSAGES = 6000; // 6 seconds between messages (10 messages/minute max) - INCREASED for safety
    const MAX_MESSAGES_PER_MINUTE = 10; // Ultra-conservative limit (reduced from 20)
    
    // Track messages sent in the last minute
    const messageTimestamps = [];
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Send message to each user with proper rate limiting
    for (const targetUserId of userIds) {
      try {
        // Check rate limit: don't exceed MAX_MESSAGES_PER_MINUTE
        const recentMessages = messageTimestamps.filter(ts => ts > oneMinuteAgo);
        if (recentMessages.length >= MAX_MESSAGES_PER_MINUTE) {
          // Calculate wait time until oldest message is 1 minute old
          const oldestMessage = Math.min(...recentMessages);
          const waitTime = 60000 - (now - oldestMessage) + 1000; // Add 1 second buffer
          console.log(`[ADMIN_BROADCAST] Rate limit reached (${recentMessages.length}/${MAX_MESSAGES_PER_MINUTE} messages in last minute). Waiting ${(waitTime / 1000).toFixed(1)}s...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          // Update timestamps after waiting
          const newNow = Date.now();
          const newOneMinuteAgo = newNow - 60000;
          messageTimestamps.splice(0, messageTimestamps.length, ...messageTimestamps.filter(ts => ts > newOneMinuteAgo));
        }

        // Use safeBotApiCall to properly handle flood waits
        const sendResult = await safeBotApiCall(
          () => bot.sendMessage(targetUserId, lastAdminBroadcast, { parse_mode: 'HTML' }),
          { maxRetries: 3, bufferSeconds: 2, throwOnFailure: false }
        );

        if (sendResult) {
          successCount++;
          messageTimestamps.push(Date.now());
          logger.logChange('ADMIN_BROADCAST', userId, `Resent broadcast to user ${targetUserId}`);
        } else {
          failedCount++;
          console.log(`[ADMIN_BROADCAST] Failed to resend to user ${targetUserId} after retries`);
          logger.logError('ADMIN_BROADCAST', targetUserId, new Error('Failed after retries'), `Failed to resend broadcast to user ${targetUserId}`);
        }
        } catch (error) {
          failedCount++;
          
          // CRITICAL: Check if user blocked the bot
          const errorMessage = error.message || error.toString() || '';
          const errorCode = error.code || error.errorCode || error.response?.error_code || 'N/A';
          const isBotBlocked = errorMessage.includes('bot was blocked') ||
                              errorMessage.includes('bot blocked') ||
                              errorMessage.includes('BLOCKED') ||
                              errorCode === 403 && (errorMessage.includes('blocked') || errorMessage.includes('forbidden')) ||
                              errorMessage.includes('chat not found');
          
          if (isBotBlocked) {
            // CRITICAL: Mark user as blocked to prevent future sends
            automationService.blockedUsers.set(targetUserId, {
              blocked: true,
              lastChecked: Date.now()
            });
            console.log(`[ADMIN_BROADCAST] User ${targetUserId} has blocked the bot - added to blocked list`);
          }
          
          console.log(`[ADMIN_BROADCAST] Failed to resend to user ${targetUserId}: ${error.message}`);
          logger.logError('ADMIN_BROADCAST', targetUserId, error, `Failed to resend broadcast to user ${targetUserId}`);
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
  console.log(`[MESSAGE HANDLER] Pending states - Phone: ${pendingPhoneNumbers.has(userId)}, StartMsg: ${pendingStartMessages.has(userId)}, Password: ${pendingPasswords.has(userId)}, Pool: ${pendingPoolMessages.has(userId)}, QuietHours: ${pendingQuietHoursInputs.has(userId)}, Schedule: ${pendingScheduleInputs.has(userId)}, CustomInterval: ${pendingCustomIntervalInputs.has(userId)}`);
  
  // Handle contact sharing (phone number via button)
  if (msg.contact && msg.contact.phone_number) {
    const phoneNumber = msg.contact.phone_number;
    // Ensure phone number has + prefix
    const normalizedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    logger.logChange('PHONE_SHARE', userId, 'Phone number shared via contact button');
    
    // Remove the keyboard
    await bot.sendMessage(chatId, '✅ Phone number received! Processing...', {
      reply_markup: {
        remove_keyboard: true,
      },
    });
    
    await handlePhoneNumber(bot, msg, normalizedPhone);
    return;
  }
  
  if (pendingPhoneNumbers.has(userId)) {
    pendingPhoneNumbers.delete(userId);
    
    // SECURITY: Sanitize and validate phone number input
    const rawPhoneNumber = msg.text?.trim() || '';
    const sanitizedPhone = sanitizeString(rawPhoneNumber, 20); // Max 20 chars for phone
    
    // Strip all spaces, dashes, parentheses, and other formatting characters
    // Users might type "+1 234 567 8900", "+1-234-567-8900", or "(+1) 234 567 8900"
    let phoneNumber = sanitizedPhone.replace(/[\s\-\(\)\.]/g, '');
    
    // If phone number doesn't start with +, try to add it
    // Some users might enter "1234567890" or "1 234 567 8900"
    if (phoneNumber && !phoneNumber.startsWith('+')) {
      // If it starts with a digit, add +
      if (/^\d/.test(phoneNumber)) {
        phoneNumber = '+' + phoneNumber;
      }
    }
    
    // Validate phone number format (E.164: + followed by 1-15 digits, first digit after + should be 1-9)
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (phoneNumber && phoneRegex.test(phoneNumber)) {
      await handlePhoneNumber(bot, msg, phoneNumber);
    } else {
      // Provide more helpful error message
      let errorMsg = '❌ Invalid phone number format.\n\n';
      errorMsg += 'Please use international format:\n';
      errorMsg += '• Must start with +\n';
      errorMsg += '• Followed by country code and number\n';
      errorMsg += '• Examples: +1234567890, +1 234 567 8900, +919876543210\n\n';
      errorMsg += 'Your input: ' + (msg.text || 'empty') + '\n\n';
      errorMsg += 'Try the "Link Account" button again.';
      
      await bot.sendMessage(
        chatId,
        errorMsg,
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
  } else if (pendingPoolMessages.has(userId)) {
    const pendingData = pendingPoolMessages.get(userId);
    if (!pendingData) {
      pendingPoolMessages.delete(userId);
      console.log(`[MESSAGE HANDLER] Invalid pending pool message state for user ${userId}, cleared`);
      return;
    }
    const { accountId } = pendingData;
    pendingPoolMessages.delete(userId);
    await handlePoolMessageInput(bot, msg, accountId);
  } else if (pendingPasswords.has(userId) || accountLinker.isPasswordRequired(userId)) {
    // Only remove from pendingPasswords if password is successfully verified
    // Keep it if verification fails so user can retry
    const password = msg.text?.trim();
    if (password) {
      const result = await handlePasswordInput(bot, msg, password);
      // Only remove pending state if password was successful or max attempts/cooldown reached
      if (result && (result.success || result.maxAttemptsReached)) {
        pendingPasswords.delete(userId);
      }
    } else {
      await bot.sendMessage(
        chatId,
        '❌ Please provide a valid password.\n\nTry the "Link Account" button again.',
        createMainMenu()
      );
      // Don't remove pending state for invalid input, allow retry
    }
  } else if (accountLinker.isWebLoginPasswordRequired(userId)) {
    // Check if 2FA is needed for web login
    const notification = accountLinker.getWebLoginPasswordNotification(userId);
    const password = msg.text?.trim();
    
    if (password) {
      // User sent password, handle it
      await handlePasswordInput(bot, msg, password);
    } else if (notification && !notification.notified) {
      // Notify user that 2FA password is needed (only once)
      await bot.sendMessage(
        notification.chatId,
        '🔐 <b>2FA Password Required</b>\n\n🔒 Your account has two-factor authentication enabled.\n\nPlease enter your 2FA password to complete the login:',
        { parse_mode: 'HTML' }
      );
      accountLinker.markWebLoginPasswordNotified(userId);
      addPendingStateWithTimeout(pendingPasswords, userId);
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
  } else if (pendingGroupDelayInputs.has(userId)) {
    const pendingData = pendingGroupDelayInputs.get(userId);
    if (!pendingData || !pendingData.accountId) {
      // Invalid state, clear it
      pendingGroupDelayInputs.delete(userId);
      return;
    }
    const accountId = pendingData.accountId;
    const result = await handleGroupDelayInput(bot, msg, accountId);
    if (result) {
      pendingGroupDelayInputs.delete(userId);
    }
  } else if (pendingCustomIntervalInputs.has(userId)) {
    const pendingData = pendingCustomIntervalInputs.get(userId);
    if (!pendingData || !pendingData.accountId) {
      // Invalid state, clear it
      pendingCustomIntervalInputs.delete(userId);
      console.log(`[MESSAGE HANDLER] Invalid pending custom interval state for user ${userId}, cleared`);
      return;
    }
    const { accountId } = pendingData;
    const result = await handleCustomIntervalInput(bot, msg, accountId);
    if (result === true) {
      pendingCustomIntervalInputs.delete(userId);
      logger.logChange('CUSTOM_INTERVAL', userId, 'Custom interval input completed');
    } else {
      logger.logChange('CUSTOM_INTERVAL', userId, 'Custom interval input still pending (retry needed)');
    }
  } else if (pendingBlacklistSearchInputs.has(userId)) {
    const pendingData = pendingBlacklistSearchInputs.get(userId);
    if (!pendingData || !pendingData.accountId) {
      pendingBlacklistSearchInputs.delete(userId);
      return;
    }
    const accountId = pendingData.accountId;
    const result = await handleBlacklistSearchInput(bot, msg, accountId);
    if (result) {
      pendingBlacklistSearchInputs.delete(userId);
    }
  } else if (pendingAutoReplyDmMessageInputs.has(userId)) {
    const pendingData = pendingAutoReplyDmMessageInputs.get(userId);
    if (!pendingData || !pendingData.accountId) {
      pendingAutoReplyDmMessageInputs.delete(userId);
      return;
    }
    const accountId = pendingData.accountId;
    const result = await handleAutoReplyDmMessageInput(bot, msg, accountId);
    if (result) {
      pendingAutoReplyDmMessageInputs.delete(userId);
    }
  } else if (pendingAutoReplyGroupsMessageInputs.has(userId)) {
    const pendingData = pendingAutoReplyGroupsMessageInputs.get(userId);
    if (!pendingData || !pendingData.accountId) {
      pendingAutoReplyGroupsMessageInputs.delete(userId);
      return;
    }
    const accountId = pendingData.accountId;
    const result = await handleAutoReplyGroupsMessageInput(bot, msg, accountId);
    if (result) {
      pendingAutoReplyGroupsMessageInputs.delete(userId);
    }
  } else if (pendingAutoReplyIntervalInputs.has(userId)) {
    const pendingData = pendingAutoReplyIntervalInputs.get(userId);
    if (!pendingData || !pendingData.accountId) {
      pendingAutoReplyIntervalInputs.delete(userId);
      return;
    }
    const accountId = pendingData.accountId;
    const result = await handleAutoReplyIntervalInput(bot, msg, accountId);
    if (result) {
      pendingAutoReplyIntervalInputs.delete(userId);
    }
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
  
  // SECURITY: Validate and sanitize callback data
  const data = callbackQuery.data;
  if (!validateCallbackData(data)) {
    console.log(`[SECURITY] Invalid callback data format from user ${callbackQuery.from?.id}: ${data?.substring(0, 50)}`);
    try {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Invalid request. Please try again.',
        show_alert: true,
      });
    } catch (e) {
      // Ignore if callback already expired
    }
    return;
  }
  
  const userId = validateUserId(callbackQuery.from?.id);
  if (!userId) {
    console.log('[SECURITY] Invalid user ID in callback query');
    try {
      await bot.answerCallbackQuery(callbackQuery.id);
    } catch (e) {
      // Ignore if callback already expired
    }
    return;
  }
  
  const username = (callbackQuery.from?.username || 'Unknown').substring(0, 50); // Limit length
  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId) {
    console.log('[SECURITY] Invalid chat ID in callback query');
    try {
      await bot.answerCallbackQuery(callbackQuery.id);
    } catch (e) {
      // Ignore if callback already expired
    }
    return;
  }

  // Log every button click (following project rules)
  const buttonName = data.startsWith('otp_') ? `OTP_${data.replace('otp_', '')}` :
                    data.startsWith('switch_account_') ? `Switch Account ${data.replace('switch_account_', '')}` :
                    data.startsWith('delete_account_') ? `Delete Account ${data.replace('delete_account_', '')}` :
                    data === 'btn_main_menu' ? 'Main Menu' :
                    data === 'btn_account' ? 'Account' :
                    data === 'btn_link' ? 'Link Account' :
                    data === 'btn_messages_menu' ? 'Messages Menu' :
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
                    data === 'btn_auto_reply' ? 'Auto Reply' :
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
      if (pendingPoolMessages.has(userId)) {
        pendingPoolMessages.delete(userId);
        console.log(`[CALLBACK] Cleared pending pool message state for user ${userId}`);
      }
      if (pendingQuietHoursInputs.has(userId)) {
        pendingQuietHoursInputs.delete(userId);
        console.log(`[CALLBACK] Cleared pending quiet hours state for user ${userId}`);
      }
      if (pendingScheduleInputs.has(userId)) {
        pendingScheduleInputs.delete(userId);
        console.log(`[CALLBACK] Cleared pending schedule state for user ${userId}`);
      }
      if (pendingCustomIntervalInputs.has(userId)) {
        pendingCustomIntervalInputs.delete(userId);
        console.log(`[CALLBACK] Cleared pending custom interval state for user ${userId}`);
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
    } else if (data === 'btn_login_share_phone') {
      await handleLoginSharePhone(bot, callbackQuery);
    } else if (data === 'btn_login_type_phone') {
      const result = await handleLoginTypePhone(bot, callbackQuery);
      if (result) {
        addPendingStateWithTimeout(pendingPhoneNumbers, userId);
        logger.logChange('PHONE_INPUT', userId, 'Waiting for phone number input');
      }
    } else if (data === 'btn_login_cancel') {
      await handleLoginCancel(bot, callbackQuery);
    } else if (data === 'btn_messages_menu') {
      await handleMessagesMenu(bot, callbackQuery);
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
    } else if (data === 'btn_premium') {
      await handlePremium(bot, callbackQuery);
    } else if (data === 'premium_faq') {
      await handlePremiumFAQ(bot, callbackQuery);
    } else if (data === 'premium_benefits') {
      await handlePremiumBenefits(bot, callbackQuery);
    } else if (data === 'premium_check_status') {
      await handleCheckPaymentStatus(bot, callbackQuery);
    } else if (data.startsWith('check_payment_')) {
      // Handle payment status check with order ID
      await handleCheckPaymentStatus(bot, callbackQuery);
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
    } else if (data === 'btn_auto_reply') {
      await handleAutoReplyMenu(bot, callbackQuery);
    } else if (data === 'btn_config_interval_menu') {
      await handleIntervalMenu(bot, callbackQuery);
    } else if (data === 'btn_config_custom_interval') {
      const result = await handleConfigCustomInterval(bot, callbackQuery);
      if (result && result.accountId) {
        addPendingStateWithTimeout(pendingCustomIntervalInputs, userId, result);
      }
    } else if (data === 'btn_config_group_delay') {
      const result = await handleConfigGroupDelay(bot, callbackQuery);
      if (result && result.accountId) {
        addPendingStateWithTimeout(pendingGroupDelayInputs, userId, result);
      }
    } else if (data === 'btn_config_forward_mode') {
      await handleConfigForwardMode(bot, callbackQuery);
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
    } else if (data === 'btn_message_pool') {
      await handleMessagePoolButton(bot, callbackQuery);
    } else if (data === 'pool_menu') {
      await handleMessagePoolButton(bot, callbackQuery);
    } else if (data === 'pool_add_message') {
      const result = await handlePoolAddMessage(bot, callbackQuery);
      if (result) {
        addPendingStateWithTimeout(pendingPoolMessages, userId, result);
      }
    } else if (data === 'pool_view_messages') {
      await handlePoolViewMessages(bot, callbackQuery);
    } else if (data.startsWith('pool_delete_')) {
      const messageId = parseInt(data.replace('pool_delete_', ''));
      if (!isNaN(messageId)) {
        await handlePoolDeleteMessage(bot, callbackQuery, messageId);
      }
    } else if (data === 'pool_mode_random') {
      await handlePoolModeChange(bot, callbackQuery, 'random');
    } else if (data === 'pool_mode_rotate') {
      await handlePoolModeChange(bot, callbackQuery, 'rotate');
    } else if (data === 'pool_mode_sequential') {
      await handlePoolModeChange(bot, callbackQuery, 'sequential');
    } else if (data === 'pool_toggle') {
      await handlePoolToggle(bot, callbackQuery);
    } else if (data === 'pool_clear_confirm') {
      await handlePoolClear(bot, callbackQuery);
    } else if (data.startsWith('pool_page_')) {
      // Handle pagination - refresh view
      await handlePoolViewMessages(bot, callbackQuery);
    } else if (data.startsWith('pool_view_')) {
      // View single message - just refresh list for now
      await handlePoolViewMessages(bot, callbackQuery);
    } else if (data === 'btn_config_group_delay') {
      const result = await handleConfigGroupDelay(bot, callbackQuery);
      if (result && result.accountId) {
        addPendingStateWithTimeout(pendingGroupDelayInputs, userId, result);
      }
    } else if (data === 'btn_config_forward_mode') {
      await handleConfigForwardMode(bot, callbackQuery);
    } else if (data === 'btn_stats') {
      await handleStatsButton(bot, callbackQuery);
    } else if (data === 'stats_period_today') {
      await handleStatsPeriod(bot, callbackQuery, 'today');
    } else if (data === 'stats_period_week') {
      await handleStatsPeriod(bot, callbackQuery, 'week');
    } else if (data === 'stats_period_month') {
      await handleStatsPeriod(bot, callbackQuery, 'month');
    } else if (data === 'stats_period_all') {
      await handleStatsPeriod(bot, callbackQuery, 'all');
    } else if (data === 'stats_trends') {
      await handleStatsTrends(bot, callbackQuery);
    } else if (data === 'stats_top_groups') {
      await handleTopGroups(bot, callbackQuery);
    } else if (data === 'stats_detailed') {
      await handleDetailedStats(bot, callbackQuery);
    } else if (data === 'stats_problematic') {
      await handleProblematicGroups(bot, callbackQuery);
    } else if (data === 'stats_ab') {
      await handleABResults(bot, callbackQuery);
    } else if (data.startsWith('switch_account_')) {
      const accountIdStr = data.replace('switch_account_', '');
      const accountId = validateAccountId(accountIdStr);
      if (!accountId) {
        await safeAnswerCallback(bot, callbackQuery.id, {
          text: 'Invalid account ID',
          show_alert: true,
        });
        return;
      }
      
      // SECURITY: Verify account ownership before allowing switch
      const ownsAccount = await verifyAccountOwnership(userId, accountId, db.query.bind(db));
      if (!ownsAccount) {
        console.log(`[SECURITY] User ${userId} attempted to switch to account ${accountId} they don't own`);
        await safeAnswerCallback(bot, callbackQuery.id, {
          text: 'Access denied. You do not own this account.',
          show_alert: true,
        });
        return;
      }
      
      await handleSwitchAccount(bot, callbackQuery, accountId);
    } else if (data.startsWith('delete_account_')) {
      const accountIdStr = data.replace('delete_account_', '');
      const accountId = validateAccountId(accountIdStr);
      if (!accountId) {
        await safeAnswerCallback(bot, callbackQuery.id, {
          text: 'Invalid account ID',
          show_alert: true,
        });
        return;
      }
      
      // SECURITY: Verify account ownership before allowing deletion
      const ownsAccount = await verifyAccountOwnership(userId, accountId, db.query.bind(db));
      if (!ownsAccount) {
        console.log(`[SECURITY] User ${userId} attempted to delete account ${accountId} they don't own`);
        await safeAnswerCallback(bot, callbackQuery.id, {
          text: 'Access denied. You do not own this account.',
          show_alert: true,
        });
        return;
      }
      
      await handleDeleteAccount(bot, callbackQuery, accountId);
    } else if (data === 'stop_broadcast') {
      await handleStopCallback(bot, callbackQuery);
    } else if (data === 'btn_config_blacklist') {
      const result = await handleConfigGroupBlacklist(bot, callbackQuery);
      if (result && result.accountId) {
        // No pending state needed for blacklist menu
      }
    } else if (data === 'btn_blacklist_search') {
      const result = await handleBlacklistSearch(bot, callbackQuery);
      if (result && result.accountId) {
        addPendingStateWithTimeout(pendingBlacklistSearchInputs, userId, result);
      }
    } else if (data === 'btn_blacklist_view') {
      await handleBlacklistView(bot, callbackQuery);
    } else if (data.startsWith('blacklist_add_')) {
      const groupId = data.replace('blacklist_add_', '');
      await handleBlacklistAdd(bot, callbackQuery, groupId);
    } else if (data.startsWith('blacklist_remove_')) {
      const groupId = data.replace('blacklist_remove_', '');
      await handleBlacklistRemove(bot, callbackQuery, groupId);
    } else if (data === 'btn_config_auto_reply_dm') {
      const result = await handleConfigAutoReplyDm(bot, callbackQuery);
      if (result && result.accountId) {
        // No pending state needed for menu
      }
    } else if (data.startsWith('auto_reply_dm_toggle_')) {
      const enabled = data.replace('auto_reply_dm_toggle_', '') === 'true';
      await handleAutoReplyDmToggle(bot, callbackQuery, enabled);
    } else if (data === 'auto_reply_dm_set_message') {
      const result = await handleAutoReplyDmSetMessage(bot, callbackQuery);
      if (result && result.accountId) {
        addPendingStateWithTimeout(pendingAutoReplyDmMessageInputs, userId, result);
      }
    } else if (data === 'btn_config_auto_reply_groups') {
      const result = await handleConfigAutoReplyGroups(bot, callbackQuery);
      if (result && result.accountId) {
        // No pending state needed for menu
      }
    } else if (data.startsWith('auto_reply_groups_toggle_')) {
      const enabled = data.replace('auto_reply_groups_toggle_', '') === 'true';
      await handleAutoReplyGroupsToggle(bot, callbackQuery, enabled);
    } else if (data === 'auto_reply_groups_set_message') {
      const result = await handleAutoReplyGroupsSetMessage(bot, callbackQuery);
      if (result && result.accountId) {
        addPendingStateWithTimeout(pendingAutoReplyGroupsMessageInputs, userId, result);
      }
    } else if (data === 'auto_reply_set_interval') {
      // Interval mode removed - always uses real-time with 30-minute cooldown
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'ℹ️ Interval mode has been removed. Auto-reply now uses real-time mode with a 30-minute cooldown per chat.',
        show_alert: true,
      });
    } else if (data.startsWith('auto_reply_interval_')) {
      // Interval mode removed - always uses real-time with 30-minute cooldown
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'ℹ️ Interval mode has been removed. Auto-reply now uses real-time mode with a 30-minute cooldown per chat.',
        show_alert: true,
      });
      return;
      // Old code below (disabled)
      const intervalStr = data.replace('auto_reply_interval_', '');
      if (intervalStr === 'custom') {
        const result = await handleAutoReplyIntervalCustom(bot, callbackQuery);
        if (result && result.accountId) {
          addPendingStateWithTimeout(pendingAutoReplyIntervalInputs, userId, result);
        }
      } else {
        const intervalSeconds = parseInt(intervalStr);
        if (!isNaN(intervalSeconds)) {
          await handleAutoReplyIntervalSelect(bot, callbackQuery, intervalSeconds);
        }
      }
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
  // Check if it's a flood wait error
  if (isFloodWaitError(error)) {
    const waitSeconds = extractWaitTime(error);
    if (waitSeconds !== null && waitSeconds > 0) {
      console.error(`[FLOOD_WAIT] ⚠️ Polling error due to rate limiting. Telegram requires ${waitSeconds}s wait.`);
      logger.logError('POLLING_FLOOD_WAIT', null, error, `Polling rate limited: ${waitSeconds}s wait required`);
    } else {
      console.error(`[FLOOD_WAIT] ⚠️ Polling error due to rate limiting (couldn't extract wait time).`);
      logger.logError('POLLING_FLOOD_WAIT', null, error, 'Polling rate limited (unknown wait time)');
    }
  } else {
    logger.logError('POLLING', null, error, 'Telegram polling error');
  }
});

bot.on('error', (error) => {
  // Check if it's a flood wait error
  if (isFloodWaitError(error)) {
    const waitSeconds = extractWaitTime(error);
    if (waitSeconds !== null && waitSeconds > 0) {
      console.error(`[FLOOD_WAIT] ⚠️ Bot error due to rate limiting. Telegram requires ${waitSeconds}s wait.`);
      logger.logError('BOT_FLOOD_WAIT', null, error, `Bot rate limited: ${waitSeconds}s wait required`);
    } else {
      console.error(`[FLOOD_WAIT] ⚠️ Bot error due to rate limiting (couldn't extract wait time).`);
      logger.logError('BOT_FLOOD_WAIT', null, error, 'Bot rate limited (unknown wait time)');
    }
  } else {
    logError('Bot error:', error);
  }
});

// Handle unhandled promise rejections (filter out normal Telegram client errors)
process.on('unhandledRejection', (reason, promise) => {
  // Check for flood wait errors first - these are critical
  if (reason && typeof reason === 'object' && isFloodWaitError(reason)) {
    const waitSeconds = extractWaitTime(reason);
    if (waitSeconds !== null && waitSeconds > 0) {
      console.error(`[FLOOD_WAIT] ⚠️ CRITICAL: Unhandled flood wait error! Telegram requires ${waitSeconds}s wait. This may cause bans if not handled properly.`);
      logger.logError('UNHANDLED_FLOOD_WAIT', null, reason, `Unhandled flood wait: ${waitSeconds}s wait required`);
    } else {
      console.error(`[FLOOD_WAIT] ⚠️ CRITICAL: Unhandled flood wait error (couldn't extract wait time). This may cause bans if not handled properly.`);
      logger.logError('UNHANDLED_FLOOD_WAIT', null, reason, 'Unhandled flood wait (unknown wait time)');
    }
    return; // Don't log as regular error, we've already logged it
  }
  
  // Filter out timeout errors from Telegram client update loop - these are normal
  if (reason && typeof reason === 'object') {
    const errorMessage = reason.message || '';
    const errorStack = reason.stack || '';
    
    // Filter TIMEOUT errors (check both message and stack)
    if (errorMessage === 'TIMEOUT' || 
        (errorMessage.includes('TIMEOUT') && errorStack.includes('telegram/client/updates.js'))) {
      return; // Timeout errors in update loop are expected - don't log as errors
    }
    
    // Filter BinaryReader errors (recoverable MTProto errors)
    if (errorMessage.includes('readUInt32LE') || 
        errorMessage.includes('BinaryReader') || 
        errorMessage.includes('Cannot read properties of undefined') ||
        errorStack.includes('BinaryReader')) {
      console.log(`[UNHANDLED] Suppressed recoverable MTProto BinaryReader error: ${errorMessage.substring(0, 100)}`);
      return; // These are recoverable and don't need to crash the app
    }
    
    // Filter builder.resolve errors (common MTProto update handler issue)
    if (errorMessage.includes('builder.resolve is not a function') ||
        errorMessage.includes('builder.resolve') ||
        errorStack.includes('_dispatchUpdate') ||
        errorStack.includes('_processUpdate')) {
      console.log(`[UNHANDLED] Suppressed MTProto update handler error: ${errorMessage.substring(0, 100)}`);
      return; // These are recoverable update processing errors
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
  
  // Filter BinaryReader errors (recoverable MTProto errors)
  if (errorMessage.includes('readUInt32LE') || 
      errorMessage.includes('BinaryReader') || 
      errorMessage.includes('Cannot read properties of undefined') ||
      errorStack.includes('BinaryReader')) {
    console.log(`[UNCAUGHT] Suppressed recoverable MTProto BinaryReader error: ${errorMessage.substring(0, 100)}`);
    return; // These are recoverable and don't need to crash the app
  }
  
  // Filter builder.resolve errors (common MTProto update handler issue)
  if (errorMessage.includes('builder.resolve is not a function') ||
      errorMessage.includes('builder.resolve') ||
      errorStack.includes('_dispatchUpdate') ||
      errorStack.includes('_processUpdate')) {
    console.log(`[UNCAUGHT] Suppressed MTProto update handler error: ${errorMessage.substring(0, 100)}`);
    return; // These are recoverable update processing errors
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

// Graceful shutdown handler
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log(`[SHUTDOWN] Already shutting down, ignoring ${signal}`);
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n🛑 Received ${signal}, initiating graceful shutdown...`);
  
  const shutdownTimeout = setTimeout(() => {
    console.error('[SHUTDOWN] Forced shutdown after timeout');
    process.exit(1);
  }, 10000); // 10 second timeout for forced shutdown
  
  try {
    // Stop polling
    console.log('[SHUTDOWN] Stopping polling...');
    try {
      await bot.stopPolling({ drop_pending_updates: true });
      console.log('[SHUTDOWN] Polling stopped');
    } catch (error) {
      console.error('[SHUTDOWN] Error stopping polling:', error.message);
    }
    
    // Stop automation services gracefully
    console.log('[SHUTDOWN] Cleaning up automation services...');
    try {
      // Cleanup any running broadcasts if needed
      automationService.cleanupStoppedBroadcasts();
    } catch (error) {
      console.error('[SHUTDOWN] Error cleaning up broadcasts:', error.message);
    }
    
    // Stop channel verification service
    console.log('[SHUTDOWN] Stopping channel verification service...');
    try {
      channelVerificationService.stop();
    } catch (error) {
      console.error('[SHUTDOWN] Error stopping channel verification service:', error.message);
    }
    
    // Close database connections
    console.log('[SHUTDOWN] Closing database connections...');
    await Promise.race([
      db.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB close timeout')), 5000))
    ]);
    console.log('[SHUTDOWN] Database closed');
    
    // Notify admins of shutdown
    try {
      await adminNotifier.notifyEvent('BOT_SHUTDOWN', `Bot shutting down (${signal})`, {});
    } catch (error) {
      console.error('[SHUTDOWN] Error notifying admins:', error.message);
    }
    
    clearTimeout(shutdownTimeout);
    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    clearTimeout(shutdownTimeout);
    console.error('[SHUTDOWN] Error during shutdown:', error);
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle PM2 shutdown signal
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2'));
