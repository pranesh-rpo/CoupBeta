/**
 * Auto Reply Polling Service
 * Polls for new messages periodically without keeping account online
 * Provides near real-time auto-reply (1-2 second delay) without persistent connection
 */

import accountLinker from './accountLinker.js';
import configService from './configService.js';
import autoReplyHandler from './autoReplyHandler.js';
import { logError } from '../utils/logger.js';

class AutoReplyPollingService {
  constructor() {
    this.pollingIntervals = new Map(); // accountId -> intervalId
    this.lastCheckTimes = new Map(); // accountId -> { dm: timestamp, groups: timestamp }
    this.processingAccounts = new Set(); // accountId -> true (to prevent concurrent processing)
  }

  /**
   * Start polling for an account (connects, checks messages, disconnects)
   */
  async startPolling(accountId) {
    // Stop existing polling if any
    this.stopPolling(accountId);

    const pollInterval = 2000; // 2 seconds - near real-time
    const intervalId = setInterval(async () => {
      await this.checkAndReply(accountId);
    }, pollInterval);

    this.pollingIntervals.set(accountId.toString(), intervalId);
    console.log(`[AUTO_REPLY_POLL] Started polling for account ${accountId} (interval: ${pollInterval}ms)`);

    // Check immediately on start
    await this.checkAndReply(accountId);
  }

  /**
   * Stop polling for an account
   */
  stopPolling(accountId) {
    const accountIdStr = accountId.toString();
    const intervalId = this.pollingIntervals.get(accountIdStr);
    if (intervalId) {
      clearInterval(intervalId);
      this.pollingIntervals.delete(accountIdStr);
      this.lastCheckTimes.delete(accountIdStr);
      console.log(`[AUTO_REPLY_POLL] Stopped polling for account ${accountId}`);
    }
  }

  /**
   * Check for new messages and send auto-replies
   */
  async checkAndReply(accountId) {
    // Prevent concurrent processing
    if (this.processingAccounts.has(accountId)) {
      return;
    }

    this.processingAccounts.add(accountId);

    try {
      const settings = await configService.getAccountSettings(accountId);
      if (!settings) {
        this.stopPolling(accountId);
        return;
      }

      const hasAutoReply = (settings.autoReplyDmEnabled && settings.autoReplyDmMessage) ||
                          (settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage);

      if (!hasAutoReply) {
        this.stopPolling(accountId);
        return;
      }

      // Get account info
      const db = (await import('../database/db.js')).default;
      const result = await db.query('SELECT user_id FROM accounts WHERE account_id = $1', [accountId]);
      if (!result.rows || result.rows.length === 0) {
        this.stopPolling(accountId);
        return;
      }

      const userId = result.rows[0].user_id;

      // Connect briefly to check messages
      const client = await accountLinker.getClientAndConnect(userId, accountId);
      if (!client || !client.connected) {
        return; // Will retry on next poll
      }

      try {
        const me = await client.getMe();
        const dialogs = await client.getDialogs({ limit: 50 }); // Check recent dialogs

        const lastCheck = this.lastCheckTimes.get(accountId.toString()) || { dm: 0, groups: 0 };
        const now = Date.now();

        for (const dialog of dialogs) {
          try {
            const chat = await dialog.getChat();
            if (!chat) continue;

            const chatType = chat.className || '';
            const isDM = chatType === 'User';
            const isGroup = chatType === 'Chat' || chat.megagroup || chat.gigagroup;

            if (!isDM && !isGroup) continue;

            // Get last message in dialog
            const messages = await client.getMessages(chat, { limit: 1 });
            if (!messages || messages.length === 0) continue;

            const lastMessage = messages[0];

            // Skip if message is from ourselves
            if (this.isMessageFromSelf(lastMessage, me.id)) continue;

            // Skip if message is from a bot
            if (await this.isSenderBot(lastMessage, client)) continue;

            // Skip if message is empty or not text
            if (!lastMessage.text || lastMessage.text.trim().length === 0) continue;

            // Get chat ID and message ID
            const chatId = this.extractChatId(chat, lastMessage);
            if (!chatId) continue;

            const messageId = String(lastMessage.id);
            const messageKey = `${accountId}_${chatId}_${messageId}`;

            // Check message timestamp
            const messageDate = lastMessage.date ? Math.floor(lastMessage.date.getTime() / 1000) : 0;
            const checkKey = isDM ? 'dm' : 'groups';
            const lastCheckTime = lastCheck[checkKey] || 0;

            // Only process messages newer than last check
            if (messageDate <= lastCheckTime) continue;

            // Process message using auto-reply handler
            await autoReplyHandler.processMessage(lastMessage, accountId, client);

            // Update last check time
            lastCheck[checkKey] = messageDate;
          } catch (error) {
            // Skip errors for individual chats
            continue;
          }
        }

        // Update last check times
        this.lastCheckTimes.set(accountId.toString(), lastCheck);

        // Disconnect after checking (to avoid staying online)
        // Note: We don't disconnect if client is being used for broadcasting
        // The accountLinker will manage this
      } catch (error) {
        logError(`[AUTO_REPLY_POLL] Error checking messages for account ${accountId}:`, error);
      }
    } catch (error) {
      logError(`[AUTO_REPLY_POLL] Error in checkAndReply for account ${accountId}:`, error);
    } finally {
      this.processingAccounts.delete(accountId);
    }
  }

  /**
   * Extract chat ID from chat/message
   */
  extractChatId(chat, message) {
    if (chat && chat.id !== null && chat.id !== undefined) {
      return typeof chat.id === 'bigint' ? chat.id.toString() : String(chat.id);
    }
    if (message && message.peerId) {
      if (message.peerId.userId !== null && message.peerId.userId !== undefined) {
        return String(message.peerId.userId);
      }
      if (message.peerId.channelId !== null && message.peerId.channelId !== undefined) {
        return String(message.peerId.channelId);
      }
      if (message.peerId.chatId !== null && message.peerId.chatId !== undefined) {
        return String(message.peerId.chatId);
      }
    }
    return null;
  }

  /**
   * Check if message is from ourselves
   */
  isMessageFromSelf(message, meId) {
    if (!message.fromId) return false;
    
    let senderId = null;
    if (message.fromId.className === 'PeerUser') {
      senderId = message.fromId.userId;
    } else if (message.fromId.userId !== undefined) {
      senderId = message.fromId.userId;
    }
    
    if (senderId === null || senderId === undefined) return false;
    
    const senderIdNum = typeof senderId === 'bigint' ? Number(senderId) : senderId;
    const meIdNum = typeof meId === 'bigint' ? Number(meId) : meId;
    return senderIdNum === meIdNum;
  }

  /**
   * Check if message sender is a bot
   */
  async isSenderBot(message, client) {
    try {
      if (message.sender && message.sender.bot === true) {
        return true;
      }
      if (message.fromId && message.fromId.className === 'PeerUser') {
        try {
          const sender = await client.getEntity(message.fromId.userId);
          return sender && sender.bot === true;
        } catch (e) {
          return false;
        }
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Start polling for all accounts with auto-reply enabled
   */
  async startAll() {
    try {
      const db = (await import('../database/db.js')).default;
      const result = await db.query(
        `SELECT account_id FROM accounts 
         WHERE (auto_reply_dm_enabled = 1 OR auto_reply_groups_enabled = 1)`
      );

      console.log(`[AUTO_REPLY_POLL] Starting polling for ${result.rows.length} accounts...`);
      
      for (const row of result.rows) {
        await this.startPolling(row.account_id);
      }
    } catch (error) {
      logError('[AUTO_REPLY_POLL] Error starting all polling:', error);
    }
  }

  /**
   * Stop all polling
   */
  stopAll() {
    for (const [accountIdStr, _] of this.pollingIntervals.entries()) {
      this.stopPolling(parseInt(accountIdStr));
    }
    console.log('[AUTO_REPLY_POLL] Stopped all polling');
  }
}

export default new AutoReplyPollingService();

