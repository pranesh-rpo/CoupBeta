import accountLinker from './accountLinker.js';
import messageManager from './messageManager.js';
import messageService from './messageService.js';
import configService from './configService.js';
import loggingService from './loggingService.js';
import groupService from './groupService.js';
import broadcastStatsService from './broadcastStatsService.js';
import analyticsService from './analyticsService.js';
import notificationService from './notificationService.js';
import mentionService from './mentionService.js';
import savedTemplatesService from './savedTemplatesService.js';
import db from '../database/db.js';
import { config } from '../config.js';
import { logError } from '../utils/logger.js';
import { Api } from 'telegram';
import { getInputUser } from 'telegram/Utils.js';
import { isFloodWaitError, extractWaitTime } from '../utils/floodWaitHandler.js';
import { validateMessage } from '../utils/messageValidator.js';

/**
 * Fetch custom emoji documents to grant the account access before sending.
 * This is the reliable method - calling messages.GetCustomEmojiDocuments caches
 * the emoji documents and allows the account to use them in messages.
 * 
 * @param {TelegramClient} client - GramJS client
 * @param {Array} emojiDocumentIds - Array of emoji document IDs (BigInt)
 * @returns {Promise<boolean>} - Whether the fetch was successful
 */
async function fetchCustomEmojiDocuments(client, emojiDocumentIds) {
  if (!client || !emojiDocumentIds || emojiDocumentIds.length === 0) {
    return false;
  }

  try {
    console.log(`[PREMIUM_EMOJI] Fetching ${emojiDocumentIds.length} custom emoji documents to grant access...`);
    
    // Call messages.GetCustomEmojiDocuments to fetch and cache the emoji documents
    // This grants the account access to use these emojis
    const result = await client.invoke(
      new Api.messages.GetCustomEmojiDocuments({
        documentId: emojiDocumentIds
      })
    );
    
    if (result && result.length > 0) {
      console.log(`[PREMIUM_EMOJI] ✅ Successfully fetched ${result.length} emoji documents`);
      result.forEach((doc, idx) => {
        console.log(`[PREMIUM_EMOJI] Document ${idx}: id=${doc.id}, accessHash=${doc.accessHash ? 'present' : 'missing'}`);
      });
      return true;
    } else {
      console.log(`[PREMIUM_EMOJI] ⚠️ GetCustomEmojiDocuments returned empty result`);
      return false;
    }
  } catch (error) {
    // Check for specific error types
    const errorMessage = error?.message || error?.toString() || 'Unknown error';
    
    if (errorMessage.includes('EMOTICON_INVALID') || errorMessage.includes('400')) {
      console.log(`[PREMIUM_EMOJI] ⚠️ Some emoji IDs may be invalid: ${errorMessage}`);
    } else if (errorMessage.includes('FLOOD')) {
      console.log(`[PREMIUM_EMOJI] ⚠️ Rate limited while fetching emojis: ${errorMessage}`);
    } else {
      console.log(`[PREMIUM_EMOJI] ⚠️ Error fetching emoji documents: ${errorMessage}`);
    }
    
    // Return false but don't throw - we'll try to send anyway
    return false;
  }
}

class AutomationService {
  constructor() {
    // Store broadcasts by composite key: userId_accountId
    // This allows multiple broadcasts to run simultaneously (one per account)
    this.activeBroadcasts = new Map(); // "userId_accountId" -> { timeouts, isRunning, message, accountId, messageCount }
    this.pendingStarts = new Set(); // Track broadcast starts in progress to prevent race conditions
    
    // Anti-freeze tracking: accountId -> { rateLimitCount, lastRateLimitTime }
    this.antiFreezeTracking = new Map();
    
    // Global rate limiting tracking: accountId -> { messages: [{timestamp}], lastMessageTime }
    this.globalRateLimitTracking = new Map();
    
    // Per-group cooldown tracking: accountId -> { groupId: lastMessageTime }
    this.perGroupCooldownTracking = new Map();
    
    // CRITICAL: Circuit breaker for ban prevention
    // accountId -> { floodWaitCount, consecutiveFloodWaits, lastFloodWaitTime, isCircuitOpen, circuitOpenUntil }
    this.circuitBreakers = new Map();
    
    // CRITICAL: Ban risk tracking
    // accountId -> { errorRate, blockedUserCount, lastErrorTime, consecutiveErrors }
    this.banRiskTracking = new Map();
    
    // CRITICAL: Users who have blocked the bot (for admin broadcasts)
    // userId -> { blocked: true, lastChecked }
    this.blockedUsers = new Map();
  }
  
  /**
   * Get random delay between messages for anti-freeze protection
   * Uses custom group delay if set, otherwise uses default from config
   * @param {number} accountId - Account ID
   * @returns {Promise<number>} Delay in milliseconds
   */
  async getRandomDelay(accountId) {
    try {
      const settings = await configService.getAccountSettings(accountId);
      let minDelay, maxDelay;
      
      // Use custom group delay if set, otherwise use default from config
      if (settings?.groupDelayMin !== null && settings?.groupDelayMax !== null) {
        minDelay = settings.groupDelayMin * 1000; // Convert seconds to milliseconds
        maxDelay = settings.groupDelayMax * 1000;
      } else {
        const { minDelayBetweenMessages, maxDelayBetweenMessages } = config.antiFreeze;
        minDelay = minDelayBetweenMessages;
        maxDelay = maxDelayBetweenMessages;
      }
      
      // Fixed random delay - no adaptive increases
      // This ensures consistent delays throughout the broadcast
      const baseDelay = minDelay + Math.random() * (maxDelay - minDelay);
      
      return Math.round(baseDelay);
    } catch (error) {
      logError(`[DELAY ERROR] Error getting delay for account ${accountId}:`, error);
      // Fallback to default config values
      const { minDelayBetweenMessages, maxDelayBetweenMessages } = config.antiFreeze;
      const baseDelay = minDelayBetweenMessages + Math.random() * (maxDelayBetweenMessages - minDelayBetweenMessages);
      return Math.round(baseDelay);
    }
  }
  
  /**
   * Get global rate limit tracking for an account
   * @param {number} accountId - Account ID
   * @returns {Object} Tracking object
   */
  getGlobalRateLimitTracking(accountId) {
    let tracking = this.globalRateLimitTracking.get(accountId);
    if (!tracking) {
      tracking = {
        messages: [],
        lastMessageTime: null
      };
      this.globalRateLimitTracking.set(accountId, tracking);
    }
    
    // OPTIMIZATION: Clean up old messages (older than 1 hour) and limit array size
    const oneHourAgo = Date.now() - 3600000;
    tracking.messages = tracking.messages.filter(ts => ts > oneHourAgo);
    
    // OPTIMIZATION: Limit array size to prevent memory growth (keep only last 1000 entries)
    if (tracking.messages.length > 1000) {
      tracking.messages = tracking.messages.slice(-1000);
    }
    
    return tracking;
  }
  
  /**
   * Record a message sent for global rate limiting
   * @param {number} accountId - Account ID
   */
  recordMessageSent(accountId) {
    const tracking = this.getGlobalRateLimitTracking(accountId);
    const now = Date.now();
    tracking.messages.push(now);
    tracking.lastMessageTime = now;
    
    // Keep only last 1000 message timestamps
    if (tracking.messages.length > 1000) {
      tracking.messages = tracking.messages.slice(-1000);
    }
  }
  
  /**
   * Check if we can send a message based on global rate limits
   * @param {number} accountId - Account ID
   * @returns {Object} { canSend: boolean, waitTime: number, reason: string }
   */
  checkGlobalRateLimit(accountId) {
    const { maxMessagesPerMinute, maxMessagesPerHour } = config.antiFreeze;
    const tracking = this.getGlobalRateLimitTracking(accountId);
    const now = Date.now();
    
    // Enhanced validation
    if (!accountId || isNaN(accountId)) {
      return { canSend: false, waitTime: 0, reason: 'Invalid account ID' };
    }
    
    // Check messages per minute with improved calculation
    const messagesLastMinute = tracking.messages.filter(ts => now - ts < 60000);
    if (messagesLastMinute.length >= maxMessagesPerMinute) {
      // Calculate wait time more accurately
      if (messagesLastMinute.length > 0) {
        const oldestMessageInMinute = Math.min(...messagesLastMinute);
        const waitTime = Math.max(60000 - (now - oldestMessageInMinute) + 2000, 2000); // Add 2 second buffer
        return {
          canSend: false,
          waitTime: waitTime,
          reason: `Rate limit: ${messagesLastMinute.length}/${maxMessagesPerMinute} messages per minute`
        };
      } else {
        // Fallback if array is somehow empty
        return {
          canSend: false,
          waitTime: 60000,
          reason: `Rate limit: ${maxMessagesPerMinute} messages per minute exceeded`
        };
      }
    }
    
    // Check messages per hour with improved calculation
    const messagesLastHour = tracking.messages.filter(ts => now - ts < 3600000);
    if (messagesLastHour.length >= maxMessagesPerHour) {
      // Calculate wait time more accurately
      if (messagesLastHour.length > 0) {
        const oldestMessageInHour = Math.min(...messagesLastHour);
        const waitTime = Math.max(3600000 - (now - oldestMessageInHour) + 2000, 2000); // Add 2 second buffer
        return {
          canSend: false,
          waitTime: waitTime,
          reason: `Rate limit: ${messagesLastHour.length}/${maxMessagesPerHour} messages per hour`
        };
      } else {
        // Fallback if array is somehow empty
        return {
          canSend: false,
          waitTime: 3600000,
          reason: `Rate limit: ${maxMessagesPerHour} messages per hour exceeded`
        };
      }
    }
    
    return { canSend: true, waitTime: 0, reason: null };
  }
  
  /**
   * Check if we can send to a specific group (per-group cooldown)
   * @param {number} accountId - Account ID
   * @param {string|number} groupId - Group ID
   * @returns {Object} { canSend: boolean, waitTime: number }
   */
  checkPerGroupCooldown(accountId, groupId) {
    const { perGroupCooldown } = config.antiFreeze;
    const groupIdStr = groupId.toString();
    
    let tracking = this.perGroupCooldownTracking.get(accountId);
    if (!tracking) {
      tracking = {};
      this.perGroupCooldownTracking.set(accountId, tracking);
    }
    
    const lastMessageTime = tracking[groupIdStr];
    if (!lastMessageTime) {
      return { canSend: true, waitTime: 0 };
    }
    
    const timeSinceLastMessage = Date.now() - lastMessageTime;
    if (timeSinceLastMessage < perGroupCooldown) {
      const waitTime = perGroupCooldown - timeSinceLastMessage;
      return {
        canSend: false,
        waitTime: waitTime
      };
    }
    
    return { canSend: true, waitTime: 0 };
  }
  
  /**
   * Record a message sent to a specific group
   * @param {number} accountId - Account ID
   * @param {string|number} groupId - Group ID
   */
  recordGroupMessageSent(accountId, groupId) {
    const groupIdStr = groupId.toString();
    let tracking = this.perGroupCooldownTracking.get(accountId);
    if (!tracking) {
      tracking = {};
      this.perGroupCooldownTracking.set(accountId, tracking);
    }
    tracking[groupIdStr] = Date.now();
    
    // OPTIMIZATION: Clean up old entries periodically (not on every call) to reduce CPU usage
    // Only clean up if tracking has grown large (every 100 entries)
    const trackingSize = Object.keys(tracking).length;
    if (trackingSize > 0 && trackingSize % 100 === 0) {
      const oneDayAgo = Date.now() - 86400000;
      Object.keys(tracking).forEach(gid => {
        if (tracking[gid] < oneDayAgo) {
          delete tracking[gid];
        }
      });
    }
    
    // OPTIMIZATION: Limit tracking size per account to prevent unbounded growth
    // If tracking exceeds 10000 entries, remove oldest 20%
    if (trackingSize > 10000) {
      const entries = Object.entries(tracking).sort((a, b) => a[1] - b[1]);
      const toRemove = Math.floor(entries.length * 0.2);
      for (let i = 0; i < toRemove; i++) {
        delete tracking[entries[i][0]];
      }
    }
  }
  
  /**
   * Initialize or get anti-freeze tracking for rate limits only
   * @param {number} accountId - Account ID
   */
  getAntiFreezeTracking(accountId) {
    let tracking = this.antiFreezeTracking.get(accountId);
    if (!tracking) {
      tracking = {
        rateLimitCount: 0,
        lastRateLimitTime: null
      };
      this.antiFreezeTracking.set(accountId, tracking);
    }
    
    // Decay rate limit count over time (reduce by 1 every 10 minutes)
    if (tracking.lastRateLimitTime) {
      const now = new Date();
      const minutesSinceRateLimit = (now - tracking.lastRateLimitTime) / (1000 * 60);
      if (minutesSinceRateLimit >= 10) {
        tracking.rateLimitCount = Math.max(0, tracking.rateLimitCount - Math.floor(minutesSinceRateLimit / 10));
        if (tracking.rateLimitCount === 0) {
          tracking.lastRateLimitTime = null;
        }
      }
    }
    
    return tracking;
  }
  
  /**
   * Record rate limit event for progressive delay
   * @param {number} accountId - Account ID
   */
  recordRateLimit(accountId) {
    // Prevent Map from growing too large (limit to 1000 entries)
    if (this.antiFreezeTracking.size > 1000) {
      console.warn(`[MEMORY] Anti-freeze tracking Map is large (${this.antiFreezeTracking.size} entries), cleaning up...`);
      this.cleanupAntiFreezeTracking();
    }
    
    const tracking = this.getAntiFreezeTracking(accountId);
    
    tracking.rateLimitCount++;
    tracking.lastRateLimitTime = new Date();
    this.antiFreezeTracking.set(accountId, tracking);
    
    console.log(`[ANTI-FREEZE] Rate limit recorded for account ${accountId}, delay multiplier: ${tracking.rateLimitCount}`);
    
    // CRITICAL: Track flood waits for circuit breaker
    this.recordFloodWait(accountId);
  }
  
  /**
   * CRITICAL: Record flood wait for circuit breaker pattern
   * Automatically stops broadcast if too many flood waits occur
   * @param {number} accountId - Account ID
   */
  recordFloodWait(accountId) {
    let circuitBreaker = this.circuitBreakers.get(accountId);
    if (!circuitBreaker) {
      circuitBreaker = {
        floodWaitCount: 0,
        consecutiveFloodWaits: 0,
        lastFloodWaitTime: null,
        isCircuitOpen: false,
        circuitOpenUntil: null
      };
      this.circuitBreakers.set(accountId, circuitBreaker);
    }
    
    const now = Date.now();
    circuitBreaker.floodWaitCount++;
    circuitBreaker.consecutiveFloodWaits++;
    circuitBreaker.lastFloodWaitTime = now;
    
    // CRITICAL: Open circuit if 5 consecutive flood waits in 10 minutes
    // This prevents the bot from getting banned due to repeated rate limit violations
    if (circuitBreaker.consecutiveFloodWaits >= 5) {
      circuitBreaker.isCircuitOpen = true;
      // Keep circuit open for 30 minutes to let things cool down
      circuitBreaker.circuitOpenUntil = now + (30 * 60 * 1000);
      console.error(`[CIRCUIT_BREAKER] ⚠️ CRITICAL: Circuit opened for account ${accountId} due to ${circuitBreaker.consecutiveFloodWaits} consecutive flood waits. Broadcast will be paused for 30 minutes to prevent ban.`);
      
      // Automatically stop all broadcasts for this account
      this.stopAllBroadcastsForAccount(accountId);
    }
    
    this.circuitBreakers.set(accountId, circuitBreaker);
  }
  
  /**
   * CRITICAL: Check if circuit breaker is open (too many flood waits)
   * @param {number} accountId - Account ID
   * @returns {Object} { isOpen: boolean, canProceed: boolean, reason: string }
   */
  checkCircuitBreaker(accountId) {
    const circuitBreaker = this.circuitBreakers.get(accountId);
    if (!circuitBreaker) {
      return { isOpen: false, canProceed: true, reason: null };
    }
    
    const now = Date.now();
    
    // Reset consecutive count if last flood wait was more than 10 minutes ago
    if (circuitBreaker.lastFloodWaitTime && (now - circuitBreaker.lastFloodWaitTime) > (10 * 60 * 1000)) {
      circuitBreaker.consecutiveFloodWaits = 0;
      this.circuitBreakers.set(accountId, circuitBreaker);
    }
    
    // Check if circuit is open
    if (circuitBreaker.isCircuitOpen) {
      if (circuitBreaker.circuitOpenUntil && now < circuitBreaker.circuitOpenUntil) {
        const remainingMinutes = Math.ceil((circuitBreaker.circuitOpenUntil - now) / (60 * 1000));
        return {
          isOpen: true,
          canProceed: false,
          reason: `Circuit breaker open: Too many flood waits. Paused for ${remainingMinutes} more minutes to prevent ban.`
        };
      } else {
        // Circuit breaker timeout expired, close it
        circuitBreaker.isCircuitOpen = false;
        circuitBreaker.circuitOpenUntil = null;
        circuitBreaker.consecutiveFloodWaits = 0;
        this.circuitBreakers.set(accountId, circuitBreaker);
        console.log(`[CIRCUIT_BREAKER] Circuit closed for account ${accountId} - can proceed`);
        return { isOpen: false, canProceed: true, reason: null };
      }
    }
    
    return { isOpen: false, canProceed: true, reason: null };
  }
  
  /**
   * CRITICAL: Reset circuit breaker on successful message (no flood wait)
   * @param {number} accountId - Account ID
   */
  resetCircuitBreakerOnSuccess(accountId) {
    const circuitBreaker = this.circuitBreakers.get(accountId);
    if (circuitBreaker) {
      // Reset consecutive flood waits on successful send
      circuitBreaker.consecutiveFloodWaits = 0;
      this.circuitBreakers.set(accountId, circuitBreaker);
    }
  }
  
  /**
   * CRITICAL: Stop all broadcasts for an account (used by circuit breaker)
   * @param {number} accountId - Account ID
   */
  async stopAllBroadcastsForAccount(accountId) {
    try {
      // Find all broadcasts for this account
      for (const [broadcastKey, broadcast] of this.activeBroadcasts.entries()) {
        if (broadcast.accountId === accountId && broadcast.isRunning) {
          const userId = broadcast.userId;
          console.log(`[CIRCUIT_BREAKER] Stopping broadcast ${broadcastKey} due to circuit breaker`);
          await this.stopBroadcast(userId, accountId);
        }
      }
    } catch (error) {
      logError(`[CIRCUIT_BREAKER ERROR] Error stopping broadcasts:`, error);
    }
  }
  
  /**
   * CRITICAL: Record ban risk indicators
   * @param {number} accountId - Account ID
   * @param {string} errorType - Type of error (blocked, banned, etc.)
   */
  recordBanRisk(accountId, errorType) {
    let riskTracking = this.banRiskTracking.get(accountId);
    if (!riskTracking) {
      riskTracking = {
        errorRate: 0,
        blockedUserCount: 0,
        lastErrorTime: null,
        consecutiveErrors: 0,
        totalErrors: 0
      };
      this.banRiskTracking.set(accountId, riskTracking);
    }
    
    const now = Date.now();
    riskTracking.totalErrors++;
    riskTracking.consecutiveErrors++;
    riskTracking.lastErrorTime = now;
    
    if (errorType === 'blocked' || errorType === 'banned') {
      riskTracking.blockedUserCount++;
    }
    
    // CRITICAL: If error rate exceeds 50% in last 100 messages, pause broadcast
    // This prevents continued sending when many users have blocked
    if (riskTracking.totalErrors > 100) {
      const errorRate = (riskTracking.totalErrors / (riskTracking.totalErrors + 100)) * 100;
      riskTracking.errorRate = errorRate;
      
      if (errorRate > 50 && riskTracking.consecutiveErrors >= 10) {
        console.error(`[BAN_RISK] ⚠️ CRITICAL: High error rate (${errorRate.toFixed(1)}%) for account ${accountId}. Pausing broadcast to prevent ban.`);
        this.stopAllBroadcastsForAccount(accountId);
      }
    }
    
    this.banRiskTracking.set(accountId, riskTracking);
  }
  
  /**
   * CRITICAL: Reset ban risk tracking on successful sends
   * @param {number} accountId - Account ID
   */
  resetBanRiskOnSuccess(accountId) {
    const riskTracking = this.banRiskTracking.get(accountId);
    if (riskTracking) {
      // Reset consecutive errors on successful send
      riskTracking.consecutiveErrors = 0;
      this.banRiskTracking.set(accountId, riskTracking);
    }
  }
  
  /**
   * Add random jitter to cycle timing to avoid patterns
   * @param {number} baseIntervalMs - Base interval in milliseconds
   * @returns {number} Interval with jitter
   */
  addCycleJitter(baseIntervalMs) {
    const { cycleJitterPercent } = config.antiFreeze;
    const jitter = (Math.random() * 2 - 1) * (cycleJitterPercent / 100); // -10% to +10%
    return Math.round(baseIntervalMs * (1 + jitter));
  }
  
  /**
   * Get broadcast key for a user and account
   */
  _getBroadcastKey(userId, accountId) {
    return `${userId}_${accountId}`;
  }

  /**
   * Get custom interval for broadcast cycle (in milliseconds)
   * Default interval is 15 minutes (900000 ms)
   * Minimum interval is 11 minutes (660000 ms)
   * @param {number} accountId - Account ID
   * @returns {Promise<number>} Interval in milliseconds
   */
  async getCustomInterval(accountId) {
    try {
      const settings = await configService.getAccountSettings(accountId);
      const intervalMinutes = settings?.manualInterval;
    
      // Default to 11 minutes if not set (matches UI default)
      const defaultIntervalMinutes = 11;
      const minIntervalMinutes = 11;
      
      let finalIntervalMinutes;
      if (intervalMinutes === null || intervalMinutes === undefined) {
        finalIntervalMinutes = defaultIntervalMinutes;
        console.log(`[BROADCAST] Using default interval: ${defaultIntervalMinutes} minutes`);
      } else {
        // Ensure minimum 11 minutes
        finalIntervalMinutes = Math.max(minIntervalMinutes, intervalMinutes);
        if (intervalMinutes < minIntervalMinutes) {
          console.log(`[BROADCAST] Interval ${intervalMinutes} minutes is below minimum (${minIntervalMinutes} min), using ${minIntervalMinutes} minutes`);
        } else {
          console.log(`[BROADCAST] Using custom interval: ${finalIntervalMinutes} minutes`);
        }
      }
      
      const intervalMs = finalIntervalMinutes * 60 * 1000;
      return intervalMs;
    } catch (error) {
      logError(`[BROADCAST] Error getting custom interval:`, error);
      // Return default 11 minutes on error (matches UI default)
      return 11 * 60 * 1000;
    }
  }

  async startBroadcast(userId, message, accountIdOverride = null) {
    if (!accountLinker.isLinked(userId)) {
      return { success: false, error: 'Account not linked' };
    }

    // Allow overriding accountId for restore purposes (to restore broadcasts for inactive accounts)
    // If not provided, use the active account (normal behavior for user-initiated starts)
    // CRITICAL: Multiple broadcasts can run in parallel for the same user (one per account)
    // Each account can have its own broadcast running simultaneously
    const accountId = accountIdOverride !== null ? accountIdOverride : accountLinker.getActiveAccountId(userId);
    if (!accountId && accountId !== 0) {
      return { success: false, error: 'No account found' };
    }
    
    // Check if there's already a broadcast running for this SPECIFIC account
    // Note: Other accounts for the same user can have broadcasts running simultaneously
    const broadcastKey = this._getBroadcastKey(userId, accountId);
    
    // Atomic check: prevent race condition if multiple start requests come simultaneously
    if (this.pendingStarts.has(broadcastKey)) {
      return { success: false, error: 'Broadcast start already in progress for this account' };
    }
    
    const existingBroadcast = this.activeBroadcasts.get(broadcastKey);
    if (existingBroadcast && existingBroadcast.isRunning) {
      return { success: false, error: 'Broadcast already running for this account' };
    }
    
    // Log if user has other broadcasts running (parallel broadcasts)
    const otherBroadcasts = this.getBroadcastingAccountIds(userId);
    if (otherBroadcasts.length > 0) {
      console.log(`[BROADCAST] User ${userId} already has ${otherBroadcasts.length} broadcast(s) running for account(s): ${otherBroadcasts.join(', ')}, starting new broadcast for account ${accountId} - PARALLEL BROADCASTS`);
    }
    
    // Mark as pending to prevent concurrent starts
    this.pendingStarts.add(broadcastKey);
    
    try {
      // Check if account has required tags
      const tagsCheck = await accountLinker.checkAccountTags(accountId);
      if (!tagsCheck.hasTags) {
        this.pendingStarts.delete(broadcastKey);
        return { 
          success: false, 
          error: 'TAGS_REQUIRED',
          tagsCheck 
        };
      }
      
      const client = accountLinker.getClient(userId, accountId);
      if (!client) {
        this.pendingStarts.delete(broadcastKey);
        return { success: false, error: 'Client not available' };
      }

    // Get message with A/B variant selection and saved template support
    let broadcastMessage = message;
    let useForwardMode = false;
    let forwardMessageId = null;
    let messageEntities = null; // Declare at function scope to ensure it's available throughout
    let messageData = null; // Declare at function scope to store full message data including saved_message_id
    
    // Validate message if provided (check for empty/whitespace)
    if (broadcastMessage && typeof broadcastMessage === 'string' && broadcastMessage.trim().length === 0) {
      console.log(`[BROADCAST] Provided message is empty/whitespace, treating as null`);
      broadcastMessage = null;
    }
    
    if (!broadcastMessage) {
      let settings;
      try {
        settings = await configService.getAccountSettings(accountId);
        if (!settings) {
          console.log(`[BROADCAST] Failed to get account settings, using defaults`);
          settings = {};
        }
      } catch (settingsError) {
        logError(`[BROADCAST ERROR] Error getting account settings:`, settingsError);
        console.log(`[BROADCAST] Error getting settings, using defaults`);
        settings = {};
      }
      
      // Check if forward mode is enabled
      // Forward mode allows non-premium users to send premium emojis by forwarding
      // the LAST message from Saved Messages (user should forward a message there first)
      useForwardMode = settings?.forwardMode || false;
      
      if (useForwardMode) {
        console.log(`[BROADCAST] Forward mode enabled for account ${accountId}, will forward last message from Saved Messages`);
      }
      
      // Check if auto-mention is enabled - note: mentions only work with regular messages, not forwarded messages
      const autoMention = settings?.autoMention || false;
      if (autoMention && useForwardMode) {
        console.log(`[BROADCAST] WARNING: Auto-mention is enabled but using forward mode. Mentions cannot be added to forwarded messages.`);
        console.log(`[BROADCAST] To use mentions, disable forward mode or use regular text messages.`);
      }
      
      // If not using forward mode, get message from pool or A/B variant
      if (!useForwardMode) {
        try {
          const useMessagePool = settings?.useMessagePool || false;
          // messageData and messageEntities are already declared at function scope

          // Debug: Log message pool status
          console.log(`[BROADCAST] Start: Message Pool Enabled: ${useMessagePool}, Mode: ${settings?.messagePoolMode || 'random'}`);

          // Try message pool first if enabled
          if (useMessagePool) {
            const poolMode = settings?.messagePoolMode || 'random';
            const poolLastIndex = settings?.messagePoolLastIndex || 0;

            console.log(`[BROADCAST] Start: Trying to get message from pool (mode: ${poolMode})`);

            if (poolMode === 'random') {
              messageData = await messageService.getRandomFromPool(accountId);
              console.log(`[BROADCAST] Start: Pool random returned:`, messageData ? 'message found' : 'null');
            } else if (poolMode === 'rotate') {
              const result = await messageService.getNextFromPool(accountId, poolLastIndex);
              console.log(`[BROADCAST] Start: Pool rotate returned:`, result ? 'message found' : 'null');
              if (result) {
                messageData = { text: result.text, entities: result.entities };
                // Update last index for next rotation
                await configService.updateMessagePoolLastIndex(accountId, result.nextIndex);
              }
            } else if (poolMode === 'sequential') {
              // Sequential mode: use message index based on group index
              // This will be handled per-group in sendSingleMessageToAllGroups
              messageData = await messageService.getMessageByIndex(accountId, poolLastIndex);
              console.log(`[BROADCAST] Start: Pool sequential returned:`, messageData ? 'message found' : 'null');
              // Note: sequential index is updated per group, not here
            }
            
            if (messageData) {
              console.log(`[BROADCAST] Start: ✅ Using message from pool`);
            } else {
              console.log(`[BROADCAST] Start: ⚠️ Pool returned null, falling back to regular message`);
            }
          } else {
            console.log(`[BROADCAST] Start: Message pool disabled, using regular message`);
          }

          // Fall back to regular message if pool is empty or not enabled
          if (!messageData) {
            messageData = await messageService.getActiveMessage(accountId);
            console.log(`[BROADCAST] Start: Using regular message:`, messageData ? 'found' : 'null');
          }
          
          // If no saved_message_id found, try to get last message from Saved Messages automatically
          if (messageData && typeof messageData === 'object' && !messageData.saved_message_id) {
            try {
              const accountLinker = (await import('./accountLinker.js')).default;
              const client = await accountLinker.ensureConnected(accountId);
              if (client) {
                const me = await client.getMe();
                let savedMessagesEntity;
                try {
                  savedMessagesEntity = await client.getEntity(me);
                } catch (error) {
                  const dialogs = await client.getDialogs();
                  const savedDialog = dialogs.find(d => d.isUser && d.name === 'Saved Messages');
                  if (savedDialog) {
                    savedMessagesEntity = savedDialog.entity;
                  }
                }
                
                if (savedMessagesEntity) {
                  const messages = await client.getMessages(savedMessagesEntity, { limit: 1 });
                  if (messages && messages.length > 0) {
                    messageData.saved_message_id = messages[0].id;
                    console.log(`[BROADCAST] Auto-detected last message from Saved Messages (ID: ${messageData.saved_message_id})`);
                  }
                }
              }
            } catch (autoCheckError) {
              console.log(`[BROADCAST] Could not auto-check Saved Messages: ${autoCheckError.message}`);
            }
          }
          
          // Handle both old (string) and new (object) formats for backward compatibility
          if (messageData === null) {
            broadcastMessage = null;
          } else if (typeof messageData === 'string') {
            broadcastMessage = messageData;
          } else if (messageData && typeof messageData === 'object') {
            broadcastMessage = messageData.text || null;
            messageEntities = messageData.entities || null;
            
            // Log entities extraction
            if (messageEntities && messageEntities.length > 0) {
              const premiumEmojis = messageEntities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
              console.log(`[BROADCAST] Extracted ${messageEntities.length} entities from messageData (${premiumEmojis.length} premium emojis)`);
              if (premiumEmojis.length > 0) {
                console.log(`[BROADCAST] Premium emoji IDs extracted: ${premiumEmojis.map(e => e.custom_emoji_id).join(', ')}`);
              }
            } else {
              console.log(`[BROADCAST] ⚠️ No entities found in messageData object`);
            }
          } else {
            broadcastMessage = null;
          }
          
          // Validate message (check for empty/whitespace)
          if (broadcastMessage && typeof broadcastMessage === 'string' && broadcastMessage.trim().length === 0) {
            console.log(`[BROADCAST] Selected message is empty/whitespace, treating as null`);
            broadcastMessage = null;
          }
        } catch (messageError) {
          logError(`[BROADCAST ERROR] Error getting message:`, messageError);
          broadcastMessage = null;
          messageEntities = null;
        }
        
        if (!broadcastMessage && !useForwardMode) {
          this.pendingStarts.delete(broadcastKey);
          return { success: false, error: 'No message set. Please set a message first.' };
        }
      }
    }
    
    // Final validation: ensure we have either a message or saved template
    if (!broadcastMessage && !useForwardMode) {
      this.pendingStarts.delete(broadcastKey);
      return { success: false, error: 'No message available. Please set a message first.' };
    }
    
    // Get custom interval for broadcast cycles (minimum 11 minutes)
    const customIntervalMs = await this.getCustomInterval(accountId);
    const customIntervalMinutes = customIntervalMs / (60 * 1000);
    
    // If messageEntities wasn't set in the if block above, try to extract from messageData as fallback
    // (This can happen if useForwardMode is true, skipping the message retrieval block)
    if (!messageEntities && typeof messageData !== 'undefined' && messageData && typeof messageData === 'object' && messageData.entities) {
      messageEntities = messageData.entities;
      console.log(`[BROADCAST] Fallback: Extracted ${messageEntities.length} entities from messageData`);
    }
    
    // Final check: log what we have before storing in broadcast
    if (messageEntities && messageEntities.length > 0) {
      const premiumEmojis = messageEntities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
      console.log(`[BROADCAST] Final: Storing ${messageEntities.length} entities in broadcast data (${premiumEmojis.length} premium emojis)`);
    } else {
      console.log(`[BROADCAST] ⚠️ WARNING: No entities to store in broadcast data!`);
    }
    
    // broadcastKey is already declared above (line 66)
    // Store messageData to access saved_message_id for premium emoji forwarding
    let storedMessageData = null;
    if (typeof messageData !== 'undefined' && messageData !== null) {
      storedMessageData = messageData;
    }
    
    const broadcastData = {
      isRunning: true,
      message: broadcastMessage,
      messageEntities, // Store entities for premium emoji support
      messageData: storedMessageData, // Store full messageData including saved_message_id
      useForwardMode,
      forwardMessageId,
      timeouts: [],
      accountId,
      userId,
      messageCount: 0,
      manuallyStarted: true, // Track if broadcast was manually started by user (bypasses schedule)
      customIntervalMs, // Store custom interval for next cycle
    };

    // Set broadcast data BEFORE sending initial message (so sendSingleMessageToAllGroups can find it)
    this.activeBroadcasts.set(broadcastKey, broadcastData);

    // CRITICAL: Update database flag to prevent account linking during broadcast
    try {
      await db.query('UPDATE accounts SET is_broadcasting = 1 WHERE account_id = ?', [accountId]);
      console.log(`[BROADCAST] Updated is_broadcasting flag to true for account ${accountId}`);
    } catch (dbError) {
      logError(`[BROADCAST ERROR] Failed to update is_broadcasting flag:`, dbError);
      // Non-critical error, continue with broadcast
    }

      // Send initial 1 message to all groups AFTER broadcast data is set
      // Initial message is sent regardless of schedule (user explicitly started broadcast)
      // Schedule next cycle IMMEDIATELY (before sending) to maintain consistent timing
      console.log(`[BROADCAST] Starting broadcast for user ${userId}, sending initial message`);
      
      // Schedule next cycle BEFORE sending initial message to maintain consistent intervals
      const timeoutId = setTimeout(async () => {
        const currentBroadcast = this.activeBroadcasts.get(broadcastKey);
        if (!currentBroadcast || !currentBroadcast.isRunning) {
          return;
        }
        
        console.log(`[BROADCAST] First scheduled cycle triggered for account ${accountId} (user ${userId}) after ${customIntervalMinutes} minutes`);
        await this.sendAndScheduleNextCycle(userId, accountId);
      }, customIntervalMs);
      
      // Store timeout immediately
      const updatedBroadcast = this.activeBroadcasts.get(broadcastKey);
      if (updatedBroadcast && updatedBroadcast.isRunning) {
        updatedBroadcast.timeouts = [timeoutId];
        this.activeBroadcasts.set(broadcastKey, updatedBroadcast);
        console.log(`[BROADCAST] Scheduled next cycle in ${customIntervalMinutes} minutes for account ${accountId} (scheduled BEFORE initial send)`);
      } else {
        // Broadcast was stopped before we could set timeout, clear it
        clearTimeout(timeoutId);
        console.log(`[BROADCAST] Broadcast stopped before scheduling completed, cleared timeout for account ${accountId}`);
        return;
      }
      
      // NOW send initial message (this may take time, but next cycle is already scheduled)
      // Validate we have something to send before starting
      if (!broadcastMessage && !useForwardMode) {
        console.log(`[BROADCAST] No message available, stopping broadcast`);
        this.pendingStarts.delete(broadcastKey);
        const broadcast = this.activeBroadcasts.get(broadcastKey);
        if (broadcast) {
          if (broadcast.timeouts) {
            broadcast.timeouts.forEach(timeoutId => clearTimeout(timeoutId));
          }
          this.activeBroadcasts.delete(broadcastKey);
        }
        return { success: false, error: 'No message or saved template available' };
      }
      
      // Forward mode doesn't need forwardMessageId - it will get the last message from Saved Messages
      this.sendSingleMessageToAllGroups(userId, accountId, broadcastMessage, useForwardMode, null, true, messageEntities)
        .then(() => {
          console.log(`[BROADCAST] Initial message send completed for user ${userId}, account ${accountId}`);
        })
        .catch((error) => {
          logError(`[BROADCAST ERROR] Error in initial message send for user ${userId}:`, error);
          console.log(`[BROADCAST] Initial message send failed for user ${userId}, account ${accountId}: ${error?.message || 'Unknown error'}`);
          // Check if broadcast should be stopped due to critical error
          const currentBroadcast = this.activeBroadcasts.get(broadcastKey);
          if (currentBroadcast && currentBroadcast.isRunning) {
            // Only stop if it's a critical error (client unavailable, account deleted, etc.)
            if (error?.message && (
              error.message.includes('not found') || 
              error.message.includes('Account') ||
              error.message.includes('SESSION_REVOKED') ||
              error.message.includes('Client not available')
            )) {
              console.log(`[BROADCAST] Critical error detected, stopping broadcast`);
              this.stopBroadcast(userId, accountId).catch(stopError => {
                logError(`[BROADCAST ERROR] Error stopping broadcast after critical error:`, stopError);
              });
            }
            // Otherwise, next cycle is already scheduled, so broadcast will continue
          }
        });

      console.log(`[BROADCAST] Broadcast started with custom interval: ${customIntervalMinutes} minutes per cycle for user ${userId}`);
      this.pendingStarts.delete(broadcastKey);
      return { success: true };
    } catch (error) {
      // Ensure pending flag is cleared on error
      this.pendingStarts.delete(broadcastKey);
      // Clean up broadcast data if it was set
      const broadcast = this.activeBroadcasts.get(broadcastKey);
      if (broadcast) {
        // Clear any timeouts that were set
        if (broadcast.timeouts) {
          broadcast.timeouts.forEach(timeoutId => clearTimeout(timeoutId));
        }
        this.activeBroadcasts.delete(broadcastKey);
      }
      throw error; // Re-throw to let caller handle
    }
  }

  /**
   * Send message and schedule next cycle with custom interval
   * @param {number} userId - User ID
   * @param {number} accountId - Account ID
   */
  async sendAndScheduleNextCycle(userId, accountId) {
    const broadcastKey = this._getBroadcastKey(userId, accountId);
    const broadcast = this.activeBroadcasts.get(broadcastKey);
    if (!broadcast || !broadcast.isRunning) {
      console.log(`[BROADCAST] Broadcast not running, skipping cycle for account ${accountId}`);
      return;
    }

    try {
      // CRITICAL: Schedule next cycle FIRST (before sending) to maintain consistent timing
      // This ensures intervals are consistent regardless of how long sending takes
      let customIntervalMs = await this.getCustomInterval(accountId);
      
      // Add random jitter to avoid patterns (anti-freeze)
      customIntervalMs = this.addCycleJitter(customIntervalMs);
      
      const customIntervalMinutes = customIntervalMs / (60 * 1000);
      
      // Double-check broadcast is still running before scheduling next cycle
      const stillRunning = this.activeBroadcasts.get(broadcastKey);
      if (!stillRunning || !stillRunning.isRunning) {
        console.log(`[BROADCAST] Broadcast stopped, not scheduling next cycle for account ${accountId}`);
        return;
      }
      
      // Clear old timeout if exists
      if (stillRunning.timeouts && stillRunning.timeouts.length > 0) {
        stillRunning.timeouts.forEach(timeoutId => clearTimeout(timeoutId));
      }

      // Schedule next cycle IMMEDIATELY (before sending messages)
      // CRITICAL: Wrap timeout callback in try-catch to ensure errors don't prevent next cycle
      const timeoutId = setTimeout(async () => {
        try {
          // Double-check broadcast is still running
          const currentBroadcast = this.activeBroadcasts.get(broadcastKey);
          if (!currentBroadcast || !currentBroadcast.isRunning) {
            console.log(`[BROADCAST] Broadcast stopped before cycle could run for account ${accountId}`);
            return;
          }
          
          console.log(`[BROADCAST] Next cycle triggered for account ${accountId} (user ${userId}) after ${customIntervalMinutes} minutes`);
          await this.sendAndScheduleNextCycle(userId, accountId);
        } catch (timeoutError) {
          // CRITICAL: Catch any errors in timeout callback to prevent unhandled rejections
          logError(`[BROADCAST ERROR] Error in timeout callback for account ${accountId}:`, timeoutError);
          console.log(`[BROADCAST] Error in cycle timeout callback: ${timeoutError?.message || 'Unknown error'}`);
          
          // Try to reschedule next cycle even on error
          const errorBroadcast = this.activeBroadcasts.get(broadcastKey);
          if (errorBroadcast && errorBroadcast.isRunning) {
            try {
              const retryIntervalMs = await this.getCustomInterval(accountId);
              const retryTimeoutId = setTimeout(async () => {
                await this.sendAndScheduleNextCycle(userId, accountId);
              }, retryIntervalMs);
              errorBroadcast.timeouts = [retryTimeoutId];
              this.activeBroadcasts.set(broadcastKey, errorBroadcast);
              console.log(`[BROADCAST] Rescheduled next cycle after error in ${retryIntervalMs / (60 * 1000)} minutes`);
            } catch (rescheduleError) {
              logError(`[BROADCAST ERROR] Failed to reschedule after timeout error:`, rescheduleError);
            }
          }
        }
      }, customIntervalMs);
      
      // Update broadcast with new timeout immediately (CRITICAL: Must be done before any async operations)
      stillRunning.timeouts = [timeoutId];
      stillRunning.customIntervalMs = customIntervalMs;
      this.activeBroadcasts.set(broadcastKey, stillRunning);
      
      console.log(`[BROADCAST] Scheduled next cycle in ${customIntervalMinutes} minutes for account ${accountId} (scheduled BEFORE sending)`);

      // NOW send messages (this may take time, but next cycle is already scheduled)
      // OPTIMIZATION: Cache account settings once per cycle to avoid redundant database calls
      // Get message with A/B variant selection and saved template for this cycle
      let settings;
      try {
        settings = await configService.getAccountSettings(broadcast.accountId);
        if (!settings) {
          console.log(`[BROADCAST] Failed to get account settings, using defaults`);
          settings = {};
        }
      } catch (settingsError) {
        logError(`[BROADCAST ERROR] Error getting account settings in cycle:`, settingsError);
        settings = {};
      }
      
      // Store settings in broadcast data for reuse within this cycle
      broadcast.cachedSettings = settings;
      
      // Check forward mode - forward mode forwards the LAST message from Saved Messages
      // User should manually forward a message (with premium emojis) to Saved Messages first
      let useForwardMode = settings?.forwardMode || false;
      
      // If forward mode was enabled when broadcast started, use stored value as fallback
      if (!useForwardMode && broadcast.useForwardMode) {
        useForwardMode = broadcast.useForwardMode;
      }
      
      const savedTemplateSlot = settings?.savedTemplateSlot;
      let messageToSend = null;
      let storedEntities = null;
      let forwardMessageId = null; // Declare forwardMessageId for saved template forwarding
      
      console.log(`[BROADCAST] Cycle check - forward mode: ${useForwardMode}, forward message ID: ${forwardMessageId}, saved template slot: ${savedTemplateSlot === null ? 'null (none)' : savedTemplateSlot}`);
        
      // Check if saved template slot is active (must be explicitly 1, 2, or 3, not null/undefined)
      // Saved templates take priority over forward mode
      if (savedTemplateSlot !== null && savedTemplateSlot !== undefined && [1, 2, 3].includes(savedTemplateSlot)) {
        try {
          const template = await savedTemplatesService.getSavedTemplate(broadcast.accountId, savedTemplateSlot);
          if (template && template.messageId) {
            // Use saved template: enable forward mode and use template's message ID
            useForwardMode = true;
            forwardMessageId = template.messageId;
            console.log(`[BROADCAST] Cycle using saved template slot ${savedTemplateSlot} (message ID: ${forwardMessageId})`);
          } else {
            console.log(`[BROADCAST] Cycle - saved template slot ${savedTemplateSlot} set but template not found, using normal message or forward mode`);
          }
        } catch (templateError) {
          logError(`[BROADCAST ERROR] Error getting saved template in cycle:`, templateError);
          console.log(`[BROADCAST] Error retrieving template slot ${savedTemplateSlot}, using normal message or forward mode`);
        }
      }
        
      // If not using forward mode (and not using saved template), get message from pool or A/B variant
      if (!useForwardMode) {
        try {
          const useMessagePool = settings?.useMessagePool || false;
          
          // Debug: Log message pool status
          console.log(`[BROADCAST] Cycle: Message Pool Enabled: ${useMessagePool}, Mode: ${settings?.messagePoolMode || 'random'}`);
          
          // Try message pool first if enabled (for random and rotate modes)
          // Sequential mode is handled per-group in sendSingleMessageToAllGroups
          if (useMessagePool) {
            const poolMode = settings?.messagePoolMode || 'random';
            const poolLastIndex = settings?.messagePoolLastIndex || 0;
            
            console.log(`[BROADCAST] Cycle: Trying to get message from pool (mode: ${poolMode})`);
            
            if (poolMode === 'random') {
              const poolMessage = await messageService.getRandomFromPool(broadcast.accountId);
              console.log(`[BROADCAST] Cycle: Pool returned:`, poolMessage ? 'message found' : 'null');
              if (poolMessage) {
                messageToSend = poolMessage.text || null;
                storedEntities = poolMessage.entities || null;
                console.log(`[BROADCAST] Cycle: ✅ Selected random message from pool (${messageToSend?.substring(0, 50)}...)`);
              } else {
                console.log(`[BROADCAST] Cycle: ⚠️ Pool is empty or all messages inactive`);
              }
            } else if (poolMode === 'rotate') {
              const poolResult = await messageService.getNextFromPool(broadcast.accountId, poolLastIndex);
              console.log(`[BROADCAST] Cycle: Pool rotate returned:`, poolResult ? 'message found' : 'null');
              if (poolResult) {
                messageToSend = poolResult.text || null;
                storedEntities = poolResult.entities || null;
                // Update last index for next rotation
                await configService.updateMessagePoolLastIndex(broadcast.accountId, poolResult.nextIndex);
                console.log(`[BROADCAST] Cycle: ✅ Selected next message from pool (index ${poolResult.nextIndex})`);
              } else {
                console.log(`[BROADCAST] Cycle: ⚠️ Pool is empty or all messages inactive (rotate mode)`);
              }
            }
            // Sequential mode is handled per-group in sendSingleMessageToAllGroups, so we don't need to handle it here
          } else {
            console.log(`[BROADCAST] Cycle: Message pool disabled, using regular message`);
          }
          
          // Fall back to A/B variant message if pool is empty, not enabled, or in sequential mode
          if (!messageToSend) {
            const abMode = settings?.abMode || false;
            const abModeType = settings?.abModeType || 'single';
            const abLastVariant = settings?.abLastVariant || 'A';
            
            const messageData = await messageService.selectMessageVariant(
              broadcast.accountId,
              abMode,
              abModeType,
              abLastVariant
            );
            
            // Handle both old (string) and new (object) formats for backward compatibility
            if (messageData === null) {
              messageToSend = null;
            } else if (typeof messageData === 'string') {
              messageToSend = messageData;
            } else if (messageData && typeof messageData === 'object') {
              messageToSend = messageData.text || null;
              storedEntities = messageData.entities || null;
            } else {
              messageToSend = null;
            }
            
            // Update last variant if using rotate mode
            if (abMode && abModeType === 'rotate' && messageToSend) {
              try {
                const nextVariant = abLastVariant === 'A' ? 'B' : 'A';
                await configService.updateABLastVariant(broadcast.accountId, nextVariant);
              } catch (variantError) {
                logError(`[BROADCAST ERROR] Error updating AB variant in cycle:`, variantError);
                // Non-critical error, continue
              }
            }
          }
          
          // Validate message (check for empty/whitespace)
          if (messageToSend && typeof messageToSend === 'string' && messageToSend.trim().length === 0) {
            console.log(`[BROADCAST] Selected message is empty/whitespace, treating as null`);
            messageToSend = null;
          }
        } catch (messageError) {
          logError(`[BROADCAST ERROR] Error getting message in cycle:`, messageError);
          messageToSend = null;
        }
      } else {
        // Using forward mode - get message entities from stored broadcast data if available
        storedEntities = broadcast.messageEntities || null;
      }
        
      // Send message if we have one (this may take time, but next cycle is already scheduled)
      // CRITICAL: Wrap send in try-catch to ensure timeout is preserved even if send fails
      if (useForwardMode || (messageToSend && messageToSend.trim().length > 0)) {
        const sendStartTime = Date.now();
        try {
          // Forward mode doesn't need forwardMessageId - it will get the last message from Saved Messages
          await this.sendSingleMessageToAllGroups(userId, broadcast.accountId, messageToSend, useForwardMode, null, false, storedEntities);
          const sendDuration = ((Date.now() - sendStartTime) / 1000 / 60).toFixed(2);
          console.log(`[BROADCAST] Cycle send completed for account ${accountId} in ${sendDuration} minutes`);
        } catch (sendError) {
          // CRITICAL: Log error but don't throw - timeout is already set for next cycle
          logError(`[BROADCAST ERROR] Error sending messages in cycle for account ${accountId}:`, sendError);
          console.log(`[BROADCAST] Cycle send failed: ${sendError?.message || 'Unknown error'}, but next cycle is already scheduled`);
          
          // Check if it's a critical error that should stop the broadcast
          const errorMessage = sendError?.message || '';
          const isCriticalError = errorMessage.includes('not found') || 
                                  errorMessage.includes('Account') ||
                                  errorMessage.includes('SESSION_REVOKED') ||
                                  errorMessage.includes('Client not available') ||
                                  errorMessage.includes('not linked');
          
          if (isCriticalError) {
            console.log(`[BROADCAST] Critical error in send, stopping broadcast for account ${accountId}`);
            await this.stopBroadcast(userId, accountId);
            return; // Exit early - broadcast stopped
          }
          // Non-critical error: continue, next cycle is already scheduled
        }
      } else {
        console.log(`[BROADCAST] ⚠️ No message or template available for cycle, skipping send but keeping broadcast running`);
        loggingService.logBroadcast(broadcast.accountId, `Cycle skipped - no message or template available`, 'warning');
      }
      
      // CRITICAL: Verify timeout is still set after send completes (defensive check)
      const finalBroadcast = this.activeBroadcasts.get(broadcastKey);
      if (finalBroadcast && finalBroadcast.isRunning) {
        if (!finalBroadcast.timeouts || finalBroadcast.timeouts.length === 0) {
          console.log(`[BROADCAST] ⚠️ WARNING: Timeout missing after cycle send for account ${accountId}, rescheduling...`);
          try {
            const emergencyIntervalMs = await this.getCustomInterval(accountId);
            const emergencyTimeoutId = setTimeout(async () => {
              await this.sendAndScheduleNextCycle(userId, accountId);
            }, emergencyIntervalMs);
            finalBroadcast.timeouts = [emergencyTimeoutId];
            this.activeBroadcasts.set(broadcastKey, finalBroadcast);
            console.log(`[BROADCAST] Emergency rescheduled next cycle in ${emergencyIntervalMs / (60 * 1000)} minutes`);
          } catch (emergencyError) {
            logError(`[BROADCAST ERROR] Failed to emergency reschedule:`, emergencyError);
          }
        } else {
          console.log(`[BROADCAST] ✅ Timeout verified: next cycle scheduled for account ${accountId}`);
        }
      }
    } catch (error) {
      logError(`[BROADCAST ERROR] Error in sendAndScheduleNextCycle for account ${accountId}:`, error);
      console.log(`[BROADCAST] Error in cycle: ${error?.message || 'Unknown error'}, will retry next cycle if broadcast still running`);
      
      // Check if it's a critical error that should stop the broadcast
      const errorMessage = error?.message || '';
      const isCriticalError = errorMessage.includes('not found') || 
                              errorMessage.includes('Account') ||
                              errorMessage.includes('SESSION_REVOKED') ||
                              errorMessage.includes('Client not available') ||
                              errorMessage.includes('not linked');
      
      if (isCriticalError) {
        console.log(`[BROADCAST] Critical error detected, stopping broadcast for account ${accountId}`);
        await this.stopBroadcast(userId, accountId);
        return;
      }
      
      // Even on error, try to schedule next cycle (but with a delay to avoid rapid retries)
      const stillRunning = this.activeBroadcasts.get(broadcastKey);
      if (stillRunning && stillRunning.isRunning) {
        try {
          const customIntervalMs = await this.getCustomInterval(accountId);
          const customIntervalMinutes = customIntervalMs / (60 * 1000);
          
          const timeoutId = setTimeout(async () => {
            await this.sendAndScheduleNextCycle(userId, accountId);
          }, customIntervalMs);
          
          stillRunning.timeouts = [timeoutId];
          this.activeBroadcasts.set(broadcastKey, stillRunning);
          console.log(`[BROADCAST] Scheduled retry cycle in ${customIntervalMinutes} minutes for account ${accountId}`);
        } catch (scheduleError) {
          logError(`[BROADCAST ERROR] Error scheduling retry cycle:`, scheduleError);
          // If we can't schedule, stop the broadcast
          await this.stopBroadcast(userId, accountId);
        }
      }
    }
  }

  async stopBroadcast(userId, accountId = null) {
    try {
      // Validate userId
      if (!userId && userId !== 0) {
        console.log(`[BROADCAST] Invalid userId provided to stopBroadcast: ${userId}`);
        return { success: false, error: 'Invalid user ID' };
      }
      
      // If accountId is not provided, get the active account's broadcast
      if (!accountId && accountId !== 0) {
        accountId = accountLinker.getActiveAccountId(userId);
      }
      
      if (!accountId && accountId !== 0) {
        return { success: false, error: 'No active account found' };
      }
      
      const broadcastKey = this._getBroadcastKey(userId, accountId);
      const broadcast = this.activeBroadcasts.get(broadcastKey);
      if (!broadcast) {
        console.log(`[BROADCAST] No active broadcast found for account ${accountId} (user ${userId})`);
        return { success: false, error: 'No active broadcast found for this account' };
      }

      // Check if account has required tags before allowing stop (non-blocking if check fails)
      if (accountId) {
        try {
          const tagsCheck = await accountLinker.checkAccountTags(accountId);
          if (!tagsCheck.hasTags) {
            console.log(`[BROADCAST] Tags required but not present, stopping anyway`);
            // Continue to stop broadcast even if tags check fails
          }
        } catch (tagsError) {
          logError(`[BROADCAST ERROR] Error checking tags during stop:`, tagsError);
          // Non-critical error, continue to stop broadcast
        }
      }

      // OPTIMIZATION: Clear all scheduled timeouts atomically to prevent race conditions
      // Store timeouts array before clearing to avoid issues if broadcast is modified concurrently
      const timeoutsToClear = broadcast.timeouts && Array.isArray(broadcast.timeouts) ? [...broadcast.timeouts] : [];
      if (timeoutsToClear.length > 0) {
        timeoutsToClear.forEach(timeoutId => {
          try {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          } catch (timeoutError) {
            console.log(`[BROADCAST] Error clearing timeout: ${timeoutError?.message || 'Unknown'}`);
          }
        });
        console.log(`[BROADCAST] Cleared ${timeoutsToClear.length} scheduled messages for user ${userId}`);
      }

      // OPTIMIZATION: Mark as stopped and delete atomically to prevent race conditions
      broadcast.isRunning = false;
      this.activeBroadcasts.delete(broadcastKey);

      // CRITICAL: Update database flag to allow account linking again
      try {
        await db.query('UPDATE accounts SET is_broadcasting = 0 WHERE account_id = ?', [accountId]);
        console.log(`[BROADCAST] Updated is_broadcasting flag to false for account ${accountId}`);
      } catch (dbError) {
        logError(`[BROADCAST ERROR] Failed to update is_broadcasting flag:`, dbError);
        // Non-critical error, continue
      }

      console.log(`[BROADCAST] Broadcast stopped for account ${accountId} (user ${userId})`);
      return { success: true };
    } catch (error) {
      logError(`[BROADCAST ERROR] Error in stopBroadcast:`, error);
      // Try to clean up anyway
      try {
        if (accountId) {
          const broadcastKey = this._getBroadcastKey(userId, accountId);
          const broadcast = this.activeBroadcasts.get(broadcastKey);
          if (broadcast) {
            if (broadcast.timeouts && Array.isArray(broadcast.timeouts)) {
              broadcast.timeouts.forEach(timeoutId => {
                try {
                  if (timeoutId) clearTimeout(timeoutId);
                } catch (e) {}
              });
            }
            broadcast.isRunning = false;
            this.activeBroadcasts.delete(broadcastKey);
          }
        }
        // Try to update database flag even on error
        if (accountId) {
          try {
            await db.query('UPDATE accounts SET is_broadcasting = 0 WHERE account_id = ?', [accountId]);
          } catch (dbError) {
            // Ignore - already in error state
          }
        }
      } catch (cleanupError) {
        logError(`[BROADCAST ERROR] Error during cleanup in stopBroadcast:`, cleanupError);
      }
      return { success: false, error: `Error stopping broadcast: ${error?.message || 'Unknown error'}` };
    }
  }

  /**
   * Cleanup stopped broadcasts that are no longer running
   * This prevents memory leaks if stopBroadcast fails or is never called
   */
  cleanupStoppedBroadcasts() {
    let cleanedCount = 0;
    for (const [key, broadcast] of this.activeBroadcasts.entries()) {
      if (!broadcast.isRunning && (!broadcast.timeouts || broadcast.timeouts.length === 0)) {
        this.activeBroadcasts.delete(key);
        cleanedCount++;
        console.log(`[CLEANUP] Removed stopped broadcast ${key}`);
      }
    }
    if (cleanedCount > 0) {
      console.log(`[CLEANUP] Cleaned up ${cleanedCount} stopped broadcast(s)`);
    }
  }

  /**
   * CRITICAL: Cleanup blocked users list (remove entries older than 7 days)
   * This allows re-checking if users unblock the bot
   */
  cleanupBlockedUsers() {
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    let cleanedCount = 0;
    
    for (const [userId, info] of this.blockedUsers.entries()) {
      if (info.lastChecked && (now - info.lastChecked) > maxAge) {
        this.blockedUsers.delete(userId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`[CLEANUP] Cleaned up ${cleanedCount} old blocked user entries`);
    }
  }
  
  /**
   * Cleanup old anti-freeze tracking data to prevent memory leaks
   * Removes tracking for accounts that haven't been rate limited in 24 hours
   */
  cleanupAntiFreezeTracking() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    let cleanedCount = 0;
    
    for (const [accountId, tracking] of this.antiFreezeTracking.entries()) {
      // If no rate limit recorded or last rate limit was more than 24 hours ago
      if (!tracking.lastRateLimitTime) {
        // No rate limit recorded, remove if count is 0
        if (tracking.rateLimitCount === 0) {
          this.antiFreezeTracking.delete(accountId);
          cleanedCount++;
        }
      } else {
        // Convert Date to timestamp for comparison
        const lastRateLimitTime = tracking.lastRateLimitTime instanceof Date 
          ? tracking.lastRateLimitTime.getTime() 
          : tracking.lastRateLimitTime;
        if ((now - lastRateLimitTime) > maxAge && tracking.rateLimitCount === 0) {
          this.antiFreezeTracking.delete(accountId);
          cleanedCount++;
        }
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`[CLEANUP] Cleaned up ${cleanedCount} old anti-freeze tracking entries`);
    }
    
    // Log current memory usage
    const memUsage = process.memoryUsage();
    const memUsageMB = {
      rss: Math.round(memUsage.rss / 1024 / 1024),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024)
    };
    
    console.log(`[MEMORY] Current usage - RSS: ${memUsageMB.rss}MB, Heap: ${memUsageMB.heapUsed}/${memUsageMB.heapTotal}MB, External: ${memUsageMB.external}MB`);
    console.log(`[MEMORY] Active broadcasts: ${this.activeBroadcasts.size}, Anti-freeze tracking: ${this.antiFreezeTracking.size}, Pending starts: ${this.pendingStarts.size}`);
    
    // Warn if memory usage is high
    if (memUsageMB.rss > 2500) { // Warn if using more than 2.5GB
      console.warn(`[MEMORY WARNING] High memory usage detected: ${memUsageMB.rss}MB RSS. Consider restarting the bot.`);
    }
  }

  async checkAndResetDailyCap(accountId) {
    try {
      // Get default from config (now set to 999999, effectively unlimited)
      const defaultDailyCap = config.antiFreeze.maxMessagesPerDay || 999999;
      
      if (!accountId && accountId !== 0) {
        console.log(`[CAP] Invalid accountId provided: ${accountId}`);
        return { canSend: true, dailySent: 0, dailyCap: defaultDailyCap };
      }
      
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId, 10) : accountId;
      if (isNaN(accountIdNum)) {
        console.log(`[CAP] Could not parse accountId: ${accountId}`);
        return { canSend: true, dailySent: 0, dailyCap: defaultDailyCap };
      }
      
      const result = await db.query(
        'SELECT daily_sent, daily_cap, cap_reset_date FROM accounts WHERE account_id = $1',
        [accountIdNum]
      );
      
      if (!result || !result.rows || result.rows.length === 0) {
        console.log(`[CAP] Account ${accountIdNum} not found in database`);
        return { canSend: true, dailySent: 0, dailyCap: defaultDailyCap };
      }
      
      const account = result.rows[0];
      if (!account) {
        return { canSend: true, dailySent: 0, dailyCap: defaultDailyCap };
      }
      
      // Get today's date in IST (UTC + 5 hours 30 minutes)
      const now = new Date();
      // Add 5 hours 30 minutes (5.5 hours = 19800000 milliseconds) to UTC time for IST
      const istOffsetMs = (5 * 60 * 60 * 1000) + (30 * 60 * 1000); // 5 hours 30 minutes in milliseconds
      const istTime = new Date(now.getTime() + istOffsetMs);
      // Format as YYYY-MM-DD (en-CA format)
      const istYear = istTime.getUTCFullYear();
      const istMonth = String(istTime.getUTCMonth() + 1).padStart(2, '0');
      const istDay = String(istTime.getUTCDate()).padStart(2, '0');
      const istDateStr = `${istYear}-${istMonth}-${istDay}`;
      
      // Safely parse cap_reset_date - handle various date formats
      // The stored date is already in IST format (YYYY-MM-DD string), so we can use it directly
      let capResetDate = null;
      if (account.cap_reset_date) {
        try {
          // If it's already a string in YYYY-MM-DD format, use it directly
          if (typeof account.cap_reset_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(account.cap_reset_date)) {
            capResetDate = account.cap_reset_date;
          } else {
            // If it's a Date object or other format, parse and convert to IST
            const resetDate = new Date(account.cap_reset_date);
            if (!isNaN(resetDate.getTime())) {
              // Add IST offset to the stored date for comparison
              const resetDateIST = new Date(resetDate.getTime() + istOffsetMs);
              const resetYear = resetDateIST.getUTCFullYear();
              const resetMonth = String(resetDateIST.getUTCMonth() + 1).padStart(2, '0');
              const resetDay = String(resetDateIST.getUTCDate()).padStart(2, '0');
              capResetDate = `${resetYear}-${resetMonth}-${resetDay}`;
            }
          }
        } catch (dateError) {
          // Invalid date format, treat as null (will trigger reset)
          console.log(`[CAP] Invalid cap_reset_date format for account ${accountIdNum}, will reset`);
        }
      }
      
      // Reset if it's a new day (in IST)
      if (capResetDate !== istDateStr) {
        try {
          // Use IST date for cap reset
          await db.query(
            'UPDATE accounts SET daily_sent = 0, cap_reset_date = $1 WHERE account_id = $2',
            [istDateStr, accountIdNum]
          );
          loggingService.logInfo(accountIdNum, `Daily counter reset - new day started`, null);
          // Use account's daily_cap or default from config (for display purposes only)
          const parsedCap = account.daily_cap != null ? parseInt(account.daily_cap, 10) : NaN;
          const accountDailyCap = (!isNaN(parsedCap) && parsedCap > 0) ? parsedCap : defaultDailyCap;
          return { canSend: true, dailySent: 0, dailyCap: accountDailyCap };
        } catch (updateError) {
          logError(`[CAP ERROR] Error resetting daily counter:`, updateError);
          // Continue with current values if reset fails
        }
      }
      
      // Safely parse daily_sent - handle null, undefined, or invalid values
      const dailySent = (account.daily_sent != null && !isNaN(parseInt(account.daily_sent, 10))) 
        ? parseInt(account.daily_sent, 10) 
        : 0;
      // Use account's daily_cap or default from config (for display purposes only)
      // Daily cap enforcement removed - always allow sending
      const parsedCap = account.daily_cap != null ? parseInt(account.daily_cap, 10) : NaN;
      const accountDailyCap = (!isNaN(parsedCap) && parsedCap > 0) ? parsedCap : defaultDailyCap;
      const dailyCap = accountDailyCap;
      const canSend = true; // Always allow sending - cap enforcement removed
      
      return { canSend, dailySent, dailyCap };
    } catch (error) {
      logError(`[CAP ERROR] Error checking daily counter for account ${accountId}:`, error);
      // Use configurable default on error (defaultDailyCap already defined at top)
      return { canSend: true, dailySent: 0, dailyCap: defaultDailyCap };
    }
  }

  async incrementDailySent(accountId) {
    try {
      if (!accountId && accountId !== 0) {
        console.log(`[CAP] Invalid accountId provided for increment: ${accountId}`);
        return;
      }
      
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId, 10) : accountId;
      if (isNaN(accountIdNum)) {
        console.log(`[CAP] Could not parse accountId for increment: ${accountId}`);
        return;
      }
      
      await db.query(
        'UPDATE accounts SET daily_sent = daily_sent + 1 WHERE account_id = $1',
        [accountIdNum]
      );
    } catch (error) {
      logError(`[CAP ERROR] Error incrementing daily sent for account ${accountId}:`, error);
      // Non-critical error, don't throw - broadcast should continue
    }
  }

  async sendSingleMessageToAllGroups(userId, accountId, message, useForwardMode = false, forwardMessageId = null, bypassSchedule = false, messageEntities = null) {
    const broadcastKey = this._getBroadcastKey(userId, accountId);
    const broadcast = this.activeBroadcasts.get(broadcastKey);
    if (!broadcast || !broadcast.isRunning) {
      console.log(`[BROADCAST] Broadcast not running for account ${accountId} (user ${userId}), skipping send`);
      return;
    }
    
    // Log entities being passed to send function
    if (messageEntities && messageEntities.length > 0) {
      console.log(`[BROADCAST] Received ${messageEntities.length} entities to send (from parameter)`);
      const premiumEmojis = messageEntities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
      if (premiumEmojis.length > 0) {
        console.log(`[BROADCAST] Premium emoji entities in parameter: ${premiumEmojis.map(e => e.custom_emoji_id).join(', ')}`);
      }
    } else {
      console.log(`[BROADCAST] ⚠️ No entities in messageEntities parameter`);
      // Try to get from broadcast data
      if (broadcast.messageEntities && broadcast.messageEntities.length > 0) {
        messageEntities = broadcast.messageEntities;
        console.log(`[BROADCAST] Using entities from broadcast data: ${messageEntities.length} entities`);
      }
    }

    // OPTIMIZATION: Check schedule and quiet hours in parallel
    // Bypass schedule if:
    // 1. This is a user-initiated initial message (bypassSchedule = true)
    // 2. OR the broadcast was manually started by user (manuallyStarted = true)
    const shouldBypassSchedule = bypassSchedule || broadcast.manuallyStarted;
    
    // Run checks in parallel for better performance
    const [isWithinSchedule, isWithinQuietHours] = await Promise.all([
      shouldBypassSchedule ? Promise.resolve(true) : configService.isWithinSchedule(accountId),
      configService.isWithinQuietHours(accountId)
    ]);
    
    if (!shouldBypassSchedule && !isWithinSchedule) {
      console.log(`[BROADCAST] Current time is outside schedule window for account ${accountId}, skipping send`);
      return; // Skip this send, but keep broadcast running for next scheduled time
    } else if (shouldBypassSchedule) {
      console.log(`[BROADCAST] Bypassing schedule check (manually started broadcast or initial message) for account ${accountId}`);
    }

    // Check quiet hours (always enforced, even for manually started broadcasts)
    if (isWithinQuietHours) {
      console.log(`[BROADCAST] Current time is within quiet hours for account ${accountId}, skipping send`);
      return; // Skip this send, but keep broadcast running for next scheduled time
    }

    // Verify account still exists and is linked
    if (!accountLinker.isLinked(userId)) {
      console.log(`[BROADCAST] Account no longer linked for user ${userId}, stopping broadcast for account ${accountId}`);
      await this.stopBroadcast(userId, accountId);
      return;
    }

    // CRITICAL: We do NOT stop broadcast if account is switched
    // Broadcasts are independent per account and should continue even if user switches to another account
    // Multiple broadcasts can run in parallel for the same user (one per account)
    // The broadcast will continue for the accountId that started it, regardless of which account is currently active
    const activeAccountId = accountLinker.getActiveAccountId(userId);
    if (activeAccountId !== accountId) {
      console.log(`[BROADCAST] Account ${accountId} is no longer active for user ${userId} (active: ${activeAccountId}), but continuing broadcast for account ${accountId} - PARALLEL BROADCASTS ENABLED`);
    }
    
    // Log parallel broadcast status
    const allBroadcasts = this.getBroadcastingAccountIds(userId);
    if (allBroadcasts.length > 1) {
      console.log(`[BROADCAST] User ${userId} has ${allBroadcasts.length} parallel broadcasts running: ${allBroadcasts.join(', ')}`);
    }
    
    // broadcastKey is already declared above (line 442)
    // Re-check broadcast status after account verification
    const currentBroadcast = this.activeBroadcasts.get(broadcastKey);
    if (!currentBroadcast || !currentBroadcast.isRunning) {
      console.log(`[BROADCAST] Broadcast not found or stopped for account ${accountId}, aborting send`);
      return;
    }

    let client = null;
    try {
      // Connect client on-demand (only when sending messages)
      // CRITICAL: This works for both active and inactive accounts - accountId is explicitly provided
      try {
        client = await accountLinker.getClientAndConnect(userId, accountId);
        if (!client) {
          // Check if account still exists by trying to get the client directly
          // If getClient returns null, the account doesn't exist and we should stop the broadcast
          const accountClient = accountLinker.getClient(userId, accountId);
          if (!accountClient) {
            // Account was deleted or doesn't exist, stop broadcast
            logError(`[BROADCAST ERROR] Account ${accountId} not found (getClient returned null), stopping broadcast for user ${userId}`);
            await this.stopBroadcast(userId, accountId);
            return;
          }
          // Account exists but connection failed - log and skip this cycle, but don't stop broadcast
          // The next cycle will retry the connection
          logError(`[BROADCAST ERROR] Client connection failed for user ${userId}, account ${accountId} (account exists, will retry next cycle)`);
          console.log(`[BROADCAST] Skipping this cycle for account ${accountId}, will retry connection next cycle`);
          return; // Skip this cycle but keep broadcast running
        }
        const isInactive = accountLinker.getActiveAccountId(userId) !== accountId;
        console.log(`[BROADCAST] Connected client for account ${accountId} to send messages (inactive: ${isInactive ? 'yes' : 'no'})`);
      } catch (connectError) {
        logError(`[BROADCAST ERROR] Failed to connect client for user ${userId}, account ${accountId}:`, connectError);
        // Check if account was deleted or session revoked
        const errorMsg = connectError.message || '';
        if (errorMsg.includes('not found') || errorMsg.includes('Account') || errorMsg.includes('SESSION_REVOKED')) {
          // Account was deleted or session revoked, stop broadcast
          console.log(`[BROADCAST] Account ${accountId} not found or session revoked, stopping broadcast for user ${userId}`);
          await this.stopBroadcast(userId, accountId);
        } else {
          // Temporary connection error - log and skip this cycle, but don't stop broadcast
          // The next cycle will retry
          console.log(`[BROADCAST] Temporary connection error for account ${accountId}, skipping this cycle (will retry next cycle)`);
        }
        return;
      }

      // ALWAYS get the last message from Saved Messages for broadcasting
      // This is the new model: users send messages to Saved Messages, and we use the last one
      let savedMessagesEntity = null;
      let lastSavedMessageId = null;
      let lastSavedMessage = null;
      
      try {
        // Get Saved Messages entity (it's the "me" user)
        const me = await client.getMe();
        savedMessagesEntity = await client.getEntity(me);
        
        // Get the last message from Saved Messages
        const messages = await client.getMessages(savedMessagesEntity, {
          limit: 1,
        });
        
        if (messages && messages.length > 0) {
          lastSavedMessage = messages[0];
          lastSavedMessageId = lastSavedMessage.id;
          console.log(`[BROADCAST] ✅ Found last message from Saved Messages (ID: ${lastSavedMessageId})`);
        } else {
          console.log(`[BROADCAST] ⚠️ No messages found in Saved Messages. User should send a message to Saved Messages first.`);
        }
      } catch (error) {
        logError(`[BROADCAST ERROR] Failed to get Saved Messages or last message:`, error);
        console.log(`[BROADCAST] ⚠️ Cannot get Saved Messages: ${error.message}`);
      }
      
      // If forward mode is enabled, we'll forward the last message instead of sending
      // If forward mode is disabled, we'll still use the last message but send it normally
      const forwardMessageIdToUse = useForwardMode ? lastSavedMessageId : null;

      // Get all dialogs (chats) with error handling
      let dialogs = [];
      try {
        dialogs = await client.getDialogs();
        if (!Array.isArray(dialogs)) {
          console.log(`[BROADCAST] getDialogs returned non-array, defaulting to empty array`);
          dialogs = [];
        }
        console.log(`[BROADCAST] Retrieved ${dialogs.length} total dialogs for account ${accountId}`);
      } catch (dialogsError) {
        // Check if user deleted their Telegram account
        if (accountLinker.isUserDeletedError(dialogsError)) {
          console.log(`[BROADCAST] User deleted their Telegram account for account ${accountId} - cleaning up all data`);
          try {
            // Get user ID from account
            const accountQuery = await db.query(
              'SELECT user_id FROM accounts WHERE account_id = $1',
              [accountId]
            );
            if (accountQuery.rows.length > 0) {
              const deletedUserId = accountQuery.rows[0]?.user_id;
              await accountLinker.cleanupUserData(deletedUserId);
            }
          } catch (cleanupError) {
            console.log(`[BROADCAST] Error cleaning up user data: ${cleanupError.message}`);
          }
          await this.stopBroadcast(userId, accountId);
          return;
        }
        
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
          console.log(`[BROADCAST] Session revoked for account ${accountId} - marking for re-authentication`);
          try {
            await accountLinker.handleSessionRevoked(accountId);
          } catch (revokeError) {
            console.log(`[BROADCAST] Error handling session revocation for account ${accountId}: ${revokeError.message}`);
          }
        }
        
        logError(`[BROADCAST ERROR] Failed to get dialogs for account ${accountId}:`, dialogsError);
        console.log(`[BROADCAST] Error getting dialogs: ${dialogsError.message}, stopping broadcast`);
        await this.stopBroadcast(userId, accountId);
        return;
      }
      
      // Import groupBlacklistService dynamically to avoid circular dependencies
      const { default: groupBlacklistService } = await import('./groupBlacklistService.js');
      
      // OPTIMIZATION: Fetch all blacklisted groups once (batch check) instead of checking each group individually
      // This eliminates N+1 query problem
      const blacklistedGroupIds = await groupBlacklistService.getBlacklistedGroupIdsSet(accountId);
      console.log(`[BROADCAST] Loaded ${blacklistedGroupIds.size} blacklisted group(s) for batch filtering`);
      
      // Filter only groups (exclude channels and private chats)
      // dialog.isGroup = true for regular groups and supergroups
      // dialog.isChannel = true for channels (both broadcast and megagroup channels) - EXCLUDED
      const allGroups = dialogs.filter((dialog) => {
        if (!dialog) return false;
        
        const isGroup = dialog.isGroup || false;
        
        // Primary filter: use dialog properties (most reliable)
        // Only include groups, exclude channels
        if (isGroup) {
          const entity = dialog.entity;
          // Skip if entity is missing or invalid
          if (!entity || (!entity.id && entity.id !== 0)) {
            console.log(`[BROADCAST] ⚠️ Skipping group with missing entity: ${dialog.name || 'Unknown'}`);
            return false;
          }
          
          return true;
        }
        
        return false;
      });
      
      // Filter out blacklisted groups using Set lookup (O(1) performance)
      const groups = [];
      for (const dialog of allGroups) {
        const entity = dialog.entity;
        const groupId = entity?.id?.toString() || entity?.id || 'unknown';
        const groupName = dialog.name || 'Unknown';
        const entityType = entity?.className || 'Unknown';
        
        // OPTIMIZATION: Use Set lookup instead of database query (O(1) vs O(n))
        if (blacklistedGroupIds.has(groupId.toString())) {
          console.log(`[BROADCAST] 🚫 Skipping blacklisted group: "${groupName}" (ID: ${groupId})`);
          continue;
        }
        
        // Log each group being included for transparency
        console.log(`[BROADCAST] ✅ Including Group: "${groupName}" (Entity: ${entityType}, ID: ${groupId})`);
        groups.push(dialog);
      }

      console.log(`[BROADCAST] ✅ Filtered ${groups.length} groups from ${dialogs.length} dialogs for user ${userId}`);
      
      // Edge case: No groups to send to
      if (groups.length === 0) {
        console.log(`[BROADCAST] ⚠️ No groups found for account ${accountId}, skipping send cycle`);
        loggingService.logBroadcast(accountId, `No groups found - skipping send cycle`, 'warning');
        // Don't stop broadcast - it might be temporary (user might add groups later)
        return;
      }
      
      // Randomize group order to avoid patterns (anti-freeze)
      let groupsToSend = [...groups];
      if (config.antiFreeze.randomizeOrder && groupsToSend.length > 1) {
        // Fisher-Yates shuffle
        for (let i = groupsToSend.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [groupsToSend[i], groupsToSend[j]] = [groupsToSend[j], groupsToSend[i]];
        }
        console.log(`[ANTI-FREEZE] Randomized order of ${groupsToSend.length} groups`);
      }
      
      console.log(`[BROADCAST] Starting to send 1 message to each of ${groupsToSend.length} groups...`);

      let successCount = 0;
      let errorCount = 0;
      let rateLimited = false;

      // Cache getMe() result to avoid calling it for every group when mentions are enabled
      let cachedExcludeUserId = null;
      let meCached = false;

      // Send 1 message to each group with random delays to avoid spam detection (anti-freeze)
      const { batchSize, batchBreakDuration } = config.antiFreeze;
      
      // Track failed groups with reasons for debugging
      const failedGroups = [];
      
      for (let i = 0; i < groupsToSend.length; i++) {
        const group = groupsToSend[i];
        
        // Take a break after every batch (anti-freeze)
        if (i > 0 && i % batchSize === 0) {
          console.log(`[ANTI-FREEZE] Batch of ${batchSize} groups completed, taking ${batchBreakDuration / 1000}s break...`);
          await new Promise(resolve => setTimeout(resolve, batchBreakDuration));
        }
        // Validate group entity before processing
        if (!group || !group.entity) {
          console.log(`[BROADCAST] ⚠️ Skipping group ${i + 1}/${groupsToSend.length}: missing entity`);
          errorCount++;
          failedGroups.push({ name: group?.name || 'Unknown', reason: 'Missing entity', id: 'unknown' });
          continue;
        }
        
        const groupName = group.name || 'Unknown Group';
        const groupId = group.entity?.id?.toString() || group.entity?.id || 'unknown';
        const groupType = group.isGroup ? 'Group' : (group.isChannel ? 'Channel' : 'Unknown');
        
        console.log(`[BROADCAST] [${i + 1}/${groupsToSend.length}] Processing ${groupType}: "${groupName}" (ID: ${groupId})`);
        
        // Re-check broadcast status and client connection before each send
        const currentBroadcastCheck = this.activeBroadcasts.get(broadcastKey);
        if (!currentBroadcastCheck || !currentBroadcastCheck.isRunning) {
          console.log(`[BROADCAST] ⚠️ Broadcast stopped by user, aborting send. Processed ${i}/${groupsToSend.length} groups.`);
          break;
        }
        
        // Check if client is still connected
        if (!client || !client.connected) {
          console.log(`[BROADCAST] ⚠️ Client disconnected, attempting to reconnect...`);
          try {
            client = await accountLinker.getClientAndConnect(userId, accountId);
            if (!client || !client.connected) {
              console.log(`[BROADCAST] ⚠️ Failed to reconnect client, stopping broadcast`);
              await this.stopBroadcast(userId, accountId);
              break;
            }
            console.log(`[BROADCAST] ✅ Client reconnected successfully`);
          } catch (reconnectError) {
            logError(`[BROADCAST ERROR] Failed to reconnect client:`, reconnectError);
            await this.stopBroadcast(userId, accountId);
            break;
          }
        }

        try {
          console.log(`[BROADCAST] Attempting to send message to group ${i + 1}/${groupsToSend.length}: "${groupName}"`);
          
          // CRITICAL: Check circuit breaker first - stop if too many flood waits
          const circuitCheck = this.checkCircuitBreaker(accountId);
          if (!circuitCheck.canProceed) {
            console.error(`[CIRCUIT_BREAKER] ⚠️ CRITICAL: ${circuitCheck.reason}`);
            logError(`[CIRCUIT_BREAKER] Broadcast stopped for account ${accountId}: ${circuitCheck.reason}`);
            await this.stopBroadcast(userId, accountId);
            break; // Stop sending immediately
          }
          
          // OPTIMIZATION: Check daily cap once per cycle (not per group) to reduce database calls
          // Only check on first group for tracking purposes (daily cap enforcement removed)
          if (i === 0) {
            const dailyCapCheck = await this.checkAndResetDailyCap(accountId);
            broadcast.cachedDailyCapCheck = dailyCapCheck;
            // Daily cap enforcement removed - always allow sending
          }
          
          // SAFETY CHECK: Check global rate limits before sending
          const globalRateLimitCheck = this.checkGlobalRateLimit(accountId);
          if (!globalRateLimitCheck.canSend) {
            console.log(`[RATE_LIMIT] ⚠️ Global rate limit reached: ${globalRateLimitCheck.reason}. Waiting ${(globalRateLimitCheck.waitTime / 1000).toFixed(1)}s...`);
            await new Promise((resolve) => setTimeout(resolve, globalRateLimitCheck.waitTime));
            // Re-check after waiting
            const recheck = this.checkGlobalRateLimit(accountId);
            if (!recheck.canSend) {
              console.log(`[RATE_LIMIT] ⚠️ Still rate limited after wait. Skipping remaining groups in this cycle.`);
              // Stop this cycle but keep broadcast running for next cycle
              break;
            }
          }
          
          // SAFETY CHECK: Check per-group cooldown
          const groupCooldownCheck = this.checkPerGroupCooldown(accountId, groupId);
          if (!groupCooldownCheck.canSend) {
            console.log(`[RATE_LIMIT] ⚠️ Group "${groupName}" is in cooldown. Last message sent ${(groupCooldownCheck.waitTime / 1000 / 60).toFixed(1)} minutes ago. Skipping and continuing to next group...`);
            continue; // Skip this group and continue with next group instead of waiting
          }
          
          // Forward mode: Always forward the LAST message from Saved Messages (preserves premium emojis for non-premium users)
          // User should manually forward a message (with premium emojis) to Saved Messages first
          if (useForwardMode) {
            // Validate forward mode requirements
            if (!forwardMessageIdToUse) {
              console.log(`[BROADCAST] ⚠️ Forward mode enabled but no message found in Saved Messages for account ${accountId}. Skipping group "${groupName}". User should forward a message to Saved Messages first.`);
              errorCount++;
              failedGroups.push({ name: groupName, reason: 'No message in Saved Messages', id: groupId });
              continue; // Skip this group
            }
            
            if (!savedMessagesEntity) {
              console.log(`[BROADCAST] ⚠️ Forward mode enabled but Saved Messages entity not available for account ${accountId}. Skipping group "${groupName}".`);
              errorCount++;
              failedGroups.push({ name: groupName, reason: 'Saved Messages entity missing', id: groupId });
              continue; // Skip this group
            }
            
            if (!group.entity) {
              console.log(`[BROADCAST] ⚠️ Group entity missing for "${groupName}". Skipping.`);
              errorCount++;
              failedGroups.push({ name: groupName, reason: 'Group entity missing', id: groupId });
              continue; // Skip this group
            }
            
            // Forward the last message from Saved Messages (preserves premium emoji and entities)
            // This allows non-premium users to send premium emojis by forwarding messages
            // that were manually forwarded to Saved Messages by the user
            console.log(`[BROADCAST] Forwarding last message (ID: ${forwardMessageIdToUse}) from Saved Messages to group "${groupName}"`);
            console.log(`[BROADCAST] Forward mode: preserving premium emojis and original formatting from Saved Messages`);
            
            try {
              const forwardedResult = await client.forwardMessages(group.entity, {
                messages: [forwardMessageIdToUse],
                fromPeer: savedMessagesEntity,
                dropAuthor: false, // Preserve original author info
                dropMediaCaptions: false, // Preserve media captions if any
              });
              
              console.log(`[BROADCAST] ✅ Successfully forwarded message (ID: ${forwardMessageIdToUse}) to group ${i + 1}/${groupsToSend.length}: ${group.name || 'Unknown'}`);
              if (forwardedResult && forwardedResult.length > 0) {
                console.log(`[BROADCAST] Forwarded message result: ${forwardedResult.length} message(s) forwarded`);
              }
              
              // Record message sent for rate limiting tracking
              this.recordMessageSent(accountId);
              this.recordGroupMessageSent(accountId, groupId);
              successCount++;
            } catch (forwardError) {
              logError(`[BROADCAST ERROR] Failed to forward message to group "${groupName}":`, forwardError);
              errorCount++;
              failedGroups.push({ name: groupName, reason: forwardError.message || 'Forward failed', id: groupId });
              
              // Check if message ID is invalid (message might have been deleted from Saved Messages)
              if (forwardError.message && forwardError.message.includes('MESSAGE_ID_INVALID')) {
                console.log(`[BROADCAST] ⚠️ Forward message (ID: ${forwardMessageIdToUse}) no longer exists in Saved Messages. User should forward a new message to Saved Messages.`);
                loggingService.logError(accountId, `Forward message ID ${forwardMessageIdToUse} is invalid - message may have been deleted from Saved Messages`, userId);
              }
            }
          } else {
            // NEW MODEL: Always use the last message from Saved Messages
            // We already fetched it at the top of the function, so use it here
            let messageToUse = message;
            let entitiesToUse = messageEntities;
            let savedMessageIdToUse = lastSavedMessageId; // Use the last message we already fetched
            
            // If we have the last message from Saved Messages, use it
            if (lastSavedMessage) {
              messageToUse = lastSavedMessage.text || messageToUse;
              
              // Extract entities from the saved message if available
              if (lastSavedMessage.entities && lastSavedMessage.entities.length > 0) {
                entitiesToUse = lastSavedMessage.entities.map(e => {
                  let entityType = 'unknown';
                  
                  if (e.className === 'MessageEntityCustomEmoji' || e.constructor?.name === 'MessageEntityCustomEmoji') {
                    entityType = 'custom_emoji';
                  } else if (e.className === 'MessageEntityBold' || e.constructor?.name === 'MessageEntityBold') {
                    entityType = 'bold';
                  } else if (e.className === 'MessageEntityItalic' || e.constructor?.name === 'MessageEntityItalic') {
                    entityType = 'italic';
                  } else if (e.className === 'MessageEntityCode' || e.constructor?.name === 'MessageEntityCode') {
                    entityType = 'code';
                  } else if (e.className === 'MessageEntityPre' || e.constructor?.name === 'MessageEntityPre') {
                    entityType = 'pre';
                  }
                  
                  const entity = {
                    type: entityType,
                    offset: e.offset,
                    length: e.length,
                  };
                  
                  if (entityType === 'custom_emoji' && e.documentId !== undefined && e.documentId !== null) {
                    entity.custom_emoji_id = String(e.documentId);
                  }
                  
                  if (entityType === 'pre' && e.language !== undefined) {
                    entity.language = e.language;
                  }
                  
                  return entity;
                });
                
                console.log(`[BROADCAST] Group "${groupName}": Using last message from Saved Messages (ID: ${savedMessageIdToUse}) with ${entitiesToUse.length} entities`);
              }
            } else {
              console.log(`[BROADCAST] Group "${groupName}": ⚠️ No message in Saved Messages, using fallback message`);
            }
            
            // Log entities at start of group processing (only log if entities found or debug needed)
            if (entitiesToUse && entitiesToUse.length > 0) {
              console.log(`[BROADCAST] Group "${groupName}": Starting with ${entitiesToUse.length} entities`);
            } else {
              // Fallback: try to get from broadcast data
              if (broadcast.messageEntities && broadcast.messageEntities.length > 0) {
                entitiesToUse = broadcast.messageEntities;
                console.log(`[BROADCAST] Group "${groupName}": Using ${entitiesToUse.length} entities from broadcast data`);
              }
              // Removed verbose "No entities available" log - this is normal for plain text messages
            }
            
            // OPTIMIZATION: Use cached settings instead of fetching from database again
            const settings = broadcast.cachedSettings || await configService.getAccountSettings(accountId);
            const useMessagePool = settings?.useMessagePool || false;
            const poolMode = settings?.messagePoolMode || 'random';
            
            if (useMessagePool && poolMode === 'sequential') {
              // Sequential mode: use different message for each group
              const sequentialIndex = i; // Use group index
              const sequentialMessage = await messageService.getMessageByIndex(accountId, sequentialIndex);
              if (sequentialMessage) {
                messageToUse = sequentialMessage.text;
                entitiesToUse = sequentialMessage.entities;
                console.log(`[BROADCAST] Sequential mode: Using message ${sequentialIndex} from pool for group "${groupName}"`);
              }
            }
            
            if (!messageToUse || messageToUse.trim().length === 0) {
              console.log(`[BROADCAST] ⚠️ No message available for group "${groupName}", skipping`);
              errorCount++;
              failedGroups.push({ name: groupName, reason: 'No message available', id: groupId });
              continue;
            }
            
            // Check if we should forward from Saved Messages (if we have saved_message_id with premium emojis)
            // This is the proper way to preserve premium emojis - forward the message that already has emoji documents
            if (savedMessageIdToUse && entitiesToUse && entitiesToUse.some(e => e.type === 'custom_emoji' && e.custom_emoji_id)) {
              try {
                // Get Saved Messages entity
                const me = await client.getMe();
                let savedMessagesEntity;
                try {
                  savedMessagesEntity = await client.getEntity(me);
                } catch (error) {
                  const dialogs = await client.getDialogs();
                  const savedDialog = dialogs.find(d => d.isUser && d.name === 'Saved Messages');
                  if (savedDialog) {
                    savedMessagesEntity = savedDialog.entity;
                  } else {
                    throw new Error('Saved Messages not found');
                  }
                }
                
                console.log(`[BROADCAST] Group "${groupName}": Forwarding message ${savedMessageIdToUse} from Saved Messages to preserve premium emojis`);
                
                // Forward the message from Saved Messages (preserves premium emojis)
                const forwardedResult = await client.forwardMessages(group.entity, {
                  messages: [savedMessageIdToUse],
                  fromPeer: savedMessagesEntity,
                  dropAuthor: false,
                  dropMediaCaptions: false,
                });
                
                if (forwardedResult && forwardedResult.length > 0) {
                  console.log(`[BROADCAST] ✅ Successfully forwarded message with premium emojis to group "${groupName}"`);
                  
                  // Record message sent for rate limiting tracking
                  this.recordMessageSent(accountId);
                  this.recordGroupMessageSent(accountId, groupId);
                  successCount++;
                  continue; // Skip to next group
                } else {
                  throw new Error('Forward result was empty');
                }
              } catch (forwardError) {
                console.log(`[BROADCAST] ⚠️ Failed to forward from Saved Messages: ${forwardError?.message || 'Unknown error'}`);
                console.log(`[BROADCAST] ⚠️ Falling back to sending with entities (may not preserve emojis)`);
                // Continue with entity sending as fallback
              }
            }
            
            // Check if auto-mention is enabled
            const autoMention = settings?.autoMention || false;
            // Ensure mentionCount is valid (1, 3, or 5), default to 5
            let mentionCount = settings?.mentionCount || 5;
            if (![1, 3, 5].includes(mentionCount)) {
              console.log(`[BROADCAST] Invalid mention count ${mentionCount}, defaulting to 5`);
              mentionCount = 5;
            }
            
            // Only log auto-mention status if enabled (reduce log verbosity)
            if (autoMention) {
              console.log(`[BROADCAST] Auto-mention check for group ${group.name}: enabled=${autoMention}, count=${mentionCount}`);
            }
            
            let messageToSend = messageToUse;
            let entities = [];
            let premiumEmojiIds = [];  // Track premium emoji document IDs for fetching
            
            // Convert stored entities (from Bot API format) to GramJS format
            if (entitiesToUse && entitiesToUse.length > 0) {
              console.log(`[BROADCAST] Group "${groupName}": Processing ${entitiesToUse.length} entities`);
              
              for (const entity of entitiesToUse) {
                try {
                  if (entity.type === 'custom_emoji' && entity.custom_emoji_id) {
                    // Premium emoji entity
                    let emojiId;
                    try {
                      if (typeof entity.custom_emoji_id === 'string') {
                        emojiId = BigInt(entity.custom_emoji_id);
                      } else if (typeof entity.custom_emoji_id === 'number') {
                        emojiId = BigInt(entity.custom_emoji_id);
                      } else if (typeof entity.custom_emoji_id === 'bigint') {
                        emojiId = entity.custom_emoji_id;
                      } else {
                        console.log(`[BROADCAST] ⚠️ Invalid custom_emoji_id type: ${typeof entity.custom_emoji_id}`);
                        continue;
                      }
                      
                      // Track emoji ID for pre-fetching
                      premiumEmojiIds.push(emojiId);
                      
                      // Create MessageEntityCustomEmoji exactly as per Telegram API docs
                      // offset and length are UTF-16 code units (already correct from Bot API)
                      const emojiEntity = new Api.MessageEntityCustomEmoji({
                        offset: entity.offset,
                        length: entity.length,
                        documentId: emojiId
                      });
                      entities.push(emojiEntity);
                      console.log(`[BROADCAST] ✅ Added premium emoji entity: documentId=BigInt("${emojiId.toString()}"), offset=${entity.offset}, length=${entity.length}`);
                      console.log(`[BROADCAST] Entity format: new Api.MessageEntityCustomEmoji({ offset: ${entity.offset}, length: ${entity.length}, documentId: BigInt("${emojiId.toString()}") })`);
                    } catch (emojiError) {
                      console.log(`[BROADCAST] ⚠️ Error converting custom_emoji_id: ${emojiError.message}`);
                    }
                  } else if (entity.type === 'bold') {
                    entities.push(new Api.MessageEntityBold({
                      offset: entity.offset,
                      length: entity.length
                    }));
                  } else if (entity.type === 'italic') {
                    entities.push(new Api.MessageEntityItalic({
                      offset: entity.offset,
                      length: entity.length
                    }));
                  } else if (entity.type === 'code') {
                    entities.push(new Api.MessageEntityCode({
                      offset: entity.offset,
                      length: entity.length
                    }));
                  } else if (entity.type === 'pre') {
                    entities.push(new Api.MessageEntityPre({
                      offset: entity.offset,
                      length: entity.length,
                      language: entity.language || ''
                    }));
                  } else if (entity.type === 'text_link' && entity.url) {
                    entities.push(new Api.MessageEntityTextUrl({
                      offset: entity.offset,
                      length: entity.length,
                      url: entity.url
                    }));
                  } else if (entity.type === 'text_mention' && entity.user) {
                    entities.push(new Api.MessageEntityMentionName({
                      offset: entity.offset,
                      length: entity.length,
                      userId: BigInt(entity.user.id)
                    }));
                  }
                } catch (entityError) {
                  console.log(`[BROADCAST] Error converting entity: ${entityError.message}`);
                }
              }
              
              // CRITICAL: Fetch premium emoji documents BEFORE sending
              // This grants the account access to use these emojis
              if (premiumEmojiIds.length > 0 && client) {
                console.log(`[BROADCAST] 🎨 Message has ${premiumEmojiIds.length} premium emojis - fetching documents...`);
                await fetchCustomEmojiDocuments(client, premiumEmojiIds);
              }
            }
            
            // Add mentions if enabled
            if (autoMention) {
              console.log(`[BROADCAST] Auto-mention is ENABLED, attempting to add mentions...`);
              try {
                // Get the account's own user ID to exclude it from mentions (cache it)
                let excludeUserId = cachedExcludeUserId;
                if (!meCached) {
                try {
                  const me = await client.getMe();
                  if (me && me.id) {
                    excludeUserId = typeof me.id === 'object' && me.id.value ? Number(me.id.value) :
                                   typeof me.id === 'number' ? me.id :
                                   typeof me.id === 'bigint' ? Number(me.id) : parseInt(me.id, 10);
                      cachedExcludeUserId = excludeUserId; // Cache for next groups
                      meCached = true;
                      console.log(`[BROADCAST] Cached own user ID for mentions: ${excludeUserId}`);
                  }
                } catch (meError) {
                  console.log(`[BROADCAST] Could not get own user ID: ${meError.message}`);
                    meCached = true; // Mark as cached even if failed to avoid retrying
                  }
                } else {
                  console.log(`[BROADCAST] Using cached exclude user ID: ${excludeUserId}`);
                }
                
                // Add timeout to mention fetching to prevent it from slowing down broadcasts too much
                // Maximum 3 seconds to fetch mentions, otherwise send without mentions
                const mentionPromise = mentionService.addMentionsToMessage(
                  client,
                  group.entity,
                  message,
                  mentionCount,
                  excludeUserId
                );
                
                let timeoutId;
                const timeoutPromise = new Promise((_, reject) => {
                  timeoutId = setTimeout(() => reject(new Error('Mention fetch timeout (3s)')), 3000);
                });
                
                try {
                  const mentionResult = await Promise.race([mentionPromise, timeoutPromise]);
                  // Clear timeout if promise resolved before timeout
                  if (timeoutId) clearTimeout(timeoutId);
                  messageToSend = mentionResult.message;
                  // Merge mention entities with existing entities (premium emojis)
                  const mentionEntities = mentionResult.entities || [];
                  entities = [...entities, ...mentionEntities]; // Preserve premium emoji entities
                  console.log(`[BROADCAST] Added ${mentionEntities.length} mentions to message for group ${group.name} (total entities: ${entities.length})`);
                } catch (error) {
                  // Clear timeout if error occurred
                  if (timeoutId) clearTimeout(timeoutId);
                  console.log(`[BROADCAST] Failed to add mentions (timeout or error), sending without mentions: ${error.message}`);
                  // Continue with original message if mention fails or times out
                  // Keep existing entities (premium emojis) even if mentions fail
                  messageToSend = message;
                  // Don't clear entities - they may contain premium emojis
                }
              } catch (outerError) {
                // Handle any other errors in the mention process
                console.log(`[BROADCAST] Error in mention process: ${outerError.message}`);
                messageToSend = message;
              }
            } else {
              // Removed verbose "Auto-mention is DISABLED" log - only log when enabled
            }
            
            // Send message with entities (mentions or premium emojis)
            // Check if we have mention entities (from auto-mention) or other entities (premium emojis)
            // GramJS entities have className, Bot API entities have type
            const hasMentionEntities = entities.some(e => 
              (e.className === 'MessageEntityMentionName') || 
              (e.userId !== undefined && e.userId !== null)
            );
            // Explicitly check for premium emoji entities in GramJS format
            const hasPremiumEmojiEntities = entities.some(e => 
              (e.className === 'MessageEntityCustomEmoji') ||
              (e.documentId !== undefined && e.documentId !== null)
            );
            const hasOtherEntities = entities.some(e => 
              !((e.className === 'MessageEntityMentionName') || 
                (e.userId !== undefined && e.userId !== null))
            );
            
            if (entities.length > 0) {
              try {
                // Validate group entity before sending
                if (!group.entity) {
                  throw new Error('Group entity is missing');
                }
                
                // If we have premium emoji entities, use direct entity sending
                // If we have both mention entities and other entities (premium emojis), use direct entity sending
                // If we only have mention entities, use HTML parsing (better for mentions)
                // If we only have other entities (premium emojis), use direct entity sending
                if (hasPremiumEmojiEntities || (hasMentionEntities && hasOtherEntities)) {
                  // Send message with direct entities (for premium emojis and/or when we have both mentions and premium emojis)
                  const entityTypes = entities.map(e => e.className || e.constructor?.name || 'Unknown').join(', ');
                  console.log(`[BROADCAST] 🎨 Sending message with ${entities.length} direct entities (types: ${entityTypes})`);
                  
                  // Log premium emoji document IDs for debugging
                  if (hasPremiumEmojiEntities) {
                    const emojiEntities = entities.filter(e => 
                      (e.className === 'MessageEntityCustomEmoji') ||
                      (e.documentId !== undefined && e.documentId !== null)
                    );
                    console.log(`[BROADCAST] Premium emoji document IDs: ${emojiEntities.map(e => e.documentId?.toString() || 'N/A').join(', ')}`);
                    console.log(`[BROADCAST] ✅ Emoji documents were pre-fetched to grant access`);
                  }
                  
                  // CRITICAL: Validate message before sending (Telegram compliance)
                  const messageValidation = validateMessage(messageToSend, entities);
                  if (!messageValidation.valid) {
                    console.log(`[BROADCAST] ⚠️ Message validation failed: ${messageValidation.error}`);
                    loggingService.logError(accountId, `Message validation failed: ${messageValidation.error}`, userId);
                    errorCount++;
                    continue;
                  }
                  
                  const validatedMessage = messageValidation.sanitized || messageToSend;
                  
                  const result = await client.sendMessage(group.entity, {
                    message: validatedMessage,
                    entities: entities
                  });
                  
                  console.log(`[BROADCAST] ✅ Message sent successfully with entities. Message ID: ${result?.id || 'unknown'}`);
                  
                  // Check if entities were actually included in the sent message
                  const resultEntities = result?.entities || result?._entities || [];
                  if (resultEntities.length > 0) {
                    console.log(`[BROADCAST] ✅ Entities confirmed in sent message: ${resultEntities.length} entities`);
                    const premiumCount = resultEntities.filter(e => e.className === 'MessageEntityCustomEmoji' || e.documentId).length;
                    if (premiumCount > 0) {
                      console.log(`[BROADCAST] ✅ Premium emojis preserved: ${premiumCount} custom emoji entities`);
                    }
                  } else {
                    console.log(`[BROADCAST] ⚠️ WARNING: No entities found in sent message result!`);
                  }
                } else if (hasMentionEntities && !hasOtherEntities) {
                  // Only mentions, use HTML parsing
                  console.log(`[BROADCAST] Creating HTML-formatted message with ${entities.length} hidden mentions`);
                  
                  // Build HTML message with hidden mentions
                  // Format: <a href="tg://user?id=USER_ID">&#8203;</a> where &#8203; is zero-width space
                  // We need to work backwards to maintain correct offsets when replacing
                  let htmlMessage = messageToSend;
                  
                  // Sort entities by offset descending (work backwards to preserve offsets)
                  const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);
                  
                  for (const entity of sortedEntities) {
                    const userIdValue = typeof entity.userId === 'bigint' ? Number(entity.userId) : 
                                      typeof entity.userId === 'number' ? entity.userId : 
                                      parseInt(entity.userId, 10);
                    
                    if (isNaN(userIdValue)) {
                      console.log(`[BROADCAST] Invalid userId: ${entity.userId}, skipping`);
                      continue;
                    }
                    
                    // Replace the zero-width space at this offset with HTML anchor tag
                    // Working backwards ensures offsets remain correct
                    const before = htmlMessage.substring(0, entity.offset);
                    const mentionChar = htmlMessage.substring(entity.offset, entity.offset + entity.length);
                    const after = htmlMessage.substring(entity.offset + entity.length);
                    
                    // Create HTML anchor with zero-width space (U+200B) for truly hidden mentions
                    // Using &#8203; (zero-width space) instead of &#8204; (zero-width non-joiner)
                    // Zero-width space is more reliably invisible and doesn't render as a dot
                    const htmlMention = `<a href="tg://user?id=${userIdValue}">&#8203;</a>`;
                    
                    htmlMessage = before + htmlMention + after;
                    console.log(`[BROADCAST] ✅ Added HTML mention for userId ${userIdValue} at offset ${entity.offset}`);
                  }
                  
                  // Send message with HTML parsing mode
                  // GramJS will automatically parse the HTML and create the entities
                  console.log(`[BROADCAST] Sending message with HTML parsing mode for hidden mentions`);
                  console.log(`[BROADCAST] HTML message length: ${htmlMessage.length}`);
                  
                  const result = await client.sendMessage(group.entity, { 
                    message: htmlMessage,
                    parseMode: 'html' // Use HTML parsing mode
                  });
                  
                  console.log(`[BROADCAST] Message sent successfully with HTML mentions. Message ID: ${result?.id || 'unknown'}`);
                  
                  // Check if entities were actually included in the sent message
                  const resultEntities = result?.entities || result?._entities || [];
                  if (resultEntities.length > 0) {
                    console.log(`[BROADCAST] ✅ Entities confirmed in sent message: ${resultEntities.length} entities`);
                    resultEntities.forEach((ent, idx) => {
                      console.log(`[BROADCAST] Entity ${idx}: ${ent?.className || ent?.constructor?.name || 'Unknown'}, offset=${ent?.offset || 'N/A'}, length=${ent?.length || 'N/A'}`);
                      if (ent?.url) {
                        console.log(`[BROADCAST] Entity ${idx} URL: ${ent.url}`);
                      }
                    });
                  } else {
                    console.log(`[BROADCAST] ⚠️ WARNING: No entities found in sent message result!`);
                    console.log(`[BROADCAST] result.entities:`, result?.entities);
                    console.log(`[BROADCAST] result._entities:`, result?._entities);
                    console.log(`[BROADCAST] ⚠️ Telegram rejected the HTML mentions. Possible reasons:`);
                    console.log(`[BROADCAST]   1. User privacy settings prevent mentions`);
                    console.log(`[BROADCAST]   2. User hasn't interacted with the account`);
                    console.log(`[BROADCAST]   3. Group permissions restrict mentions`);
                    console.log(`[BROADCAST]   4. tg://user?id= may not work in groups via MTProto`);
                  }
                } else {
                  // This should not happen if premium emojis are present, but handle it as fallback
                  // Send message with direct entities
                  const entityTypes = entities.map(e => e.className || e.constructor?.name || 'Unknown').join(', ');
                  console.log(`[BROADCAST] Sending message with ${entities.length} direct entities (types: ${entityTypes})`);
                  
                  const result = await client.sendMessage(group.entity, {
                    message: messageToSend,
                    entities: entities
                  });
                  
                  console.log(`[BROADCAST] Message sent successfully with entities. Message ID: ${result?.id || 'unknown'}`);
                  
                  // Check if entities were actually included in the sent message
                  const resultEntities = result?.entities || result?._entities || [];
                  if (resultEntities.length > 0) {
                    console.log(`[BROADCAST] ✅ Entities confirmed in sent message: ${resultEntities.length} entities`);
                    resultEntities.forEach((ent, idx) => {
                      console.log(`[BROADCAST] Entity ${idx}: ${ent?.className || ent?.constructor?.name || 'Unknown'}, offset=${ent?.offset || 'N/A'}, length=${ent?.length || 'N/A'}`);
                      if (ent?.documentId) {
                        console.log(`[BROADCAST] Entity ${idx} is premium emoji: documentId=${ent.documentId}`);
                      }
                    });
                  } else {
                    console.log(`[BROADCAST] ⚠️ WARNING: No entities found in sent message result!`);
                  }
                }
              } catch (sendError) {
                console.log(`[BROADCAST] Error sending message with entities: ${sendError?.message || 'Unknown error'}`);
                console.log(`[BROADCAST] Send error details:`, sendError);
                
                // Check for premium emoji errors (900-942)
                const errorCode = sendError?.code || sendError?.errorCode || sendError?.error_code;
                const isPremiumEmojiError = errorCode >= 900 && errorCode <= 942;
                
                if (isPremiumEmojiError || (hasPremiumEmojiEntities && sendError?.message?.includes('emoji'))) {
                  console.log(`[BROADCAST] ❌ Premium emoji error (code: ${errorCode}): ${sendError?.message || 'Unknown error'}`);
                  console.log(`[BROADCAST] ⚠️ The account may not have access to the premium emoji document.`);
                  console.log(`[BROADCAST] ⚠️ Possible reasons:`);
                  console.log(`[BROADCAST]   1. The account is not a premium Telegram user`);
                  console.log(`[BROADCAST]   2. The emoji document ID is invalid or expired`);
                  console.log(`[BROADCAST]   3. The account needs to receive the emoji first to have access`);
                  console.log(`[BROADCAST] 💡 Solution: The premium user should forward the message with premium emojis to the account's Saved Messages first.`);
                  
                  // Try to resolve emoji documents if possible
                  if (hasPremiumEmojiEntities && client) {
                    try {
                      console.log(`[BROADCAST] Attempting to resolve premium emoji documents...`);
                      const premiumEmojiEntities = entities.filter(e => 
                        (e.className === 'MessageEntityCustomEmoji') ||
                        (e.documentId !== undefined && e.documentId !== null)
                      );
                      
                      // Try to get emoji documents from Telegram
                      for (const emojiEntity of premiumEmojiEntities) {
                        try {
                          const documentId = emojiEntity.documentId;
                          if (documentId) {
                            // Try to get the document to ensure account has access
                            const { Api } = await import('telegram/tl/index.js');
                            // Note: We can't directly fetch emoji documents, but we can log the attempt
                            console.log(`[BROADCAST] Emoji document ID: ${documentId}`);
                          }
                        } catch (resolveError) {
                          console.log(`[BROADCAST] Could not resolve emoji document: ${resolveError?.message}`);
                        }
                      }
                    } catch (resolveError) {
                      console.log(`[BROADCAST] Error resolving emoji documents: ${resolveError?.message}`);
                    }
                  }
                  
                  // Don't fallback for premium emoji errors - the message should fail
                  // This ensures users know the premium emojis aren't working
                  throw new Error(`Premium emoji error (${errorCode}): ${sendError?.message || 'Account may not have access to premium emoji'}`);
                }
                
                // If premium emojis are present, warn that they will be lost in fallback
                if (hasPremiumEmojiEntities) {
                  console.log(`[BROADCAST] ⚠️ WARNING: Premium emoji entities will be lost in fallback!`);
                  console.log(`[BROADCAST] ⚠️ This message contains premium emojis that cannot be sent without entities.`);
                }
                
                // Fallback: send without entities (premium emojis will be lost)
                console.log(`[BROADCAST] Falling back to sending without entities`);
                try {
                  // CRITICAL: Validate message before fallback send
                  const fallbackValidation = validateMessage(messageToSend);
                  if (!fallbackValidation.valid) {
                    console.log(`[BROADCAST] ⚠️ Fallback message validation failed: ${fallbackValidation.error}`);
                    throw new Error(`Fallback validation failed: ${fallbackValidation.error}`);
                  }
                  
                  const validatedFallbackMessage = fallbackValidation.sanitized || messageToSend;
                  
                  if (group.entity && validatedFallbackMessage && validatedFallbackMessage.trim().length > 0) {
                    await client.sendMessage(group.entity, { message: validatedFallbackMessage });
                    if (hasPremiumEmojiEntities) {
                      console.log(`[BROADCAST] ⚠️ Message sent but premium emojis were lost due to entity send error`);
                    }
                  } else {
                    throw new Error('Cannot fallback: missing entity or message');
                  }
                } catch (fallbackError) {
                  console.log(`[BROADCAST] Fallback send also failed: ${fallbackError?.message || 'Unknown error'}`);
                  throw fallbackError; // Re-throw to be handled by outer error handler
                }
              }
            } else {
              // Validate message and entity before sending
              if (!group.entity) {
                console.log(`[BROADCAST] ⚠️ Group entity missing, skipping group "${groupName}"`);
                errorCount++;
                continue;
              }
              
              // CRITICAL: Validate message content before sending (Telegram compliance)
              // Use entitiesToUse (Bot API format) for validation, or null if no entities
              const entitiesForValidation = entitiesToUse || null;
              const messageValidation = validateMessage(messageToSend, entitiesForValidation);
              if (!messageValidation.valid) {
                console.log(`[BROADCAST] ⚠️ Message validation failed for group "${groupName}": ${messageValidation.error}`);
                loggingService.logError(accountId, `Message validation failed: ${messageValidation.error}`, userId);
                errorCount++;
                continue;
              }
              
              const validatedMessage = messageValidation.sanitized || messageToSend;
              
              if (validatedMessage && validatedMessage.trim().length > 0) {
                await client.sendMessage(group.entity, { message: validatedMessage });
              } else {
                console.log(`[BROADCAST] ⚠️ Message is empty after validation, skipping group "${groupName}"`);
                errorCount++;
                continue;
              }
            }
            console.log(`[BROADCAST] ✅ Successfully sent message to group ${i + 1}/${groupsToSend.length}: "${groupName}" (ID: ${groupId})`);
          }
          
          successCount++;
          
          // CRITICAL: Reset circuit breaker and ban risk on successful send
          this.resetCircuitBreakerOnSuccess(accountId);
          this.resetBanRiskOnSuccess(accountId);
          
          // Record message sent for rate limiting tracking
          this.recordMessageSent(accountId);
          this.recordGroupMessageSent(accountId, groupId);
          
          // CRITICAL: Increment daily sent counter
          await this.incrementDailySent(accountId);
          
          loggingService.logBroadcast(accountId, `Sent message to group: ${groupName}`, 'success');
          
          // Record analytics
          analyticsService.recordGroupAnalytics(accountId, groupId, groupName, true).catch(err => {
            console.log(`[SILENT_FAIL] Analytics recording failed: ${err.message}`);
          });
          
          // Random delay between groups for anti-freeze protection (not fixed)
          // Don't delay after last group
          if (i < groupsToSend.length - 1) {
            const delayMs = await this.getRandomDelay(accountId);
            console.log(`[ANTI-FREEZE] Waiting ${(delayMs / 1000).toFixed(2)} seconds before sending to next group...`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        } catch (error) {
          // Check if it's a recoverable MTProto BinaryReader error
          const errorMsg = error?.message || error?.toString() || '';
          const errorStack = error?.stack || '';
          if (errorMsg.includes('readUInt32LE') || 
              errorMsg.includes('BinaryReader') || 
              errorMsg.includes('Cannot read properties of undefined') ||
              errorStack.includes('BinaryReader')) {
            console.log(`[BROADCAST] Recoverable MTProto BinaryReader error for group "${groupName}", retrying...`);
            // Wait a bit and retry this group
            await new Promise(resolve => setTimeout(resolve, 2000));
            try {
              // Validate group entity still exists before retry
              if (!group || !group.entity) {
                console.log(`[BROADCAST] Group entity missing during retry, skipping`);
                errorCount++;
                continue;
              }
              
              // Retry sending to this group
              if (useForwardMode && forwardMessageId && savedMessagesEntity) {
                await client.forwardMessages(group.entity, {
                  messages: [forwardMessageId],
                  fromPeer: savedMessagesEntity,
                  // Don't set dropAuthor - default behavior preserves original author username
                });
                console.log(`[BROADCAST] ✅ Retry successful: Forwarded to group "${groupName}"`);
                successCount++;
                this.recordMessageSent(accountId);
                this.recordGroupMessageSent(accountId, groupId);
                continue; // Successfully retried, move to next group
              } else if (message && message.trim().length > 0) {
                // OPTIMIZATION: Use cached settings instead of fetching from database
                let settings = broadcast.cachedSettings;
                if (!settings) {
                  try {
                    settings = await configService.getAccountSettings(accountId);
                    if (!settings) settings = {};
                    broadcast.cachedSettings = settings; // Cache for future use
                  } catch (settingsError) {
                    settings = {};
                  }
                }
                
                const autoMention = settings?.autoMention || false;
                let mentionCount = settings?.mentionCount || 5;
                if (![1, 3, 5].includes(mentionCount)) mentionCount = 5;
                
                let messageToSend = message;
                let entities = [];
                
                if (autoMention) {
                  try {
                    const mentions = await mentionService.getRandomMentions(client, group.entity, mentionCount, cachedExcludeUserId);
                    if (mentions && mentions.length > 0) {
                      messageToSend = message + '\n\n' + mentions.map(m => `@${m}`).join(' ');
                      entities = mentions.map((username, idx) => ({
                        _: 'MessageEntityMention',
                        offset: message.length + 2 + (idx > 0 ? mentions.slice(0, idx).join(' ').length + idx : 0) + 1,
                        length: username.length + 1,
                      }));
                    }
                  } catch (mentionError) {
                    // Continue with original message if mention fails
                    messageToSend = message;
                    entities = [];
                  }
                }
                
                // CRITICAL: Validate message before retry send
                const retryValidation = validateMessage(messageToSend, entities);
                if (!retryValidation.valid) {
                  console.log(`[BROADCAST] ⚠️ Retry message validation failed: ${retryValidation.error}`);
                  errorCount++;
                  continue;
                }
                
                const validatedRetryMessage = retryValidation.sanitized || messageToSend;
                
                if (validatedRetryMessage && validatedRetryMessage.trim().length > 0) {
                  await client.sendMessage(group.entity, { message: validatedRetryMessage, entities });
                  console.log(`[BROADCAST] ✅ Retry successful: Sent to group "${groupName}"`);
                  successCount++;
                  this.recordMessageSent(accountId);
                  this.recordGroupMessageSent(accountId, groupId);
                  continue; // Successfully retried, move to next group
                } else {
                  console.log(`[BROADCAST] Retry message is empty after validation, treating as error`);
                  errorCount++;
                  // Continue to error handling below
                }
              } else {
                console.log(`[BROADCAST] No message available for retry`);
                errorCount++;
                // Continue to error handling below
              }
            } catch (retryError) {
              // Check if it's a MESSAGE_ID_INVALID error during retry
              const retryErrorMessage = retryError.message || retryError.toString() || '';
              const retryErrorCode = retryError.code || retryError.errorCode || 'N/A';
              const isRetryMessageIdInvalid = retryErrorMessage.includes('MESSAGE_ID_INVALID') || 
                                             retryErrorMessage.includes('message_id_invalid') ||
                                             (retryErrorCode === 400 && retryErrorMessage.includes('MESSAGE_ID_INVALID')) ||
                                             (retryError.errorMessage && retryError.errorMessage.includes('MESSAGE_ID_INVALID'));
              
              if (isRetryMessageIdInvalid && useForwardMode && forwardMessageId) {
                console.log(`[BROADCAST] ⚠️ MESSAGE_ID_INVALID during retry: Forward message (ID: ${forwardMessageId}) no longer exists`);
                // Clear the invalid forward message ID
                try {
                  await configService.setForwardMessageId(accountId, null);
                  console.log(`[BROADCAST] ✅ Cleared invalid forward message ID for account ${accountId}`);
                } catch (clearError) {
                  console.log(`[BROADCAST] ⚠️ Could not clear invalid forward message ID: ${clearError.message}`);
                }
                errorCount++;
                failedGroups.push({ name: groupName, reason: 'Invalid forward message ID (retry)', id: groupId || 'unknown' });
                continue; // Skip this group
              }
              
              // If retry also fails, treat as normal error and continue
              console.log(`[BROADCAST] Retry failed for group "${groupName}", treating as error: ${retryError.message}`);
              errorCount++;
              // Continue to error handling below
            }
          }
          
          // Validate error object before accessing properties
          if (!error || typeof error !== 'object') {
            console.log(`[BROADCAST] Invalid error object, treating as unknown error`);
            errorCount++;
            continue;
          }
          
          // Check if user deleted their Telegram account
          if (accountLinker.isUserDeletedError(error)) {
            console.log(`[BROADCAST] User deleted their Telegram account for account ${accountId} - cleaning up all data`);
            try {
              // Get user ID from account
              const accountQuery = await db.query(
                'SELECT user_id FROM accounts WHERE account_id = $1',
                [accountId]
              );
              if (accountQuery.rows.length > 0) {
                const deletedUserId = accountQuery.rows[0]?.user_id;
                await accountLinker.cleanupUserData(deletedUserId);
              }
            } catch (cleanupError) {
              console.log(`[BROADCAST] Error cleaning up user data: ${cleanupError.message}`);
            }
            // Stop broadcast for this account
            await this.stopBroadcast(userId, accountId);
            break;
          }
          
          // Check if it's a SESSION_REVOKED error
          if (error.errorMessage === 'SESSION_REVOKED' || (error.code === 401 && error.message && error.message.includes('SESSION_REVOKED'))) {
            logError(`[BROADCAST ERROR] Session revoked for account ${accountId} during broadcast`);
            await accountLinker.handleSessionRevoked(accountId);
            // Stop broadcast for this account
            await this.stopBroadcast(userId, accountId);
            break;
          }
          
          // Check if user is banned from the channel/group
          const errorMessage = error.message || error.toString() || '';
          const errorCode = error.code || error.errorCode || error.response?.error_code || 'N/A';
          
          // Check if it's a MESSAGE_ID_INVALID error (message no longer exists in Saved Messages)
          const isMessageIdInvalid = errorMessage.includes('MESSAGE_ID_INVALID') || 
                                     errorMessage.includes('message_id_invalid') ||
                                     (errorCode === 400 && errorMessage.includes('MESSAGE_ID_INVALID')) ||
                                     (error.errorMessage && error.errorMessage.includes('MESSAGE_ID_INVALID'));
          
          if (isMessageIdInvalid && useForwardMode && forwardMessageId) {
            const errorGroupName = group.name || 'Unknown Group';
            const errorGroupId = group.entity?.id?.toString() || group.entity?.id || 'unknown';
            
            console.log(`[BROADCAST] ⚠️ MESSAGE_ID_INVALID: Forward message (ID: ${forwardMessageId}) no longer exists in Saved Messages for group "${errorGroupName}"`);
            loggingService.logError(accountId, `MESSAGE_ID_INVALID: Forward message (ID: ${forwardMessageId}) no longer exists - message may have been deleted from Saved Messages`, userId);
            
            // Clear the invalid forward message ID
            try {
              await configService.setForwardMessageId(accountId, null);
              console.log(`[BROADCAST] ✅ Cleared invalid forward message ID for account ${accountId}`);
              loggingService.logWarning(accountId, `Cleared invalid forward message ID`, userId);
            } catch (clearError) {
              console.log(`[BROADCAST] ⚠️ Could not clear invalid forward message ID: ${clearError.message}`);
            }
            
            // Skip this group and continue with others
            errorCount++;
            failedGroups.push({ name: errorGroupName, reason: 'Invalid forward message ID', id: errorGroupId });
            continue;
          }
          const isBanned = errorMessage.includes('USER_BANNED_IN_CHANNEL') || 
                          errorMessage.includes('USER_BANNED') ||
                          errorMessage.includes('CHAT_ADMIN_REQUIRED') ||
                          errorMessage.includes('CHAT_WRITE_FORBIDDEN') ||
                          (errorCode === 400 && (errorMessage.includes('BANNED') || errorMessage.includes('ADMIN_REQUIRED')));
          
          // Check for other permanent errors that should mark group as inactive
          const isPeerInvalid = errorMessage.includes('PEER_ID_INVALID') || 
                                (errorCode === 400 && errorMessage.includes('PEER_ID_INVALID'));
          const isPaymentRequired = errorMessage.includes('ALLOW_PAYMENT_REQUIRED') || 
                                     (errorCode === 406 && errorMessage.includes('ALLOW_PAYMENT_REQUIRED'));
          const isPlainForbidden = errorMessage.includes('CHAT_SEND_PLAIN_FORBIDDEN') || 
                                   (errorCode === 403 && errorMessage.includes('CHAT_SEND_PLAIN_FORBIDDEN'));
          
          // Determine error reason for logging (before checking updates channel)
          let errorReason = 'unknown error';
          if (isBanned || isPeerInvalid || isPaymentRequired || isPlainForbidden) {
            if (isBanned) {
              errorReason = 'User banned or no permission';
            } else if (isPeerInvalid) {
              errorReason = 'Invalid peer (group/channel may be deleted)';
            } else if (isPaymentRequired) {
              errorReason = 'Payment required to send messages';
            } else if (isPlainForbidden) {
              errorReason = 'Plain text messages forbidden';
            }
          }
          
          // Handle permanent errors (banned, invalid peer, payment required, plain text forbidden)
          if (isBanned || isPeerInvalid || isPaymentRequired || isPlainForbidden) {
            // Check if this is one of the updates channels - never leave them
            // Use accountLinker's isUpdatesChannel method for robust checking
            const isUpdatesChannel = await accountLinker.isUpdatesChannel(
              { 
                name: group.name, 
                username: group.entity?.username,
                id: group.entity?.id,
                entity: group.entity
              },
              client
            );
            
            if (isUpdatesChannel) {
              const groupNameSafe = group?.name || groupName || 'Unknown Group';
              console.log(`[BROADCAST] Skipping updates channel "${groupNameSafe}" - never leave it even if banned`);
              // Still mark as error but don't leave
              errorCount++;
              failedGroups.push({ name: groupNameSafe, reason: `Updates channel - ${errorReason}`, id: groupId || 'unknown' });
              continue; // Skip this group
            }
            
            // Mark group as inactive and try to leave
            // groupId is already available from earlier in the function
            const groupNameSafe = group?.name || groupName || 'Unknown Group';
            console.log(`[BROADCAST] ${errorReason} for group "${groupNameSafe}" (${groupId || 'unknown'}), marking as inactive...`);
            
            if (groupId) {
              await groupService.markGroupInactive(accountId, groupId);
              loggingService.logError(accountId, `${errorReason}: ${groupNameSafe} - marked as inactive`, userId);
            } else {
              console.log(`[BROADCAST] Warning: Could not get group ID for "${groupNameSafe}", skipping database update`);
              loggingService.logError(accountId, `${errorReason}: ${groupNameSafe} - could not get group ID`, userId);
            }
            
            // Try to leave the group/channel using the entity directly
            try {
              const groupEntity = group?.entity;
              if (groupEntity) {
                if (groupEntity.broadcast || groupEntity.megagroup) {
                  // It's a channel or supergroup - leave it
                  await client.invoke(
                    new Api.channels.LeaveChannel({
                      channel: groupEntity,
                    })
                  );
                  console.log(`[GROUPS] Left channel/supergroup "${groupNameSafe}" (${groupId || 'unknown'})`);
                  loggingService.logInfo(accountId, `Left channel: ${groupNameSafe}`, userId);
                } else {
                  // It's a regular group - delete dialog (leave)
                  await client.deleteDialog(groupEntity);
                  console.log(`[GROUPS] Left group "${groupNameSafe}" (${groupId || 'unknown'})`);
                  loggingService.logInfo(accountId, `Left group: ${groupNameSafe}`, userId);
                }
              } else {
                console.log(`[GROUPS] Could not leave group "${groupNameSafe}": group entity not available`);
              }
            } catch (leaveError) {
              // If we can't leave, that's okay - we've already marked it as inactive
              // For PEER_ID_INVALID, we might not be able to leave since the peer is invalid
              const leaveErrorMessage = leaveError?.message || 'Unknown error';
              if (isPeerInvalid) {
                console.log(`[GROUPS] Cannot leave invalid peer "${groupNameSafe}": ${leaveErrorMessage}`);
              } else {
                console.log(`[GROUPS] Could not leave group "${groupNameSafe}": ${leaveErrorMessage}`);
                loggingService.logWarning(accountId, `Could not leave group ${groupNameSafe}: ${leaveErrorMessage}`, userId);
              }
            }
            
            errorCount++;
            // Continue to next group
            continue;
          }
          
          // CRITICAL: Record ban risk for any error
          this.recordBanRisk(accountId, errorReason || 'error');
          
          // Enhanced error logging with full error details
          const errorGroupName = group.name || 'Unknown Group';
          const errorGroupId = group.entity?.id?.toString() || group.entity?.id || 'unknown';
          const errorType = error.constructor?.name || 'Error';
          
          // Add to failed groups tracking
          // errorMessage and errorCode are already declared above
          // errorReason is already declared earlier, so just assign to it (only if not already set by permanent error handling)
          if (errorReason === 'unknown error') {
            errorReason = errorCode === 429 || isFloodWaitError(error) ? 'Flood wait (retry failed)' :
                         errorMessage.includes('TIMEOUT') ? 'Timeout' :
                         errorMessage.includes('network') ? 'Network error' :
                         errorMessage.includes('connection') ? 'Connection error' :
                         errorCode !== 'N/A' ? `Error code ${errorCode}` : 'Unknown error';
          }
          failedGroups.push({ name: errorGroupName, reason: errorReason, id: errorGroupId });
          const errorDetails = {
            message: error.message || 'Unknown error',
            code: errorCode,
            type: errorType,
            stack: error.stack ? error.stack.substring(0, 500) : 'No stack trace',
            error: error.toString(),
            response: error.response ? JSON.stringify(error.response).substring(0, 200) : 'No response'
          };
          
          console.log(`[BROADCAST] ❌ Failed to send to group "${errorGroupName}" (ID: ${errorGroupId})`);
          console.log(`[BROADCAST] Error Type: ${errorType}, Code: ${errorCode}, Message: ${errorDetails.message}`);
          console.log(`[BROADCAST] Full error:`, errorDetails);
          logError(`[BROADCAST ERROR] Error sending to ${errorGroupName}:`, error);
          loggingService.logError(accountId, `Error sending to ${errorGroupName}: ${errorDetails.message} (Code: ${errorCode}, Type: ${errorType})`, userId);
          
          // Record analytics for failure
          analyticsService.recordGroupAnalytics(accountId, errorGroupId, errorGroupName, false, errorDetails.message).catch(err => {
            console.log(`[SILENT_FAIL] Analytics recording failed: ${err.message}`);
          });
          
          // CRITICAL: Check for bot blocked errors (user blocked the bot)
          // Note: errorMessage and errorCode are already declared above at line 1825-1826
          const isBotBlocked = errorMessage.includes('bot was blocked') ||
                              errorMessage.includes('bot blocked') ||
                              errorMessage.includes('BLOCKED') ||
                              errorCode === 403 && (errorMessage.includes('blocked') || errorMessage.includes('forbidden'));
          
          if (isBotBlocked) {
            console.log(`[BOT_BLOCKED] User blocked the bot for group "${groupName}". Marking as inactive.`);
            this.recordBanRisk(accountId, 'blocked');
            if (groupId) {
              await groupService.markGroupInactive(accountId, groupId);
            }
            errorCount++;
            continue; // Skip this group
          }
          
          // Check if it's a flood wait error - RETRY instead of skipping
          if (isFloodWaitError(error)) {
            rateLimited = true;
            this.recordRateLimit(accountId);
            
            // CRITICAL: Check circuit breaker after recording flood wait
            const circuitCheck = this.checkCircuitBreaker(accountId);
            if (!circuitCheck.canProceed) {
              console.error(`[CIRCUIT_BREAKER] ⚠️ CRITICAL: ${circuitCheck.reason}`);
              logError(`[CIRCUIT_BREAKER] Broadcast stopped for account ${accountId} due to circuit breaker`);
              await this.stopBroadcast(userId, accountId);
              break; // Stop immediately to prevent ban
            }
            
            // Extract wait time from FloodWaitError using utility function
            const waitSeconds = extractWaitTime(error);
            
            // Use the actual wait time from Telegram, or fallback to conservative delay
            let delayMs;
            if (waitSeconds !== null && waitSeconds > 0 && !isNaN(waitSeconds)) {
              // Add 2 second buffer to ensure we wait long enough
              delayMs = (waitSeconds + 2) * 1000;
              console.log(`[FLOOD_WAIT] ⚠️ FloodWaitError detected for group "${errorGroupName}". Telegram requires ${waitSeconds}s wait. Waiting ${waitSeconds + 2}s before RETRYING...`);
              console.log(`[FLOOD_WAIT] Error details - message: "${error.message || 'N/A'}", errorMessage: "${error.errorMessage || 'N/A'}", code: "${error.code || 'N/A'}"`);
            } else {
              // Enhanced fallback: try to parse from error message/description if extraction failed
              const errorMsgLower = (error.message || error.errorMessage || error.toString() || '').toLowerCase();
              let extractedFromMsg = null;
              
              // Try to extract from message directly
              const msgMatch = errorMsgLower.match(/flood_wait[_\s](\d+)/);
              if (msgMatch && msgMatch[1]) {
                extractedFromMsg = parseInt(msgMatch[1], 10);
              }
              
              if (extractedFromMsg && !isNaN(extractedFromMsg) && extractedFromMsg > 0) {
                delayMs = (extractedFromMsg + 2) * 1000;
                console.log(`[FLOOD_WAIT] ⚠️ Extracted wait time from error message: ${extractedFromMsg}s. Waiting ${extractedFromMsg + 2}s before RETRYING...`);
              } else {
                // Conservative fallback: 60 seconds if we truly can't extract wait time
                delayMs = 60000;
                console.log(`[FLOOD_WAIT] ⚠️ Rate limit detected but couldn't extract wait time. Using conservative fallback: ${delayMs / 1000}s before RETRYING...`);
                console.log(`[FLOOD_WAIT] Error details for debugging - message: "${error.message || 'N/A'}", errorMessage: "${error.errorMessage || 'N/A'}", code: "${error.code || 'N/A'}", response: ${JSON.stringify(error.response || {}).substring(0, 200)}`);
              }
            }
            
            // Wait for the required time
            console.log(`[FLOOD_WAIT] Waiting ${(delayMs / 1000).toFixed(1)}s before retrying group "${errorGroupName}"...`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            console.log(`[FLOOD_WAIT] Wait completed, proceeding with retry...`);
            
            // RETRY sending to this group after waiting
            console.log(`[FLOOD_WAIT] Retrying send to group "${errorGroupName}" after flood wait...`);
            try {
              // Validate group entity still exists before retry
              if (!group || !group.entity) {
                console.log(`[FLOOD_WAIT] Group entity missing during retry, skipping`);
                errorCount++;
                failedGroups.push({ name: errorGroupName, reason: 'Flood wait retry - missing entity', id: errorGroupId });
                continue;
              }
              
              // Re-check broadcast status
              const currentBroadcastCheck = this.activeBroadcasts.get(broadcastKey);
              if (!currentBroadcastCheck || !currentBroadcastCheck.isRunning) {
                console.log(`[FLOOD_WAIT] Broadcast stopped during retry wait, aborting`);
                break;
              }
              
              // Retry sending to this group
              if (useForwardMode && forwardMessageId && savedMessagesEntity) {
                await client.forwardMessages(group.entity, {
                  messages: [forwardMessageId],
                  fromPeer: savedMessagesEntity,
                  // Don't set dropAuthor - default behavior preserves original author username
                });
                console.log(`[FLOOD_WAIT] ✅ Retry successful: Forwarded to group "${errorGroupName}"`);
                successCount++;
                this.recordMessageSent(accountId);
                this.recordGroupMessageSent(accountId, errorGroupId);
                loggingService.logBroadcast(accountId, `Retried and sent to group: ${errorGroupName} (after flood wait)`, 'success');
                continue; // Successfully retried, move to next group
              } else if (message && message.trim().length > 0) {
                // OPTIMIZATION: Use cached settings instead of fetching from database
                let settings = broadcast.cachedSettings;
                if (!settings) {
                  try {
                    settings = await configService.getAccountSettings(accountId);
                    if (!settings) settings = {};
                    broadcast.cachedSettings = settings; // Cache for future use
                  } catch (settingsError) {
                    settings = {};
                  }
                }
                
                const autoMention = settings?.autoMention || false;
                let mentionCount = settings?.mentionCount || 5;
                if (![1, 3, 5].includes(mentionCount)) mentionCount = 5;
                
                let messageToSend = message;
                let entities = [];
                
                // Try to add mentions if enabled (but don't fail if it doesn't work)
                if (autoMention) {
                  try {
                    let timeoutId;
                    const mentionPromise = mentionService.addMentionsToMessage(client, group.entity, message, mentionCount, cachedExcludeUserId);
                    const timeoutPromise = new Promise((_, reject) => {
                      timeoutId = setTimeout(() => reject(new Error('Mention timeout')), 2000);
                    });
                    
                    const mentionResult = await Promise.race([mentionPromise, timeoutPromise]);
                    // Clear timeout if promise resolved before timeout
                    if (timeoutId) clearTimeout(timeoutId);
                    messageToSend = mentionResult.message;
                    entities = mentionResult.entities || [];
                  } catch (mentionError) {
                    // Clear timeout if error occurred
                    if (timeoutId) clearTimeout(timeoutId);
                    // Continue without mentions if mention fails
                    messageToSend = message;
                    entities = [];
                  }
                }
                
                // Send message (with or without mentions)
                if (entities.length > 0) {
                  // Build HTML message with mentions
                  let htmlMessage = messageToSend;
                  const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);
                  for (const entity of sortedEntities) {
                    const userIdValue = typeof entity.userId === 'bigint' ? Number(entity.userId) : 
                                      typeof entity.userId === 'number' ? entity.userId : 
                                      parseInt(entity.userId, 10);
                    if (!isNaN(userIdValue)) {
                      const before = htmlMessage.substring(0, entity.offset);
                      const after = htmlMessage.substring(entity.offset + entity.length);
                      htmlMessage = before + `<a href="tg://user?id=${userIdValue}">&#8203;</a>` + after;
                    }
                  }
                  // CRITICAL: Validate HTML message before sending
                  const htmlValidation = validateMessage(htmlMessage);
                  if (htmlValidation.valid && htmlValidation.sanitized) {
                    await client.sendMessage(group.entity, { message: htmlValidation.sanitized, parseMode: 'html' });
                  } else {
                    console.log(`[BROADCAST] ⚠️ HTML message validation failed, skipping retry`);
                    errorCount++;
                    continue;
                  }
                } else {
                  // CRITICAL: Validate plain message before sending
                  const plainValidation = validateMessage(messageToSend);
                  if (plainValidation.valid && plainValidation.sanitized) {
                    await client.sendMessage(group.entity, { message: plainValidation.sanitized });
                  } else {
                    console.log(`[BROADCAST] ⚠️ Plain message validation failed, skipping retry`);
                    errorCount++;
                    continue;
                  }
                }
                
                console.log(`[FLOOD_WAIT] ✅ Retry successful: Sent to group "${errorGroupName}"`);
                successCount++;
                this.recordMessageSent(accountId);
                this.recordGroupMessageSent(accountId, errorGroupId);
                loggingService.logBroadcast(accountId, `Retried and sent to group: ${errorGroupName} (after flood wait)`, 'success');
                
                // Record analytics for success
                analyticsService.recordGroupAnalytics(accountId, errorGroupId, errorGroupName, true).catch(() => {});
                
                continue; // Successfully retried, move to next group
              } else {
                console.log(`[FLOOD_WAIT] No message available for retry`);
                errorCount++;
                continue;
              }
            } catch (retryError) {
              // If retry also fails, log and continue
              const retryErrorCode = retryError.code || retryError.errorCode || 'N/A';
              const retryErrorMessage = retryError.message || retryError.toString() || 'Unknown error';
              
              // Check if it's a MESSAGE_ID_INVALID error during flood wait retry
              const isRetryMessageIdInvalid = retryErrorMessage.includes('MESSAGE_ID_INVALID') || 
                                             retryErrorMessage.includes('message_id_invalid') ||
                                             (retryErrorCode === 400 && retryErrorMessage.includes('MESSAGE_ID_INVALID')) ||
                                             (retryError.errorMessage && retryError.errorMessage.includes('MESSAGE_ID_INVALID'));
              
              if (isRetryMessageIdInvalid && useForwardMode && forwardMessageId) {
                console.log(`[FLOOD_WAIT] ⚠️ MESSAGE_ID_INVALID during flood wait retry: Forward message (ID: ${forwardMessageId}) no longer exists`);
                loggingService.logError(accountId, `MESSAGE_ID_INVALID during flood wait retry: Forward message (ID: ${forwardMessageId}) no longer exists`, userId);
                // Clear the invalid forward message ID
                try {
                  await configService.setForwardMessageId(accountId, null);
                  console.log(`[FLOOD_WAIT] ✅ Cleared invalid forward message ID for account ${accountId}`);
                } catch (clearError) {
                  console.log(`[FLOOD_WAIT] ⚠️ Could not clear invalid forward message ID: ${clearError.message}`);
                }
                errorCount++;
                failedGroups.push({ 
                  name: errorGroupName, 
                  reason: 'Invalid saved template message ID (flood wait retry)', 
                  id: errorGroupId 
                });
              } else {
                console.log(`[FLOOD_WAIT] ❌ Retry failed for group "${errorGroupName}": ${retryErrorMessage} (Code: ${retryErrorCode})`);
                logError(`[FLOOD_WAIT RETRY ERROR] Retry failed for ${errorGroupName}:`, retryError);
                loggingService.logError(accountId, `Flood wait retry failed for ${errorGroupName}: ${retryErrorMessage}`, userId);
                errorCount++;
                failedGroups.push({ 
                  name: errorGroupName, 
                  reason: `Flood wait retry failed: ${retryErrorMessage} (Code: ${retryErrorCode})`, 
                  id: errorGroupId 
                });
              }
              // Continue to next group - don't retry again
            }
          } else {
            // Check for other recoverable errors (timeouts, network errors, etc.)
            const errorMessage = error.message || error.toString() || '';
            const isTimeout = errorMessage.includes('TIMEOUT') || errorMessage.includes('timeout') || errorCode === 408;
            const isNetworkError = errorMessage.includes('network') || errorMessage.includes('ECONNRESET') || errorMessage.includes('ENOTFOUND') || errorMessage.includes('ETIMEDOUT');
            const isConnectionError = errorMessage.includes('connection') || errorMessage.includes('disconnected') || errorMessage.includes('Not connected');
            
            // Retry recoverable errors once
            if ((isTimeout || isNetworkError || isConnectionError) && i < groupsToSend.length - 1) {
              console.log(`[BROADCAST] ⚠️ Recoverable error (${isTimeout ? 'timeout' : isNetworkError ? 'network' : 'connection'}) for group "${errorGroupName}", retrying after 3s...`);
              await new Promise((resolve) => setTimeout(resolve, 3000));
              
              try {
                // Validate group entity
                if (!group || !group.entity) {
                  console.log(`[BROADCAST] Group entity missing during retry`);
                  errorCount++;
                  continue;
                }
                
                // Re-check broadcast status
                const currentBroadcastCheck = this.activeBroadcasts.get(broadcastKey);
                if (!currentBroadcastCheck || !currentBroadcastCheck.isRunning) {
                  console.log(`[BROADCAST] Broadcast stopped during retry wait`);
                  break;
                }
                
                // Retry sending (simplified - no mentions for retry)
                if (useForwardMode && forwardMessageId && savedMessagesEntity) {
                  await client.forwardMessages(group.entity, {
                    messages: [forwardMessageId],
                    fromPeer: savedMessagesEntity,
                    // Don't set dropAuthor - default behavior preserves original author username
                  });
                  console.log(`[BROADCAST] ✅ Retry successful: Forwarded to group "${errorGroupName}"`);
                  successCount++;
                  this.recordMessageSent(accountId);
                  this.recordGroupMessageSent(accountId, errorGroupId);
                  continue;
                } else if (message && message.trim().length > 0) {
                  // CRITICAL: Validate message before sending
                  const finalValidation = validateMessage(message);
                  if (finalValidation.valid && finalValidation.sanitized) {
                    await client.sendMessage(group.entity, { message: finalValidation.sanitized });
                  } else {
                    console.log(`[BROADCAST] ⚠️ Final message validation failed, skipping`);
                    errorCount++;
                    continue;
                  }
                  console.log(`[BROADCAST] ✅ Retry successful: Sent to group "${errorGroupName}"`);
                  successCount++;
                  this.recordMessageSent(accountId);
                  this.recordGroupMessageSent(accountId, errorGroupId);
                  continue;
                }
              } catch (retryError) {
                const retryErrorCode = retryError.code || retryError.errorCode || 'N/A';
                const retryErrorMessage = retryError.message || retryError.toString() || 'Unknown error';
                
                // Check if it's a MESSAGE_ID_INVALID error during retry
                const isRetryMessageIdInvalid = retryErrorMessage.includes('MESSAGE_ID_INVALID') || 
                                               retryErrorMessage.includes('message_id_invalid') ||
                                               (retryErrorCode === 400 && retryErrorMessage.includes('MESSAGE_ID_INVALID')) ||
                                               (retryError.errorMessage && retryError.errorMessage.includes('MESSAGE_ID_INVALID'));
                
                if (isRetryMessageIdInvalid && useForwardMode && forwardMessageId) {
                  console.log(`[BROADCAST] ⚠️ MESSAGE_ID_INVALID during retry: Forward message (ID: ${forwardMessageId}) no longer exists`);
                  loggingService.logError(accountId, `MESSAGE_ID_INVALID during retry: Forward message (ID: ${forwardMessageId}) no longer exists`, userId);
                  // Clear the invalid forward message ID
                  try {
                    await configService.setForwardMessageId(accountId, null);
                    console.log(`[BROADCAST] ✅ Cleared invalid forward message ID for account ${accountId}`);
                  } catch (clearError) {
                    console.log(`[BROADCAST] ⚠️ Could not clear invalid forward message ID: ${clearError.message}`);
                  }
                  errorCount++;
                  failedGroups.push({ 
                    name: errorGroupName, 
                    reason: 'Invalid saved template message ID (retry)', 
                    id: errorGroupId 
                  });
                  // Continue to delay below
                } else {
                  console.log(`[BROADCAST] ❌ Retry failed for group "${errorGroupName}": ${retryErrorMessage} (Code: ${retryErrorCode})`);
                  errorCount++;
                  failedGroups.push({ 
                    name: errorGroupName, 
                    reason: `Recoverable error retry failed: ${retryErrorMessage}`, 
                    id: errorGroupId 
                  });
                }
                // Continue to delay below
              }
            }
            
            // For other errors, use random delay before continuing (anti-freeze)
            const delayMs = await this.getRandomDelay(accountId);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }
      
      // Update broadcast message count (re-fetch to ensure we have latest)
      const currentBroadcast = this.activeBroadcasts.get(broadcastKey);
      if (currentBroadcast && currentBroadcast.isRunning) {
        currentBroadcast.messageCount = (currentBroadcast.messageCount || 0) + successCount;
        this.activeBroadcasts.set(broadcastKey, currentBroadcast);
        console.log(`[BROADCAST] 📈 Total messages sent across all cycles for account ${accountId}: ${currentBroadcast.messageCount}`);
      }
      
      loggingService.logBroadcast(accountId, `Broadcast cycle completed. Success: ${successCount}, Errors: ${errorCount}`, 'info');
      console.log(`[BROADCAST] ✅ Completed sending 1 message to all groups for account ${accountId} (user ${userId})`);
      const tracking = this.getAntiFreezeTracking(accountId);
      
      console.log(`[BROADCAST] 📊 Summary: Total groups: ${groupsToSend.length}, Success: ${successCount}, Errors: ${errorCount}, Success rate: ${groupsToSend.length > 0 ? ((successCount / groupsToSend.length) * 100).toFixed(1) : 0}%`);
      if (rateLimited || tracking.rateLimitCount > 0) {
        console.log(`[ANTI-FREEZE] 📊 Rate limit tracking: Count: ${tracking.rateLimitCount}${rateLimited ? ' (Rate limited in this cycle)' : ''}`);
      }
      
      // CRITICAL: Check ban risk and circuit breaker status
      const circuitCheck = this.checkCircuitBreaker(accountId);
      if (circuitCheck.isOpen) {
        console.error(`[BAN_PREVENTION] ⚠️ CRITICAL: Circuit breaker is OPEN for account ${accountId}. Broadcast paused to prevent ban.`);
        logError(`[BAN_PREVENTION] Circuit breaker open for account ${accountId}`, null, circuitCheck.reason);
      }
      
      const riskTracking = this.banRiskTracking.get(accountId);
      if (riskTracking && riskTracking.errorRate > 30) {
        console.warn(`[BAN_PREVENTION] ⚠️ High error rate detected for account ${accountId}: ${riskTracking.errorRate.toFixed(1)}%`);
      }
      
      // Log failed groups summary if there are failures
      if (failedGroups.length > 0) {
        console.log(`[BROADCAST] ⚠️ Failed Groups Summary (${failedGroups.length} groups):`);
        const failureReasons = {};
        failedGroups.forEach(fg => {
          const reason = fg.reason || 'Unknown error';
          if (!failureReasons[reason]) {
            failureReasons[reason] = [];
          }
          failureReasons[reason].push(fg.name || fg.id || 'Unknown');
        });
        
        Object.entries(failureReasons).forEach(([reason, groups]) => {
          console.log(`[BROADCAST]   - ${reason}: ${groups.length} group(s) - ${groups.slice(0, 5).join(', ')}${groups.length > 5 ? ` ... and ${groups.length - 5} more` : ''}`);
        });
        
        // Log to database for tracking
        if (failedGroups.length > 0) {
          loggingService.logWarning(accountId, `Broadcast cycle had ${failedGroups.length} failed groups. Reasons: ${Object.keys(failureReasons).join(', ')}`, userId).catch(() => {});
        }
      }
      
      // Record broadcast statistics
      broadcastStatsService.recordStats(accountId, groupsToSend.length, successCount, errorCount).catch(err => {
        console.log(`[SILENT_FAIL] Broadcast stats recording failed: ${err.message}`);
      });
      
      // Log cycle completion to logger bot
      const loggerBotService = (await import('./loggerBotService.js')).default;
      loggerBotService.logCycleCompleted(userId, accountId, {
        groupsProcessed: groupsToSend.length,
        messagesSent: successCount,
        errors: errorCount,
        skipped: groupsToSend.length - successCount - errorCount
      }).catch(() => {
        // Silently fail - logger bot may not be started or user may have blocked it
      });
      
      // Notification removed - user doesn't want completion messages after each cycle
    } catch (error) {
      logError(`[BROADCAST ERROR] Error in sendSingleMessageToAllGroups for user ${userId}:`, error);
      loggingService.logError(accountId, `Error in sendSingleMessageToAllGroups: ${error.message}`, userId);
    } finally {
      // Disconnect client after sending messages (accounts only active while sending)
      if (client && client.connected) {
        try {
          await client.disconnect();
          console.log(`[BROADCAST] Disconnected client for account ${accountId} after sending messages`);
        } catch (disconnectError) {
          logError(`[BROADCAST ERROR] Error disconnecting client for account ${accountId}:`, disconnectError);
        }
      }
    }
  }

  isBroadcasting(userId, accountId = null) {
    // If accountId is provided, check if broadcast is for that specific account
    if (accountId !== null) {
      const broadcastKey = this._getBroadcastKey(userId, accountId);
      const broadcast = this.activeBroadcasts.get(broadcastKey);
      return broadcast && broadcast.isRunning;
    }
    
    // Otherwise, check if any broadcast is running for this user
    // Search through all broadcasts for this user
    for (const [key, broadcast] of this.activeBroadcasts.entries()) {
      if (key.startsWith(`${userId}_`) && broadcast.isRunning) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Get all accountIds that are currently broadcasting for a user
   * @param {number} userId - User ID
   * @returns {Array<number>} Array of account IDs that are broadcasting
   */
  getBroadcastingAccountIds(userId) {
    const accountIds = [];
    for (const [key, broadcast] of this.activeBroadcasts.entries()) {
      if (key.startsWith(`${userId}_`) && broadcast.isRunning) {
        accountIds.push(broadcast.accountId);
      }
    }
    return accountIds;
  }
  
  /**
   * Get the accountId that is currently broadcasting for a user (first one found)
   * @param {number} userId - User ID
   * @returns {number|null} Account ID that is broadcasting, or null if no broadcast
   */
  getBroadcastingAccountId(userId) {
    const accountIds = this.getBroadcastingAccountIds(userId);
    return accountIds.length > 0 ? accountIds[0] : null;
  }

  /**
   * Get user ID from account ID
   */
  async getUserIdFromAccountId(accountId) {
    try {
      const result = await db.query(
        'SELECT user_id FROM accounts WHERE account_id = $1',
        [accountId]
      );
      return result.rows[0]?.user_id || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Restore broadcasts that were running before bot restart
   * Called on startup to continue broadcasts after redeployment
   */
  async restoreBroadcasts() {
    try {
      // Get all accounts that were broadcasting
      const result = await db.query(
        'SELECT account_id, user_id FROM accounts WHERE is_broadcasting = 1'
      );

      if (!result.rows || result.rows.length === 0) {
        console.log('[BROADCAST_RESTORE] No broadcasts to restore');
        return { restored: 0, failed: 0 };
      }

      console.log(`[BROADCAST_RESTORE] Found ${result.rows.length} broadcast(s) to restore`);

      let restored = 0;
      let failed = 0;

      // Restore each broadcast
      for (const row of result.rows) {
        const accountId = row.account_id;
        const userId = row.user_id;

        try {
          // Check if account is still linked (but don't require it to be active)
          // Broadcasts should continue running for all accounts, not just the active one
          if (!accountLinker.isLinked(userId)) {
            console.log(`[BROADCAST_RESTORE] User ${userId} is not linked, skipping account ${accountId}`);
            // Reset flag since account is not linked
            await db.query('UPDATE accounts SET is_broadcasting = 0 WHERE account_id = ?', [accountId]);
            failed++;
            continue;
          }

          // Note: We do NOT check if account is active - broadcasts should continue
          // running for all accounts regardless of which one is currently active.
          // This allows users to switch accounts while broadcasts continue in parallel.
          const activeAccountId = accountLinker.getActiveAccountId(userId);
          if (activeAccountId !== accountId) {
            console.log(`[BROADCAST_RESTORE] Account ${accountId} is not active for user ${userId} (active: ${activeAccountId}), but restoring broadcast anyway to allow parallel broadcasts`);
          }

          // Wait a bit for account linker to fully initialize clients
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Try to ensure client is connected
          try {
            await accountLinker.ensureConnected(accountId);
          } catch (connectError) {
            console.log(`[BROADCAST_RESTORE] Could not connect client for account ${accountId}: ${connectError.message}`);
            // Keep flag set, will retry when client becomes available
            failed++;
            continue;
          }

          // Check if client is available
          const client = accountLinker.getClient(userId, accountId);
          if (!client || !client.connected) {
            console.log(`[BROADCAST_RESTORE] Client not available or not connected for account ${accountId}`);
            // Keep flag set, will retry when client becomes available
            failed++;
            continue;
          }

          // Restore the broadcast
          console.log(`[BROADCAST_RESTORE] Restoring broadcast for user ${userId}, account ${accountId}`);
          
          // Check if broadcast is already running (prevent duplicate restore)
          const broadcastKey = this._getBroadcastKey(userId, accountId);
          if (this.activeBroadcasts.has(broadcastKey)) {
            const existingBroadcast = this.activeBroadcasts.get(broadcastKey);
            if (existingBroadcast && existingBroadcast.isRunning) {
              console.log(`[BROADCAST_RESTORE] Broadcast already running in memory for account ${accountId}, skipping restore`);
              restored++;
              continue;
            }
          }
          
          try {
            // Pass accountId explicitly to restore broadcast for this specific account
            // even if it's not the currently active account
            const restoreResult = await this.startBroadcast(userId, null, accountId);

            if (restoreResult && restoreResult.success) {
              console.log(`[BROADCAST_RESTORE] ✅ Successfully restored broadcast for user ${userId}, account ${accountId}`);
              restored++;
            } else {
              const errorMsg = restoreResult?.error || 'Unknown error';
              console.log(`[BROADCAST_RESTORE] ❌ Failed to restore broadcast for user ${userId}, account ${accountId}: ${errorMsg}`);
              // Reset flag if restore failed
              await db.query('UPDATE accounts SET is_broadcasting = 0 WHERE account_id = ?', [accountId]);
              failed++;
            }
          } catch (startError) {
            // startBroadcast can throw errors, catch them here
            console.error(`[BROADCAST_RESTORE] startBroadcast threw error for account ${accountId}:`, startError);
            logError(`[BROADCAST_RESTORE] startBroadcast error:`, startError);
            // Reset flag on error
            try {
              await db.query('UPDATE accounts SET is_broadcasting = 0 WHERE account_id = ?', [accountId]);
            } catch (dbError) {
              // Ignore database errors
            }
            failed++;
          }
        } catch (error) {
          console.error(`[BROADCAST_RESTORE] Error restoring broadcast for account ${accountId}:`, error);
          logError(`[BROADCAST_RESTORE] Error restoring broadcast:`, error);
          // Reset flag on error
          try {
            await db.query('UPDATE accounts SET is_broadcasting = 0 WHERE account_id = ?', [accountId]);
          } catch (dbError) {
            // Ignore database errors
          }
          failed++;
        }

        // Small delay between restores to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      console.log(`[BROADCAST_RESTORE] Completed: ${restored} restored, ${failed} failed`);
      return { restored, failed };
    } catch (error) {
      logError('[BROADCAST_RESTORE] Error in restoreBroadcasts:', error);
      return { restored: 0, failed: 0 };
    }
  }
}

export default new AutomationService();
