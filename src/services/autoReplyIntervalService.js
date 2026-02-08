/**
 * Auto Reply Interval Service
 * Checks for new messages at intervals and sends auto-replies
 */

import accountLinker from './accountLinker.js';
import configService from './configService.js';
import db from '../database/db.js';
import { logError } from '../utils/logger.js';

class AutoReplyIntervalService {
  constructor() {
    this.intervals = new Map(); // accountId -> intervalId
    this.lastChecked = new Map(); // accountId -> { dm: timestamp, groups: timestamp }
    this.processedMessages = new Map(); // accountId -> Set<"chatId_messageId">
    this.isRunning = false;
  }

  /**
   * Get unique key for a processed message
   */
  getProcessedMessageKey(accountId, chatId, messageId) {
    return `${accountId}_${chatId}_${messageId}`;
  }

  /**
   * Check if message has already been processed
   */
  hasProcessedMessage(accountId, chatId, messageId) {
    const accountIdStr = accountId.toString();
    const processedSet = this.processedMessages.get(accountIdStr);
    if (!processedSet) return false;
    
    const key = this.getProcessedMessageKey(accountId, chatId, messageId);
    return processedSet.has(key);
  }

  /**
   * Mark message as processed
   */
  markMessageProcessed(accountId, chatId, messageId) {
    const accountIdStr = accountId.toString();
    if (!this.processedMessages.has(accountIdStr)) {
      this.processedMessages.set(accountIdStr, new Set());
    }
    
    const key = this.getProcessedMessageKey(accountId, chatId, messageId);
    this.processedMessages.get(accountIdStr).add(key);
    
    // Cleanup old entries periodically (keep last 1000 per account)
    const processedSet = this.processedMessages.get(accountIdStr);
    if (processedSet.size > 1000) {
      const entries = Array.from(processedSet);
      const toKeep = entries.slice(-500); // Keep last 500
      processedSet.clear();
      toKeep.forEach(k => processedSet.add(k));
    }
  }

  /**
   * Start interval checking for an account
   */
  async startIntervalCheck(accountId) {
    try {
      const settings = await configService.getAccountSettings(accountId);
      if (!settings) return;

      const intervalSeconds = settings.autoReplyCheckInterval !== undefined ? settings.autoReplyCheckInterval : 30;
      
      // If interval is 0 or not set, don't use interval mode
      if (intervalSeconds <= 0) {
        this.stopIntervalCheck(accountId);
        return;
      }

      // Check if auto-reply is enabled for either DM or groups
      if (!settings.autoReplyDmEnabled && !settings.autoReplyGroupsEnabled) {
        this.stopIntervalCheck(accountId);
        return;
      }

      // Stop existing interval if any
      this.stopIntervalCheck(accountId);

      // Start new interval
      const intervalId = setInterval(async () => {
        try {
          await this.checkAndReply(accountId);
        } catch (error) {
          logError(`[AUTO_REPLY_INTERVAL] Error checking messages for account ${accountId}:`, error);
        }
      }, intervalSeconds * 1000);

      this.intervals.set(accountId.toString(), intervalId);
      console.log(`[AUTO_REPLY_INTERVAL] Started interval check for account ${accountId} (${intervalSeconds}s)`);
    } catch (error) {
      logError(`[AUTO_REPLY_INTERVAL] Error starting interval check for account ${accountId}:`, error);
    }
  }

  /**
   * Stop all interval checks (e.g., on shutdown)
   */
  stopAll() {
    console.log(`[AUTO_REPLY_INTERVAL] Stopping all ${this.intervals.size} intervals...`);
    for (const [accountId, intervalId] of this.intervals.entries()) {
      clearInterval(intervalId);
    }
    this.intervals.clear();
    this.isRunning = false;
  }

  /**
   * Stop interval checking for an account
   */
  stopIntervalCheck(accountId) {
    const accountIdStr = accountId.toString();
    const intervalId = this.intervals.get(accountIdStr);
    if (intervalId) {
      clearInterval(intervalId);
      this.intervals.delete(accountIdStr);
      this.lastChecked.delete(accountIdStr);
      console.log(`[AUTO_REPLY_INTERVAL] Stopped interval check for account ${accountId}`);
    }
  }

  /**
   * Check if message sender is a bot
   */
  async isSenderBot(message, client) {
    try {
      // Try to get the sender entity
      if (message.sender) {
        return message.sender.bot === true;
      }
      
      // Try to get sender from fromId
      if (message.fromId) {
        let senderId = null;
        if (message.fromId.className === 'PeerUser') {
          senderId = message.fromId.userId;
        } else if (message.fromId && typeof message.fromId === 'object' && message.fromId.userId) {
          senderId = message.fromId.userId;
        }
        
        if (senderId !== null && senderId !== undefined) {
          try {
            const senderIdNum = typeof senderId === 'bigint' ? Number(senderId) : senderId;
            const sender = await client.getEntity(senderIdNum);
            if (sender && sender.bot === true) {
              return true;
            }
          } catch (e) {
            // If we can't get the entity, assume it's not a bot
            return false;
          }
        }
      }
      
      return false;
    } catch (error) {
      // If we can't determine, assume it's not a bot (to avoid blocking legitimate users)
      return false;
    }
  }

  /**
   * Check if message is from ourselves
   */
  isMessageFromSelf(message, meId) {
    if (!message.fromId) return false;
    
    // Try using equals method if available
    if (typeof message.fromId.equals === 'function') {
      try {
        return message.fromId.equals(meId);
      } catch (e) {
        // Fall through to other methods
      }
    }
    
    // Extract userId from PeerUser object
    let senderId = null;
    if (message.fromId.className === 'PeerUser') {
      senderId = message.fromId.userId;
    } else if (message.fromId && typeof message.fromId === 'object' && message.fromId.userId) {
      senderId = message.fromId.userId;
    }
    
    // Compare IDs (handle BigInt and number types)
    if (senderId !== null && senderId !== undefined) {
      const senderIdNum = typeof senderId === 'bigint' ? Number(senderId) : senderId;
      const meIdNum = typeof meId === 'bigint' ? Number(meId) : meId;
      return senderIdNum === meIdNum;
    }
    
    return false;
  }

  /**
   * Check for new messages and send auto-replies
   */
  async checkAndReply(accountId) {
    try {
      // Get account info from database
      const accountQuery = await db.query(
        'SELECT user_id FROM accounts WHERE account_id = $1',
        [accountId]
      );
      
      if (!accountQuery.rows || accountQuery.rows.length === 0) {
        this.stopIntervalCheck(accountId);
        return;
      }

      const userId = accountQuery.rows[0]?.user_id;
      const client = await accountLinker.getClientAndConnect(userId, accountId);
      if (!client || !client.connected) {
        return;
      }

      const settings = await configService.getAccountSettings(accountId);
      if (!settings) return;

      // Get last checked timestamps
      const accountIdStr = accountId.toString();
      const lastCheck = this.lastChecked.get(accountIdStr) || { dm: 0, groups: 0 };
      const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds

      // Get dialogs (chats)
      let dialogs = [];
      try {
        dialogs = await client.getDialogs();
      } catch (dialogsError) {
        // Check if it's a session revocation error (AUTH_KEY_UNREGISTERED or SESSION_REVOKED)
        const errorMessage = dialogsError.message || dialogsError.toString() || '';
        const errorCode = dialogsError.code || dialogsError.errorCode || dialogsError.response?.error_code;
        const isSessionRevoked = 
          dialogsError.errorMessage === 'SESSION_REVOKED' || 
          dialogsError.errorMessage === 'AUTH_KEY_UNREGISTERED' ||
          (errorCode === 401 && (errorMessage.includes('SESSION_REVOKED') || errorMessage.includes('AUTH_KEY_UNREGISTERED'))) ||
          errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
          errorMessage.includes('SESSION_REVOKED');
        
        if (isSessionRevoked) {
          console.log(`[AUTO_REPLY_INTERVAL] Session revoked for account ${accountId} - marking for re-authentication`);
          try {
            await accountLinker.handleSessionRevoked(accountId);
          } catch (revokeError) {
            console.log(`[AUTO_REPLY_INTERVAL] Error handling session revocation for account ${accountId}: ${revokeError.message}`);
          }
          // Stop interval check for this account
          this.stopIntervalCheck(accountId);
          return;
        }
        // Re-throw if it's not a session error
        throw dialogsError;
      }
      const me = await client.getMe();

      for (const dialog of dialogs) {
        try {
          // Skip if it's not a user (for DM) or group
          const chat = await dialog.getChat();
          if (!chat) continue;

          const chatType = chat.className || '';
          const isDM = chatType === 'User';
          const isGroup = chatType === 'Chat' || chatType === 'Channel' || chat.megagroup || chat.gigagroup;

          if (!isDM && !isGroup) continue;

          // Get last message in dialog
          const messages = await client.getMessages(chat, { limit: 1 });
          if (!messages || messages.length === 0) continue;

          const lastMessage = messages[0];
          
          // Skip if message is from ourselves
          if (this.isMessageFromSelf(lastMessage, me.id)) continue;

          // Skip if message is from a bot
          const isBot = await this.isSenderBot(lastMessage, client);
          if (isBot) {
            continue;
          }

          // Skip if message is not text
          if (!lastMessage.text || lastMessage.text.trim().length === 0) continue;

          // CRITICAL: Skip Saved Messages (user's own chat with themselves)
          if (isDM) {
            const chatIdNum = typeof chat.id === 'bigint' ? Number(chat.id) : Number(chat.id);
            const meIdNum = typeof me.id === 'bigint' ? Number(me.id) : Number(me.id);
            
            if (chatIdNum === meIdNum || chat.firstName === 'Saved Messages' || chat.username === 'savedmessages') {
              console.log(`[AUTO_REPLY_INTERVAL] Skipping Saved Messages for account ${accountId}`);
              continue;
            }
          }

          // Get chat ID and message ID for tracking
          let chatId = null;
          if (chat.id !== null && chat.id !== undefined) {
            chatId = typeof chat.id === 'bigint' ? chat.id.toString() : String(chat.id);
          }
          const messageId = lastMessage.id ? String(lastMessage.id) : null;

          // Check if we've already processed this specific message
          if (chatId && messageId && this.hasProcessedMessage(accountId, chatId, messageId)) {
            continue; // Already processed this message
          }

          // Check if message is newer than last check
          const messageDate = lastMessage.date ? Math.floor(lastMessage.date.getTime() / 1000) : 0;
          const checkKey = isDM ? 'dm' : 'groups';
          const lastCheckTime = lastCheck[checkKey] || 0;

          if (messageDate <= lastCheckTime) continue; // Already checked

          // Check if we should reply
          if (isDM && settings.autoReplyDmEnabled && settings.autoReplyDmMessage) {
            // Check if we already replied to this message
            const replyMessages = await client.getMessages(chat, {
              limit: 5,
              offsetId: lastMessage.id,
            });
            
            // Check if any of the recent messages are from us
            const hasOurReply = replyMessages.some(msg => 
              this.isMessageFromSelf(msg, me.id)
            );

            if (!hasOurReply) {
              console.log(`[AUTO_REPLY_INTERVAL] Sending DM auto-reply for account ${accountId}`);
              await client.sendMessage(chat, {
                message: settings.autoReplyDmMessage,
              });
              // Mark message as processed
              if (chatId && messageId) {
                this.markMessageProcessed(accountId, chatId, messageId);
              }
            }
          } else if (isGroup && settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage) {
            // For groups, check if bot is mentioned
            // Note: We need to check mentions in interval mode too
            // For now, we'll reply to any group message (you can add mention check if needed)
            
            // Check if we already replied to this message
            const replyMessages = await client.getMessages(chat, {
              limit: 5,
              offsetId: lastMessage.id,
            });
            
            // Check if any of the recent messages are from us
            const hasOurReply = replyMessages.some(msg => 
              this.isMessageFromSelf(msg, me.id)
            );

            if (!hasOurReply) {
              console.log(`[AUTO_REPLY_INTERVAL] Sending group auto-reply for account ${accountId}`);
              await client.sendMessage(chat, {
                message: settings.autoReplyGroupsMessage,
              });
              // Mark message as processed
              if (chatId && messageId) {
                this.markMessageProcessed(accountId, chatId, messageId);
              }
            }
          }

          // Update last checked time
          lastCheck[checkKey] = messageDate;
        } catch (error) {
          // Skip errors for individual chats
          if (error.message && (
            error.message.includes('CHAT_ID_INVALID') ||
            error.message.includes('USER_DEACTIVATED') ||
            error.message.includes('PEER_ID_INVALID')
          )) {
            continue;
          }
        }
      }

      // Update last checked timestamps
      this.lastChecked.set(accountIdStr, lastCheck);
    } catch (error) {
      // Check if user deleted their Telegram account
      if (accountLinker.isUserDeletedError(error)) {
        console.log(`[AUTO_REPLY_INTERVAL] User deleted their Telegram account for account ${accountId} - cleaning up all data`);
        try {
          const accountQuery = await db.query(
            'SELECT user_id FROM accounts WHERE account_id = $1',
            [accountId]
          );
          if (accountQuery.rows.length > 0) {
            const deletedUserId = accountQuery.rows[0]?.user_id;
            await accountLinker.cleanupUserData(deletedUserId);
          }
        } catch (cleanupError) {
          console.log(`[AUTO_REPLY_INTERVAL] Error cleaning up user data: ${cleanupError.message}`);
        }
        this.stopIntervalCheck(accountId);
        return;
      }
      
      // Check if it's a session revocation error (AUTH_KEY_UNREGISTERED or SESSION_REVOKED)
      const errorMessage = error.message || error.toString() || '';
      const errorCode = error.code || error.errorCode || error.response?.error_code;
      const isSessionRevoked = 
        error.errorMessage === 'SESSION_REVOKED' || 
        error.errorMessage === 'AUTH_KEY_UNREGISTERED' ||
        (errorCode === 401 && (errorMessage.includes('SESSION_REVOKED') || errorMessage.includes('AUTH_KEY_UNREGISTERED'))) ||
        errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
        errorMessage.includes('SESSION_REVOKED');
      
      if (isSessionRevoked) {
        console.log(`[AUTO_REPLY_INTERVAL] Session revoked for account ${accountId} - marking for re-authentication`);
        try {
          await accountLinker.handleSessionRevoked(accountId);
        } catch (revokeError) {
          console.log(`[AUTO_REPLY_INTERVAL] Error handling session revocation for account ${accountId}: ${revokeError.message}`);
        }
        // Stop interval check for this account
        this.stopIntervalCheck(accountId);
        return;
      }
      
      logError(`[AUTO_REPLY_INTERVAL] Error checking messages for account ${accountId}:`, error);
    }
  }

  /**
   * Start interval checking for all accounts with auto-reply enabled
   */
  async startAllIntervals() {
    try {
      const result = await db.query(
        `SELECT account_id FROM accounts 
         WHERE (auto_reply_dm_enabled = 1 OR auto_reply_groups_enabled = 1) 
           AND auto_reply_check_interval > 0`
      );

      for (const row of result.rows) {
        await this.startIntervalCheck(row.account_id);
      }

      this.isRunning = true;
      console.log(`[AUTO_REPLY_INTERVAL] Started interval checking for ${result.rows.length} accounts`);
    } catch (error) {
      logError('[AUTO_REPLY_INTERVAL] Error starting all intervals:', error);
    }
  }

  /**
   * Stop all interval checking
   */
  stopAllIntervals() {
    for (const [accountIdStr, intervalId] of this.intervals.entries()) {
      clearInterval(intervalId);
    }
    this.intervals.clear();
    this.lastChecked.clear();
    this.isRunning = false;
    console.log('[AUTO_REPLY_INTERVAL] Stopped all interval checking');
  }
}

export default new AutoReplyIntervalService();

