/**
 * Auto Reply Handler
 * Handles incoming messages and sends auto-replies using Telegram Client API
 * Event-driven architecture - no polling
 */

import { NewMessage } from 'telegram/events/index.js';
import configService from './configService.js';
import { logError } from '../utils/logger.js';

class AutoReplyHandler {
  constructor() {
    // Track which chats have already received auto-replies (30-min cooldown)
    // Format: "accountId_chatId" -> timestamp
    this.repliedChats = new Map();
    
    // Track processed message IDs to prevent duplicate processing
    // Format: "accountId_chatId_messageId" -> timestamp
    this.processedMessages = new Map();
    
    // Track registered handlers per client to prevent duplicates
    // Format: "clientId_accountId" -> handler function
    this.registeredHandlers = new Map();
    
    // Track accounts we've already logged "already registered" message for
    // Format: accountId -> true
    this.loggedAlreadyRegistered = new Set();
    
    // Rate limiting: Track last message sent time per account to prevent spam
    // Format: accountId -> timestamp
    this.lastMessageSent = new Map();
    
    // Minimum delay between messages from same account (anti-detection)
    this.MIN_MESSAGE_INTERVAL = 3000; // 3 seconds minimum between messages
    
    // Cleanup interval ID for periodic cleanup
    this.cleanupIntervalId = null;
    
    // Cleanup old entries periodically
    this.startCleanupInterval();
  }

  /**
   * Start periodic cleanup of old entries
   */
  startCleanupInterval() {
    // Clear existing interval if any
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
    }
    
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupOldEntries();
    }, 60 * 60 * 1000); // Every hour
  }

  /**
   * Stop cleanup interval
   */
  stopCleanupInterval() {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  /**
   * Cleanup old processed messages and expired cooldowns
   */
  cleanupOldEntries() {
    const now = Date.now();
    const thirtyMinutesAgo = now - (30 * 60 * 1000);
    
    // Cleanup processed messages older than 1 hour
    const oneHourAgo = now - (60 * 60 * 1000);
    for (const [key, timestamp] of this.processedMessages.entries()) {
      if (timestamp < oneHourAgo) {
        this.processedMessages.delete(key);
      }
    }
    
    // Cleanup expired cooldowns
    for (const [key, timestamp] of this.repliedChats.entries()) {
      if (timestamp < thirtyMinutesAgo) {
        this.repliedChats.delete(key);
      }
    }
    
    // Cleanup old rate limiting entries (older than 1 minute)
    const oneMinuteAgo = now - (60 * 1000);
    for (const [accountId, timestamp] of this.lastMessageSent.entries()) {
      if (timestamp < oneMinuteAgo) {
        this.lastMessageSent.delete(accountId);
      }
    }
    
    // Limit processed messages to 1000 entries
    if (this.processedMessages.size > 1000) {
      const entries = Array.from(this.processedMessages.entries())
        .sort((a, b) => b[1] - a[1]) // Sort by timestamp, newest first
        .slice(0, 500); // Keep 500 most recent
      this.processedMessages.clear();
      entries.forEach(([k, v]) => this.processedMessages.set(k, v));
    }
  }

  /**
   * Get unique key for tracking
   */
  getKey(accountId, chatId, messageId = null) {
    if (messageId) {
      return `${accountId}_${chatId}_${messageId}`;
    }
    return `${accountId}_${chatId}`;
  }

  /**
   * Check if message has already been processed
   */
  hasProcessedMessage(accountId, chatId, messageId) {
    const key = this.getKey(accountId, chatId, messageId);
    return this.processedMessages.has(key);
  }

  /**
   * Mark message as processed
   */
  markMessageProcessed(accountId, chatId, messageId) {
    const key = this.getKey(accountId, chatId, messageId);
    this.processedMessages.set(key, Date.now());
  }

  /**
   * Check if we've already replied to this chat recently (30-minute cooldown)
   */
  hasRepliedToChatRecently(accountId, chatId) {
    const key = this.getKey(accountId, chatId);
    const lastReplyTime = this.repliedChats.get(key);
    if (!lastReplyTime) return false;
    
    const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
    if (lastReplyTime < thirtyMinutesAgo) {
      this.repliedChats.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Mark chat as replied to (30-minute cooldown)
   */
  markChatAsReplied(accountId, chatId) {
    const key = this.getKey(accountId, chatId);
    this.repliedChats.set(key, Date.now());
  }

  /**
   * Extract chat ID from message/chat object
   */
  extractChatId(chat, message) {
    // Method 1: Direct from chat.id
    if (chat && chat.id !== null && chat.id !== undefined) {
      return typeof chat.id === 'bigint' ? chat.id.toString() : String(chat.id);
    }
    
    // Method 2: From message.peerId
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
          // If we can't get the entity, assume it's not a bot
          return false;
        }
      }
      
      return false;
    } catch (error) {
      return false; // Assume not a bot on error
    }
  }

  /**
   * Check if message mentions the account (tags/pings)
   */
  async isAccountMentioned(message, meId, meUsername) {
    // Method 1: Check message entities for mentions (most reliable)
    if (message.entities && Array.isArray(message.entities)) {
      for (const entity of message.entities) {
        // Check for MessageEntityMentionName (direct user mention)
        if (entity.className === 'MessageEntityMentionName' && entity.userId) {
          const mentionedId = typeof entity.userId === 'bigint' ? Number(entity.userId) : entity.userId;
          const meIdNum = typeof meId === 'bigint' ? Number(meId) : meId;
          if (mentionedId === meIdNum) {
            return true;
          }
        }
        
        // Check for MessageEntityMention (@username mentions)
        if (entity.className === 'MessageEntityMention' && message.text && meUsername) {
          const mentionText = message.text.substring(entity.offset, entity.offset + entity.length);
          if (mentionText.toLowerCase() === `@${meUsername.toLowerCase()}`) {
            return true;
          }
        }
      }
    }

    // Method 2: Check if message text contains @username mention (fallback)
    if (message.text && meUsername) {
      const mentionPattern = new RegExp(`@${meUsername}\\b`, 'i');
      if (mentionPattern.test(message.text)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if message is a reply to the account's message
   */
  async isReplyToAccount(message, client, accountId) {
    try {
      const me = await client.getMe();
      const meId = me.id;

      // Check if message has a reply (multiple ways to check)
      const hasReply = message.replyTo || 
                      message.replyToMsgId || 
                      (message.replyTo && message.replyTo.replyToMsgId);
      
      if (!hasReply) {
        return false;
      }

      // Try to get the replied-to message
      let repliedToMessage = null;
      let replyToMsgId = null;

      // Extract reply message ID
      if (message.replyTo && message.replyTo.replyToMsgId) {
        replyToMsgId = message.replyTo.replyToMsgId;
      } else if (message.replyToMsgId) {
        replyToMsgId = message.replyToMsgId;
      } else if (message.replyTo) {
        // Try other possible properties
        replyToMsgId = message.replyTo.replyToTopId || message.replyTo.replyToMsgId;
      }

      // Method 1: Try getReplyMessage() (most reliable)
      try {
        repliedToMessage = await message.getReplyMessage();
      } catch (e) {
        // Method 2: Fetch manually using message ID
        if (replyToMsgId) {
          try {
            const chat = await message.getChat();
            const messages = await client.getMessages(chat, { ids: [replyToMsgId] });
            if (messages && messages.length > 0) {
              repliedToMessage = messages[0];
            }
          } catch (e2) {
            return false;
          }
        }
      }

      if (!repliedToMessage) {
        return false;
      }

      // Check if the replied-to message is from the account
      // Try multiple methods to check if message is from account
      let isReplyToOurMessage = false;
      
      // Method 1: Check if message.out is true (message sent by account)
      if (repliedToMessage.out === true) {
        isReplyToOurMessage = true;
      } else {
        // Method 2: Check using isMessageFromSelf
        isReplyToOurMessage = this.isMessageFromSelf(repliedToMessage, meId);
      }
      
      // Method 3: Also check senderId directly if available
      if (!isReplyToOurMessage && repliedToMessage.senderId) {
        let senderId = null;
        if (repliedToMessage.senderId.className === 'PeerUser') {
          senderId = repliedToMessage.senderId.userId;
        }
        if (senderId !== null && senderId !== undefined) {
          const senderIdNum = typeof senderId === 'bigint' ? Number(senderId) : senderId;
          const meIdNum = typeof meId === 'bigint' ? Number(meId) : meId;
          if (senderIdNum === meIdNum) {
            isReplyToOurMessage = true;
          }
        }
      }
      
      return isReplyToOurMessage;
    } catch (error) {
      console.log(`[AUTO_REPLY] Error checking reply: ${error.message}`);
      return false;
    }
  }

  /**
   * Get random delay between min and max seconds (in milliseconds)
   * Adds jitter to avoid predictable patterns
   */
  getRandomDelay(minSeconds = 3, maxSeconds = 10) {
    const minMs = minSeconds * 1000;
    const maxMs = maxSeconds * 1000;
    // Add some jitter for more natural behavior
    const baseDelay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    const jitter = Math.floor(Math.random() * 500); // 0-500ms jitter
    return baseDelay + jitter;
  }

  /**
   * Check if we can send a message (rate limiting)
   * Prevents sending messages too quickly from the same account
   */
  canSendMessage(accountId) {
    const lastSent = this.lastMessageSent.get(accountId);
    if (!lastSent) return true;
    
    const timeSinceLastMessage = Date.now() - lastSent;
    return timeSinceLastMessage >= this.MIN_MESSAGE_INTERVAL;
  }

  /**
   * Mark that a message was sent (for rate limiting)
   */
  markMessageSent(accountId) {
    this.lastMessageSent.set(accountId, Date.now());
  }

  /**
   * Process incoming message and send auto-reply if needed
   * @param {Object} message - The message object
   * @param {number} accountId - The account ID
   * @param {Object} client - The Telegram client
   * @param {boolean} immediate - If true, send reply immediately without delay (for polling mode)
   */
  async processMessage(message, accountId, client, immediate = false) {
    try {
      // Get chat information
      const chat = await message.getChat();
      if (!chat) return;

      const chatId = this.extractChatId(chat, message);
      if (!chatId) {
        console.log(`[AUTO_REPLY] Could not extract chat ID for message ${message.id}`);
        return;
      }

      const messageId = String(message.id);
      
      // Check if this specific message has already been processed (prevents duplicate processing of same message)
      // NOTE: This is per-message, not per-user. Same user can send multiple messages and each will trigger auto-reply
      if (this.hasProcessedMessage(accountId, chatId, messageId)) {
        return; // This specific message already processed
      }

      // Mark this specific message as processed (prevents duplicate event processing)
      // NOTE: Each new message from same user will have different messageId, so will trigger auto-reply
      this.markMessageProcessed(accountId, chatId, messageId);

      // Get account info
      const me = await client.getMe();
      
      // Skip if message is from ourselves
      if (this.isMessageFromSelf(message, me.id)) {
        return;
      }

      // Skip if message is from a bot
      if (await this.isSenderBot(message, client)) {
        return;
      }

      // Skip if message is empty or not text
      if (!message.text || message.text.trim().length === 0) {
        return;
      }

      // Determine chat type
      const chatType = chat.className || '';
      const isDM = chatType === 'User';
      const isGroup = chatType === 'Chat' || chat.megagroup || chat.gigagroup;
      
      // CRITICAL: Skip Saved Messages (user's own chat with themselves)
      if (isDM) {
        // Check if this is Saved Messages by comparing chat ID with account's own ID
        const chatIdNum = typeof chat.id === 'bigint' ? Number(chat.id) : Number(chat.id);
        const meIdNum = typeof me.id === 'bigint' ? Number(me.id) : Number(me.id);
        
        if (chatIdNum === meIdNum || chat.firstName === 'Saved Messages' || chat.username === 'savedmessages') {
          console.log(`[AUTO_REPLY] Skipping Saved Messages for account ${accountId}`);
          return;
        }
      }

      // Get auto-reply settings
      const settings = await configService.getAccountSettings(accountId);
      if (!settings) return;

      // Handle DM auto-reply
      // Skip if native away message is active — Telegram servers handle DM replies
      if (isDM && settings.autoReplyNativeMode) {
        return; // Native away message handles this, don't send duplicate
      }
      if (isDM && settings.autoReplyDmEnabled && settings.autoReplyDmMessage) {
        // Check cooldown (30-minute cooldown per chat to prevent spam)
        if (this.hasRepliedToChatRecently(accountId, chatId)) {
          return;
        }

        // Check client connection
        if (!client.connected) {
          console.error(`[AUTO_REPLY] Client not connected for account ${accountId}`);
          return;
        }

        // Check rate limiting before scheduling reply
        if (!this.canSendMessage(accountId)) {
          const lastSent = this.lastMessageSent.get(accountId);
          const waitTime = this.MIN_MESSAGE_INTERVAL - (Date.now() - lastSent);
          console.log(`[AUTO_REPLY] Rate limit: Waiting ${Math.ceil(waitTime/1000)}s before sending DM reply for account ${accountId}`);
          // Schedule for later when rate limit allows
          setTimeout(() => {
            this.processMessage(message, accountId, client, immediate);
          }, waitTime);
          return;
        }

        // Always add random delay (even in immediate mode) to avoid detection
        // Human-like behavior: 2-8 seconds for polling, 3-10 seconds for event-driven
        const delay = immediate ? this.getRandomDelay(2, 8) : this.getRandomDelay(3, 10);
        if (immediate) {
          console.log(`[AUTO_REPLY] Scheduling DM auto-reply for account ${accountId} in ${delay}ms (${delay/1000}s) - polling mode with human-like delay`);
        } else {
          console.log(`[AUTO_REPLY] Scheduling DM auto-reply for account ${accountId} in ${delay}ms (${delay/1000}s)`);
        }
        
        // Always use setTimeout for human-like delays (even in immediate mode)
        const sendReply = async () => {
          try {
            // Double-check rate limiting right before sending
            if (!this.canSendMessage(accountId)) {
              const lastSent = this.lastMessageSent.get(accountId);
              const waitTime = Math.max(1000, this.MIN_MESSAGE_INTERVAL - (Date.now() - lastSent)); // Ensure minimum 1 second wait
              console.log(`[AUTO_REPLY] Rate limit hit: Rescheduling DM reply for account ${accountId} in ${Math.ceil(waitTime/1000)}s`);
              setTimeout(sendReply, waitTime);
              return;
            }
            // Get fresh client connection (in case original disconnected during delay)
            const accountLinker = (await import('./accountLinker.js')).default;
            const db = (await import('../database/db.js')).default;
            const accountResult = await db.query('SELECT user_id FROM accounts WHERE account_id = ?', [accountId]);
            
            if (!accountResult.rows || accountResult.rows.length === 0) {
              console.error(`[AUTO_REPLY] Account ${accountId} not found when sending DM reply`);
              return;
            }
            
            const freshClient = await accountLinker.getClientAndConnect(accountResult.rows[0]?.user_id, accountId);
            if (!freshClient || !freshClient.connected) {
              console.error(`[AUTO_REPLY] Could not connect for DM auto-reply (account ${accountId})`);
              return;
            }

            // Set offline status before sending to ensure we don't appear online
            try {
              const { Api } = await import('telegram/tl/index.js');
              await freshClient.invoke(new Api.account.UpdateStatus({ offline: true }));
            } catch (statusError) {
              // Ignore status errors, continue with sending
            }

            await freshClient.sendMessage(chat, {
              message: settings.autoReplyDmMessage,
            });

            // Mark message as sent for rate limiting
            this.markMessageSent(accountId);

            // Set offline status again after sending to ensure we stay offline
            try {
              const { Api } = await import('telegram/tl/index.js');
              await freshClient.invoke(new Api.account.UpdateStatus({ offline: true }));
            } catch (statusError) {
              // Ignore status errors
            }
            // Mark chat as replied to enforce 30-minute cooldown
            this.markChatAsReplied(accountId, chatId);
            console.log(`[AUTO_REPLY] ✅ DM auto-reply sent for account ${accountId}`);
            
            // Log to logger bot
            try {
              const loggerBotService = (await import('./loggerBotService.js')).default;
              const db = (await import('../database/db.js')).default;
              const accountResult = await db.query('SELECT user_id FROM accounts WHERE account_id = ?', [accountId]);
              
              if (accountResult.rows && accountResult.rows.length > 0) {
                const userId = accountResult.rows[0]?.user_id;
                const chatName = chat.firstName || chat.username || chat.id || 'Unknown';
                loggerBotService.logAutoReply(userId, accountId, message, settings.autoReplyDmMessage, {
                  name: chatName,
                  type: 'DM',
                  id: chatId
                }).catch(() => {
                  // Silently fail - logger bot may not be started or user may have blocked it
                });
              }
            } catch (logError) {
              // Silently fail - don't block auto-reply if logging fails
            }
          } catch (sendError) {
            console.error(`[AUTO_REPLY] Error sending DM auto-reply:`, sendError.message);
            logError(`[AUTO_REPLY] Error sending DM auto-reply:`, sendError);
          }
        };
        
        // Always use setTimeout for human-like delays (prevents instant bot-like responses)
        setTimeout(sendReply, delay); // Schedule for later, don't wait
        return;
      }

      // Handle group auto-reply (only if mentioned or replied to account's message)
      // NOTE: No cooldown for groups - responds to EVERY mention/reply, even from same user
      // Each message has unique ID, so same user can mention/reply multiple times and get response each time
      if (isGroup && settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage) {
        // Quick check: does message have reply or potential mention?
        // Check multiple ways to detect replies
        const hasReply = message.replyTo || 
                        message.replyToMsgId || 
                        (message.replyTo && message.replyTo.replyToMsgId) ||
                        (message.replyMarkup && message.replyMarkup.replyToMsgId);
        const hasEntities = message.entities && Array.isArray(message.entities) && message.entities.length > 0;
        const mightHaveMention = hasEntities || (me.username && message.text && message.text.includes(`@${me.username}`));

        // Early exit if no reply and no potential mention
        if (!hasReply && !mightHaveMention) {
          return; // Skip group messages without reply or mention
        }

        // Check if account is mentioned (tagged/pinged)
        const isMentioned = mightHaveMention ? await this.isAccountMentioned(message, me.id, me.username) : false;
        
        // Check if message is a reply to account's message
        const isReplyToAccount = hasReply ? await this.isReplyToAccount(message, client, accountId) : false;

        // Only proceed if mentioned OR replied to account's message
        if (!isMentioned && !isReplyToAccount) {
          return; // Skip if not mentioned and not a reply to account
        }

        // NO COOLDOWN FOR GROUPS - respond to every mention/reply
        // Same user can mention/reply multiple times - each message gets a response
        // No per-user or per-chat tracking for groups - unlimited responses
        
        // Check client connection
        if (!client.connected) {
          console.error(`[AUTO_REPLY] Client not connected for account ${accountId}`);
          return;
        }

        // Check rate limiting before scheduling reply
        if (!this.canSendMessage(accountId)) {
          const lastSent = this.lastMessageSent.get(accountId);
          const waitTime = this.MIN_MESSAGE_INTERVAL - (Date.now() - lastSent);
          const triggerType = isMentioned && isReplyToAccount ? 'mention + reply' : 
                             isMentioned ? 'mention (tagged/pinged)' : 
                             'reply to account message';
          console.log(`[AUTO_REPLY] Rate limit: Waiting ${Math.ceil(waitTime/1000)}s before sending group reply for account ${accountId} (${triggerType})`);
          // Schedule for later when rate limit allows
          setTimeout(() => {
            this.processMessage(message, accountId, client, immediate);
          }, waitTime);
          return;
        }

        // Always add random delay (even in immediate mode) to avoid detection
        // Human-like behavior: 2-8 seconds for polling, 3-10 seconds for event-driven
        const delay = immediate ? this.getRandomDelay(2, 8) : this.getRandomDelay(3, 10);
        const triggerType = isMentioned && isReplyToAccount ? 'mention + reply' : 
                           isMentioned ? 'mention (tagged/pinged)' : 
                           'reply to account message';
        
        if (immediate) {
          console.log(`[AUTO_REPLY] Scheduling group auto-reply for account ${accountId} in ${delay}ms (${delay/1000}s) - polling mode with human-like delay - triggered by: ${triggerType}`);
        } else {
          console.log(`[AUTO_REPLY] Scheduling group auto-reply for account ${accountId} in ${delay}ms (${delay/1000}s) - triggered by: ${triggerType}`);
        }
        
        // Always use setTimeout for human-like delays (even in immediate mode)
        const sendGroupReply = async () => {
          try {
            // Double-check rate limiting right before sending
            if (!this.canSendMessage(accountId)) {
              const lastSent = this.lastMessageSent.get(accountId);
              const waitTime = this.MIN_MESSAGE_INTERVAL - (Date.now() - lastSent);
              const triggerType = isMentioned && isReplyToAccount ? 'mention + reply' : 
                                 isMentioned ? 'mention (tagged/pinged)' : 
                                 'reply to account message';
              console.log(`[AUTO_REPLY] Rate limit hit: Rescheduling group reply for account ${accountId} in ${Math.ceil(waitTime/1000)}s (${triggerType})`);
              setTimeout(sendGroupReply, waitTime);
              return;
            }
            // Get fresh client connection (in case original disconnected during delay)
            const accountLinker = (await import('./accountLinker.js')).default;
            const db = (await import('../database/db.js')).default;
            const accountResult = await db.query('SELECT user_id FROM accounts WHERE account_id = ?', [accountId]);
            
            if (!accountResult.rows || accountResult.rows.length === 0) {
              console.error(`[AUTO_REPLY] Account ${accountId} not found when sending group reply`);
              return;
            }
            
            const freshClient = await accountLinker.getClientAndConnect(accountResult.rows[0]?.user_id, accountId);
            if (!freshClient || !freshClient.connected) {
              console.error(`[AUTO_REPLY] Could not connect for group auto-reply (account ${accountId})`);
              return;
            }

            // Set offline status before sending to ensure we don't appear online
            try {
              const { Api } = await import('telegram/tl/index.js');
              await freshClient.invoke(new Api.account.UpdateStatus({ offline: true }));
            } catch (statusError) {
              // Ignore status errors, continue with sending
            }

            // Reply to the message that triggered the auto-reply
            await freshClient.sendMessage(chat, {
              message: settings.autoReplyGroupsMessage,
              replyTo: message, // Reply to the triggering message
            });

            // Mark message as sent for rate limiting
            this.markMessageSent(accountId);

            // Set offline status again after sending to ensure we stay offline
            try {
              const { Api } = await import('telegram/tl/index.js');
              await freshClient.invoke(new Api.account.UpdateStatus({ offline: true }));
            } catch (statusError) {
              // Ignore status errors
            }
            
            console.log(`[AUTO_REPLY] ✅ Group auto-reply sent for account ${accountId} (triggered by: ${triggerType}, replied to message ${message.id})`);
            
            // Log to logger bot
            try {
              const loggerBotService = (await import('./loggerBotService.js')).default;
              const db = (await import('../database/db.js')).default;
              const accountResult = await db.query('SELECT user_id FROM accounts WHERE account_id = ?', [accountId]);
              
              if (accountResult.rows && accountResult.rows.length > 0) {
                const userId = accountResult.rows[0]?.user_id;
                const chatName = chat.title || chat.username || chat.id || 'Unknown';
                loggerBotService.logAutoReply(userId, accountId, message, settings.autoReplyGroupsMessage, {
                  name: chatName,
                  type: 'Group',
                  id: chatId
                }).catch(() => {
                  // Silently fail - logger bot may not be started or user may have blocked it
                });
              }
            } catch (logError) {
              // Silently fail - don't block auto-reply if logging fails
            }
          } catch (sendError) {
            console.error(`[AUTO_REPLY] Error sending group auto-reply:`, sendError.message);
            logError(`[AUTO_REPLY] Error sending group auto-reply:`, sendError);
          }
        };
        
        // Always use setTimeout for human-like delays (prevents instant bot-like responses)
        setTimeout(sendGroupReply, delay); // Schedule for later, don't wait
        return;
      }
    } catch (error) {
      // Silently ignore common recoverable errors
      if (error.message && (
        error.message.includes('CHAT_ID_INVALID') ||
        error.message.includes('USER_DEACTIVATED') ||
        error.message.includes('PEER_ID_INVALID')
      )) {
        return;
      }
      logError(`[AUTO_REPLY] Error processing message:`, error);
    }
  }

  /**
   * Setup auto-reply handler for a client
   */
  async setupAutoReply(client, accountId) {
    if (!client) return;

    const clientId = client._selfId || accountId || 'unknown';
    const clientKey = `${clientId}_${accountId}`;

    // Check if handler already registered for this client/account
    if (this.registeredHandlers.has(clientKey)) {
      // Only log once per account to reduce log noise
      if (!this.loggedAlreadyRegistered.has(accountId)) {
        console.log(`[AUTO_REPLY] Handler already registered for account ${accountId}, skipping duplicate registration`);
        this.loggedAlreadyRegistered.add(accountId);
      }
      return;
    }
    
    // Clear the logged flag when registering a new handler
    this.loggedAlreadyRegistered.delete(accountId);

    // Remove existing handlers for this client (safety check)
    this.removeAutoReply(client);

    // Create event handler
    const handler = async (event) => {
      const message = event.message;
      if (!message) return;

      // Skip outgoing messages
      if (message.out === true) return;

      // Process message
      await this.processMessage(message, accountId, client);
    };

    // Register event handler
    try {
      // Use NewMessage event - it only fires for incoming messages by default
      client.addEventHandler(handler, new NewMessage({}));
      this.registeredHandlers.set(clientKey, handler);
      console.log(`[AUTO_REPLY] ✅ Handler registered for account ${accountId} (clientKey: ${clientKey})`);
    } catch (error) {
      console.error(`[AUTO_REPLY] ❌ Failed to register handler for account ${accountId}:`, error);
      logError(`[AUTO_REPLY] Failed to register handler:`, error);
    }
  }

  /**
   * Remove auto-reply handler from a client
   */
  removeAutoReply(client) {
    if (!client) return;

    try {
      const clientId = client._selfId || 'unknown';
      const handlers = client.listEventHandlers(NewMessage);
      
      for (const handler of handlers) {
        try {
          client.removeEventHandler(handler);
        } catch (e) {
          // Ignore individual handler removal errors
        }
      }

      // Clean up registered handlers map
      for (const [key, _] of this.registeredHandlers.entries()) {
        if (key.includes(clientId.toString())) {
          this.registeredHandlers.delete(key);
        }
      }
    } catch (error) {
      // Ignore errors when removing handlers
    }
  }
}

export default new AutoReplyHandler();
