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
import db from '../database/db.js';
import { config } from '../config.js';
import { logError } from '../utils/logger.js';
import { Api } from 'telegram/tl/index.js';
import { getInputUser } from 'telegram/Utils.js';
import { isFloodWaitError, extractWaitTime } from '../utils/floodWaitHandler.js';

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
    
    // Clean up old messages (older than 1 hour)
    const oneHourAgo = Date.now() - 3600000;
    tracking.messages = tracking.messages.filter(ts => ts > oneHourAgo);
    
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
    
    // Clean up old entries (older than 24 hours) to prevent memory leak
    const oneDayAgo = Date.now() - 86400000;
    Object.keys(tracking).forEach(gid => {
      if (tracking[gid] < oneDayAgo) {
        delete tracking[gid];
      }
    });
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
    
      // Default to 15 minutes if not set
      const defaultIntervalMinutes = 15;
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
      // Return default 15 minutes on error
      return 15 * 60 * 1000;
    }
  }

  async startBroadcast(userId, message) {
    if (!accountLinker.isLinked(userId)) {
      return { success: false, error: 'Account not linked' };
    }

    const accountId = accountLinker.getActiveAccountId(userId);
    if (!accountId) {
      return { success: false, error: 'No active account found' };
    }
    
    // Check if there's already a broadcast running for this specific account
    const broadcastKey = this._getBroadcastKey(userId, accountId);
    
    // Atomic check: prevent race condition if multiple start requests come simultaneously
    if (this.pendingStarts.has(broadcastKey)) {
      return { success: false, error: 'Broadcast start already in progress for this account' };
    }
    
    const existingBroadcast = this.activeBroadcasts.get(broadcastKey);
    if (existingBroadcast && existingBroadcast.isRunning) {
      return { success: false, error: 'Broadcast already running for this account' };
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
      useForwardMode = settings?.forwardMode || false;
      forwardMessageId = settings?.forwardMessageId;
      
      if (useForwardMode && forwardMessageId) {
        console.log(`[BROADCAST] Forward mode enabled for account ${accountId}, will forward message ID ${forwardMessageId}`);
      } else if (useForwardMode && !forwardMessageId) {
        console.log(`[BROADCAST] WARNING: Forward mode enabled but no message ID set for account ${accountId}, falling back to normal message`);
        useForwardMode = false;
      }
      
      // Check if auto-mention is enabled - note: mentions only work with regular messages, not forwarded messages
      const autoMention = settings?.autoMention || false;
      if (autoMention && useForwardMode) {
        console.log(`[BROADCAST] WARNING: Auto-mention is enabled but using forward mode. Mentions cannot be added to forwarded messages.`);
        console.log(`[BROADCAST] To use mentions, disable forward mode or use regular text messages.`);
      }
      
      // If not using forward mode, get A/B variant
      if (!useForwardMode) {
        try {
          const abMode = settings?.abMode || false;
          const abModeType = settings?.abModeType || 'single';
          const abLastVariant = settings?.abLastVariant || 'A';
          
          const messageData = await messageService.selectMessageVariant(
            accountId,
            abMode,
            abModeType,
            abLastVariant
          );
          
          // Handle both old (string) and new (object) formats for backward compatibility
          let messageEntities = null;
          if (messageData === null) {
            broadcastMessage = null;
          } else if (typeof messageData === 'string') {
            broadcastMessage = messageData;
          } else if (messageData && typeof messageData === 'object') {
            broadcastMessage = messageData.text || null;
            messageEntities = messageData.entities || null;
          } else {
            broadcastMessage = null;
          }
          
          // Validate message (check for empty/whitespace)
          if (broadcastMessage && typeof broadcastMessage === 'string' && broadcastMessage.trim().length === 0) {
            console.log(`[BROADCAST] Selected message variant is empty/whitespace, treating as null`);
            broadcastMessage = null;
          }
          
          // Update last variant if using rotate mode
          if (abMode && abModeType === 'rotate' && broadcastMessage) {
            try {
              const nextVariant = abLastVariant === 'A' ? 'B' : 'A';
              await configService.updateABLastVariant(accountId, nextVariant);
            } catch (variantError) {
              logError(`[BROADCAST ERROR] Error updating AB variant:`, variantError);
              // Non-critical error, continue
            }
          }
        } catch (messageError) {
          logError(`[BROADCAST ERROR] Error getting message variant:`, messageError);
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
    
    // Extract entities from messageData if available
    let messageEntities = null;
    if (typeof messageData === 'object' && messageData !== null && messageData.entities) {
      messageEntities = messageData.entities;
    }
    
    // broadcastKey is already declared above (line 66)
    const broadcastData = {
      isRunning: true,
      message: broadcastMessage,
      messageEntities, // Store entities for premium emoji support
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
      
      this.sendSingleMessageToAllGroups(userId, accountId, broadcastMessage, useForwardMode, forwardMessageId, true, messageEntities)
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
      const timeoutId = setTimeout(async () => {
        // Double-check broadcast is still running
        const currentBroadcast = this.activeBroadcasts.get(broadcastKey);
        if (!currentBroadcast || !currentBroadcast.isRunning) {
          console.log(`[BROADCAST] Broadcast stopped before cycle could run for account ${accountId}`);
          return;
        }
        
        console.log(`[BROADCAST] Next cycle triggered for account ${accountId} (user ${userId}) after ${customIntervalMinutes} minutes`);
        await this.sendAndScheduleNextCycle(userId, accountId);
      }, customIntervalMs);
      
      // Update broadcast with new timeout immediately
      stillRunning.timeouts = [timeoutId];
      stillRunning.customIntervalMs = customIntervalMs;
      this.activeBroadcasts.set(broadcastKey, stillRunning);
      
      console.log(`[BROADCAST] Scheduled next cycle in ${customIntervalMinutes} minutes for account ${accountId} (scheduled BEFORE sending)`);

      // NOW send messages (this may take time, but next cycle is already scheduled)
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
      
      const savedTemplateSlot = settings?.savedTemplateSlot;
      let messageToSend = null;
      let useTemplate = false;
      let templateData = null;
      
      console.log(`[BROADCAST] Cycle check - saved template slot: ${savedTemplateSlot === null ? 'null (none)' : savedTemplateSlot}`);
        
      // Check if saved template slot is active (must be explicitly 1, 2, or 3, not null/undefined)
      if (savedTemplateSlot !== null && savedTemplateSlot !== undefined && [1, 2, 3].includes(savedTemplateSlot)) {
        try {
          const template = await savedTemplatesService.getSavedTemplate(broadcast.accountId, savedTemplateSlot);
          if (template && template.messageId) {
            useTemplate = true;
            templateData = template;
            console.log(`[BROADCAST] Cycle using saved template slot ${savedTemplateSlot}`);
          } else {
            console.log(`[BROADCAST] Cycle - saved template slot ${savedTemplateSlot} set but template not found, using normal message`);
          }
        } catch (templateError) {
          logError(`[BROADCAST ERROR] Error getting saved template in cycle:`, templateError);
          console.log(`[BROADCAST] Error retrieving template slot ${savedTemplateSlot}, using normal message`);
        }
      } else {
        console.log(`[BROADCAST] Cycle - no saved template slot active, using normal message`);
      }
        
      // If not using saved template, get A/B variant
      if (!useTemplate) {
        try {
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
          let storedEntities = null;
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
          
          // Validate message (check for empty/whitespace)
          if (messageToSend && typeof messageToSend === 'string' && messageToSend.trim().length === 0) {
            console.log(`[BROADCAST] Selected message variant is empty/whitespace, treating as null`);
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
        } catch (messageError) {
          logError(`[BROADCAST ERROR] Error getting message variant in cycle:`, messageError);
          messageToSend = null;
        }
      }
        
      // Send message if we have one (this may take time, but next cycle is already scheduled)
      if (useTemplate || (messageToSend && messageToSend.trim().length > 0)) {
        const sendStartTime = Date.now();
        await this.sendSingleMessageToAllGroups(userId, broadcast.accountId, messageToSend, useTemplate, templateData, false, storedEntities);
        const sendDuration = ((Date.now() - sendStartTime) / 1000 / 60).toFixed(2);
        console.log(`[BROADCAST] Cycle send completed for account ${accountId} in ${sendDuration} minutes`);
      } else {
        console.log(`[BROADCAST] ⚠️ No message or template available for cycle, skipping send but keeping broadcast running`);
        loggingService.logBroadcast(broadcast.accountId, `Cycle skipped - no message or template available`, 'warning');
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

      // Clear all scheduled timeouts
      if (broadcast.timeouts && Array.isArray(broadcast.timeouts) && broadcast.timeouts.length > 0) {
        broadcast.timeouts.forEach(timeoutId => {
          try {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          } catch (timeoutError) {
            console.log(`[BROADCAST] Error clearing timeout: ${timeoutError?.message || 'Unknown'}`);
          }
        });
        console.log(`[BROADCAST] Cleared ${broadcast.timeouts.length} scheduled messages for user ${userId}`);
      }

      broadcast.isRunning = false;
      this.activeBroadcasts.delete(broadcastKey);

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
      if (!accountId && accountId !== 0) {
        console.log(`[CAP] Invalid accountId provided: ${accountId}`);
        const defaultDailyCap = config.antiFreeze.maxMessagesPerDay || 1500;
        return { canSend: true, dailySent: 0, dailyCap: defaultDailyCap };
      }
      
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      if (isNaN(accountIdNum)) {
        console.log(`[CAP] Could not parse accountId: ${accountId}`);
        const defaultDailyCap = config.antiFreeze.maxMessagesPerDay || 1500;
        return { canSend: true, dailySent: 0, dailyCap: defaultDailyCap };
      }
      
      const result = await db.query(
        'SELECT daily_sent, daily_cap, cap_reset_date FROM accounts WHERE account_id = $1',
        [accountIdNum]
      );
      
      if (!result || !result.rows || result.rows.length === 0) {
        console.log(`[CAP] Account ${accountIdNum} not found in database`);
        const defaultDailyCap = config.antiFreeze.maxMessagesPerDay || 1500;
        return { canSend: true, dailySent: 0, dailyCap: defaultDailyCap };
      }
      
      const account = result.rows[0];
      if (!account) {
        const defaultDailyCap = config.antiFreeze.maxMessagesPerDay || 1500;
        return { canSend: true, dailySent: 0, dailyCap: defaultDailyCap };
      }
      
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const capResetDate = account.cap_reset_date ? new Date(account.cap_reset_date).toISOString().split('T')[0] : null;
      
      // Reset if it's a new day
      if (capResetDate !== today) {
        try {
          await db.query(
            'UPDATE accounts SET daily_sent = 0, cap_reset_date = CURRENT_DATE WHERE account_id = $1',
            [accountIdNum]
          );
          loggingService.logInfo(accountIdNum, `Daily cap reset - new day started`, null);
          // Use account's daily_cap or default from config
          const defaultDailyCap = config.antiFreeze.maxMessagesPerDay || 1500;
          const accountDailyCap = parseInt(account.daily_cap) || defaultDailyCap;
          return { canSend: true, dailySent: 0, dailyCap: accountDailyCap };
        } catch (updateError) {
          logError(`[CAP ERROR] Error resetting daily cap:`, updateError);
          // Continue with current values if reset fails
        }
      }
      
      const dailySent = parseInt(account.daily_sent) || 0;
      // Use account's daily_cap or default from config, with maximum safety limit
      const defaultDailyCap = config.antiFreeze.maxMessagesPerDay || 1500;
      const accountDailyCap = parseInt(account.daily_cap) || defaultDailyCap;
      const maxAllowedCap = Math.max(defaultDailyCap, 2000); // Safety maximum
      const dailyCap = Math.min(accountDailyCap, maxAllowedCap);
      const canSend = dailySent < dailyCap;
      
      if (!canSend) {
        console.log(`[DAILY_CAP] ⚠️ Daily limit reached for account ${accountId}: ${dailySent}/${dailyCap} messages`);
      }
      
      return { canSend, dailySent, dailyCap };
    } catch (error) {
      logError(`[CAP ERROR] Error checking daily cap for account ${accountId}:`, error);
      // Use configurable default on error
      const defaultDailyCap = config.antiFreeze.maxMessagesPerDay || 1500;
      return { canSend: true, dailySent: 0, dailyCap: defaultDailyCap };
    }
  }

  async incrementDailySent(accountId) {
    try {
      if (!accountId && accountId !== 0) {
        console.log(`[CAP] Invalid accountId provided for increment: ${accountId}`);
        return;
      }
      
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
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

    // Check if current time is within schedule window
    // Bypass schedule if:
    // 1. This is a user-initiated initial message (bypassSchedule = true)
    // 2. OR the broadcast was manually started by user (manuallyStarted = true)
    const shouldBypassSchedule = bypassSchedule || broadcast.manuallyStarted;
    
    if (!shouldBypassSchedule) {
      const isWithinSchedule = await configService.isWithinSchedule(accountId);
      if (!isWithinSchedule) {
        console.log(`[BROADCAST] Current time is outside schedule window for account ${accountId}, skipping send`);
        return; // Skip this send, but keep broadcast running for next scheduled time
      }
    } else {
      console.log(`[BROADCAST] Bypassing schedule check (manually started broadcast or initial message) for account ${accountId}`);
    }

    // Check quiet hours (always enforced, even for manually started broadcasts)
    const isWithinQuietHours = await configService.isWithinQuietHours(accountId);
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

    // Note: We do NOT stop broadcast if account is switched
    // Broadcasts are independent per account and should continue even if user switches to another account
    // The broadcast will continue for the accountId that started it, regardless of which account is currently active
    const activeAccountId = accountLinker.getActiveAccountId(userId);
    if (activeAccountId !== accountId) {
      console.log(`[BROADCAST] Account ${accountId} is no longer active for user ${userId} (active: ${activeAccountId}), but continuing broadcast for account ${accountId}`);
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
      try {
        client = await accountLinker.getClientAndConnect(userId, accountId);
        if (!client) {
          logError(`[BROADCAST ERROR] Client not available for user ${userId}, account ${accountId}`);
          // Stop broadcast if client is not available (account might have been deleted)
          await this.stopBroadcast(userId, accountId);
          return;
        }
        console.log(`[BROADCAST] Connected client for account ${accountId} to send messages`);
      } catch (connectError) {
        logError(`[BROADCAST ERROR] Failed to connect client for user ${userId}:`, connectError);
        // Check if account was deleted or session revoked
        if (connectError.message && (connectError.message.includes('not found') || connectError.message.includes('Account'))) {
          // Account might have been deleted, stop broadcast
          console.log(`[BROADCAST] Account ${accountId} not found, stopping broadcast for user ${userId}`);
          await this.stopBroadcast(userId, accountId);
        }
        return;
      }

      // Get Saved Messages entity for forwarding if using forward mode
      let savedMessagesEntity = null;
      if (useForwardMode && forwardMessageId) {
        try {
          const me = await client.getMe();
          savedMessagesEntity = await client.getEntity(me);
          console.log(`[BROADCAST] Using forward mode with message ID ${forwardMessageId}`);
        } catch (error) {
          logError(`[BROADCAST ERROR] Failed to get Saved Messages entity:`, error);
          useForwardMode = false; // Fallback to normal message
        }
      }

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
        logError(`[BROADCAST ERROR] Failed to get dialogs for account ${accountId}:`, dialogsError);
        console.log(`[BROADCAST] Error getting dialogs: ${dialogsError.message}, stopping broadcast`);
        await this.stopBroadcast(userId, accountId);
        return;
      }
      
      // Import groupBlacklistService dynamically to avoid circular dependencies
      const { default: groupBlacklistService } = await import('./groupBlacklistService.js');
      
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
      
      // Filter out blacklisted groups
      const groups = [];
      for (const dialog of allGroups) {
        const entity = dialog.entity;
        const groupId = entity?.id?.toString() || entity?.id || 'unknown';
        const groupName = dialog.name || 'Unknown';
        const entityType = entity?.className || 'Unknown';
        
        // Check if group is blacklisted
        const isBlacklisted = await groupBlacklistService.isBlacklisted(accountId, groupId);
        if (isBlacklisted) {
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
          
          // CRITICAL: Check daily message limit to prevent excessive sending
          const dailyCapCheck = await this.checkAndResetDailyCap(accountId);
          if (!dailyCapCheck.canSend) {
            console.log(`[DAILY_CAP] ⚠️ Daily message limit reached for account ${accountId}: ${dailyCapCheck.dailySent}/${dailyCapCheck.dailyCap}. Skipping remaining groups.`);
            // Don't stop broadcast, just skip this cycle - will resume tomorrow
            break;
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
          
          if (useForwardMode && forwardMessageId && savedMessagesEntity) {
            // Validate before forwarding
            if (!group.entity) {
              throw new Error('Group entity is missing');
            }
            if (!forwardMessageId) {
              throw new Error('Forward message ID is missing');
            }
            if (!savedMessagesEntity) {
              throw new Error('Saved Messages entity is missing');
            }
            
            // Forward message from Saved Messages (preserves premium emoji and entities)
            // Note: Mentions cannot be added to forwarded messages
            console.log(`[BROADCAST] Forwarding message - mentions not supported for forwarded messages`);
            await client.forwardMessages(group.entity, {
              messages: [forwardMessageId],
              fromPeer: savedMessagesEntity,
            });
            console.log(`[BROADCAST] Forwarded message (ID: ${forwardMessageId}) to group ${i + 1}/${groupsToSend.length}: ${group.name || 'Unknown'}`);
            
            // Record message sent for rate limiting tracking
            this.recordMessageSent(accountId);
            this.recordGroupMessageSent(accountId, groupId);
          } else if (message && message.trim().length > 0) {
            // Check if auto-mention is enabled
            let settings;
            try {
              settings = await configService.getAccountSettings(accountId);
              if (!settings) {
                settings = {};
              }
            } catch (settingsError) {
              logError(`[BROADCAST ERROR] Error getting settings for group ${groupName}:`, settingsError);
              settings = {};
            }
            
            const autoMention = settings?.autoMention || false;
            // Ensure mentionCount is valid (1, 3, or 5), default to 5
            let mentionCount = settings?.mentionCount || 5;
            if (![1, 3, 5].includes(mentionCount)) {
              console.log(`[BROADCAST] Invalid mention count ${mentionCount}, defaulting to 5`);
              mentionCount = 5;
            }
            
            console.log(`[BROADCAST] Auto-mention check for group ${group.name}: enabled=${autoMention}, count=${mentionCount}`);
            
            let messageToSend = message;
            let entities = [];
            
            // Convert stored entities (from Bot API format) to GramJS format if available
            if (messageEntities && messageEntities.length > 0) {
              console.log(`[BROADCAST] Converting ${messageEntities.length} stored entities (premium emojis) to GramJS format`);
              const { Api } = await import('telegram/tl/index.js');
              
              for (const entity of messageEntities) {
                try {
                  // Convert Bot API entity to GramJS entity
                  if (entity.type === 'custom_emoji' && entity.custom_emoji_id) {
                    // Premium emoji entity
                    entities.push(new Api.MessageEntityCustomEmoji({
                      offset: entity.offset,
                      length: entity.length,
                      documentId: BigInt(entity.custom_emoji_id)
                    }));
                    console.log(`[BROADCAST] Added premium emoji entity: custom_emoji_id=${entity.custom_emoji_id}, offset=${entity.offset}, length=${entity.length}`);
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
                    entities.push(new Api.MessageEntityUrl({
                      offset: entity.offset,
                      length: entity.length
                    }));
                  } else if (entity.type === 'text_mention' && entity.user) {
                    entities.push(new Api.MessageEntityMentionName({
                      offset: entity.offset,
                      length: entity.length,
                      userId: BigInt(entity.user.id)
                    }));
                  }
                  // Add more entity types as needed
                } catch (entityError) {
                  console.log(`[BROADCAST] Error converting entity: ${entityError.message}`);
                }
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
                                   typeof me.id === 'bigint' ? Number(me.id) : parseInt(me.id);
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
                
                const timeoutPromise = new Promise((_, reject) => {
                  setTimeout(() => reject(new Error('Mention fetch timeout (3s)')), 3000);
                });
                
                const mentionResult = await Promise.race([mentionPromise, timeoutPromise]);
                messageToSend = mentionResult.message;
                // Merge mention entities with existing entities (premium emojis)
                const mentionEntities = mentionResult.entities || [];
                entities = [...entities, ...mentionEntities]; // Preserve premium emoji entities
                console.log(`[BROADCAST] Added ${mentionEntities.length} mentions to message for group ${group.name} (total entities: ${entities.length})`);
              } catch (error) {
                console.log(`[BROADCAST] Failed to add mentions (timeout or error), sending without mentions: ${error.message}`);
                // Continue with original message if mention fails or times out
                // Keep existing entities (premium emojis) even if mentions fail
                messageToSend = message;
                // Don't clear entities - they may contain premium emojis
              }
            } else {
              console.log(`[BROADCAST] Auto-mention is DISABLED for group ${group.name}`);
            }
            
            // Send message with entities (mentions or premium emojis)
            // Check if we have mention entities (from auto-mention) or other entities (premium emojis)
            // GramJS entities have className, Bot API entities have type
            const hasMentionEntities = entities.some(e => 
              (e.className === 'MessageEntityMentionName') || 
              (e.userId !== undefined && e.userId !== null)
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
                
                // If we have both mention entities and other entities (premium emojis), use direct entity sending
                // If we only have mention entities, use HTML parsing (better for mentions)
                // If we only have other entities (premium emojis), use direct entity sending
                if (hasMentionEntities && !hasOtherEntities) {
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
                                      parseInt(entity.userId);
                    
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
                  // Send message with direct entities (for premium emojis and/or when we have both mentions and premium emojis)
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
                    });
                  } else {
                    console.log(`[BROADCAST] ⚠️ WARNING: No entities found in sent message result!`);
                  }
                }
              } catch (sendError) {
                console.log(`[BROADCAST] Error sending message with entities: ${sendError?.message || 'Unknown error'}`);
                console.log(`[BROADCAST] Send error details:`, sendError);
                // Fallback: send without entities
                console.log(`[BROADCAST] Falling back to sending without entities`);
                try {
                  if (group.entity && messageToSend && messageToSend.trim().length > 0) {
                    await client.sendMessage(group.entity, { message: messageToSend });
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
              if (messageToSend && messageToSend.trim().length > 0) {
                await client.sendMessage(group.entity, { message: messageToSend });
              } else {
                console.log(`[BROADCAST] ⚠️ Message is empty, skipping group "${groupName}"`);
                continue;
              }
            }
            console.log(`[BROADCAST] ✅ Successfully sent message to group ${i + 1}/${groupsToSend.length}: "${groupName}" (ID: ${groupId})`);
          } else {
            console.log(`[BROADCAST] ⚠️ No message available, skipping group "${groupName}" (ID: ${groupId})`);
            continue;
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
                });
                console.log(`[BROADCAST] ✅ Retry successful: Forwarded to group "${groupName}"`);
                successCount++;
                this.recordMessageSent(accountId);
                this.recordGroupMessageSent(accountId, groupId);
                continue; // Successfully retried, move to next group
              } else if (message && message.trim().length > 0) {
                let settings;
                try {
                  settings = await configService.getAccountSettings(accountId);
                  if (!settings) settings = {};
                } catch (settingsError) {
                  settings = {};
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
                
                if (messageToSend && messageToSend.trim().length > 0) {
                  await client.sendMessage(group.entity, { message: messageToSend, entities });
                  console.log(`[BROADCAST] ✅ Retry successful: Sent to group "${groupName}"`);
                  successCount++;
                  this.recordMessageSent(accountId);
                  this.recordGroupMessageSent(accountId, groupId);
                  continue; // Successfully retried, move to next group
                } else {
                  console.log(`[BROADCAST] Retry message is empty, treating as error`);
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
                });
                console.log(`[FLOOD_WAIT] ✅ Retry successful: Forwarded to group "${errorGroupName}"`);
                successCount++;
                this.recordMessageSent(accountId);
                this.recordGroupMessageSent(accountId, errorGroupId);
                loggingService.logBroadcast(accountId, `Retried and sent to group: ${errorGroupName} (after flood wait)`, 'success');
                continue; // Successfully retried, move to next group
              } else if (message && message.trim().length > 0) {
                // Get settings for mentions if needed
                let settings;
                try {
                  settings = await configService.getAccountSettings(accountId);
                  if (!settings) settings = {};
                } catch (settingsError) {
                  settings = {};
                }
                
                const autoMention = settings?.autoMention || false;
                let mentionCount = settings?.mentionCount || 5;
                if (![1, 3, 5].includes(mentionCount)) mentionCount = 5;
                
                let messageToSend = message;
                let entities = [];
                
                // Try to add mentions if enabled (but don't fail if it doesn't work)
                if (autoMention) {
                  try {
                    const mentionResult = await Promise.race([
                      mentionService.addMentionsToMessage(client, group.entity, message, mentionCount, cachedExcludeUserId),
                      new Promise((_, reject) => setTimeout(() => reject(new Error('Mention timeout')), 2000))
                    ]);
                    messageToSend = mentionResult.message;
                    entities = mentionResult.entities || [];
                  } catch (mentionError) {
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
                                      parseInt(entity.userId);
                    if (!isNaN(userIdValue)) {
                      const before = htmlMessage.substring(0, entity.offset);
                      const after = htmlMessage.substring(entity.offset + entity.length);
                      htmlMessage = before + `<a href="tg://user?id=${userIdValue}">&#8203;</a>` + after;
                    }
                  }
                  await client.sendMessage(group.entity, { message: htmlMessage, parseMode: 'html' });
                } else {
                  await client.sendMessage(group.entity, { message: messageToSend });
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
                  });
                  console.log(`[BROADCAST] ✅ Retry successful: Forwarded to group "${errorGroupName}"`);
                  successCount++;
                  this.recordMessageSent(accountId);
                  this.recordGroupMessageSent(accountId, errorGroupId);
                  continue;
                } else if (message && message.trim().length > 0) {
                  await client.sendMessage(group.entity, { message: message });
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
}

export default new AutomationService();
