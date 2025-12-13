import accountLinker from './accountLinker.js';
import messageManager from './messageManager.js';
import messageService from './messageService.js';
import savedTemplatesService from './savedTemplatesService.js';
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

class AutomationService {
  constructor() {
    // Store broadcasts by composite key: userId_accountId
    // This allows multiple broadcasts to run simultaneously (one per account)
    this.activeBroadcasts = new Map(); // "userId_accountId" -> { timeouts, isRunning, message, accountId, messageCount }
    this.pendingStarts = new Set(); // Track broadcast starts in progress to prevent race conditions
  }
  
  /**
   * Get broadcast key for a user and account
   */
  _getBroadcastKey(userId, accountId) {
    return `${userId}_${accountId}`;
  }

  // Generate random intervals for 5 messages across 1 hour (spread evenly with randomness)
  generateRandomIntervals() {
    const intervals = [];
    const hourInMs = 60 * 60 * 1000; // 1 hour in milliseconds
    const messagesPerHour = 5;
    
    // Divide hour into 5 segments and add randomness
    for (let i = 0; i < messagesPerHour; i++) {
      const baseInterval = (hourInMs / messagesPerHour) * (i + 1);
      // Add randomness: ±20% of segment size
      const segmentSize = hourInMs / messagesPerHour;
      const randomOffset = (Math.random() - 0.5) * segmentSize * 0.4; // ±20% randomness
      const interval = Math.max(60000, Math.min(hourInMs, baseInterval + randomOffset)); // Min 1 min, max 1 hour
      intervals.push(Math.round(interval));
    }
    
    // Sort intervals to ensure they're in order
    intervals.sort((a, b) => a - b);
    
    console.log(`[BROADCAST] Generated intervals (minutes): ${intervals.map(ms => (ms / 60000).toFixed(1)).join(', ')}`);
    return intervals;
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
    let useSavedTemplate = false;
    let savedTemplateData = null;
    
    if (!broadcastMessage) {
      const settings = await configService.getAccountSettings(accountId);
      const savedTemplateSlot = settings?.savedTemplateSlot;
      
      console.log(`[BROADCAST] Checking saved template slot for account ${accountId}: ${savedTemplateSlot === null ? 'null (none)' : savedTemplateSlot}`);
      
      // Check if saved template slot is active (must be explicitly 1, 2, or 3, not null/undefined)
      if (savedTemplateSlot !== null && savedTemplateSlot !== undefined && [1, 2, 3].includes(savedTemplateSlot)) {
        const template = await savedTemplatesService.getSavedTemplate(accountId, savedTemplateSlot);
        if (template && template.messageId) {
          useSavedTemplate = true;
          savedTemplateData = template;
          console.log(`[BROADCAST] Using saved template slot ${savedTemplateSlot} for account ${accountId}`);
          // For saved templates, we'll forward the message (handled in sendSingleMessageToAllGroups)
        } else {
          console.log(`[BROADCAST] Saved template slot ${savedTemplateSlot} is set but template not found, falling back to normal message`);
        }
      } else {
        console.log(`[BROADCAST] No saved template slot active (value: ${savedTemplateSlot}), using normal message`);
      }
      
      // Check if auto-mention is enabled - note: mentions only work with regular messages, not forwarded templates
      const autoMention = settings?.autoMention || false;
      if (autoMention && useSavedTemplate) {
        console.log(`[BROADCAST] WARNING: Auto-mention is enabled but using saved template. Mentions cannot be added to forwarded messages.`);
        console.log(`[BROADCAST] To use mentions, disable saved template slot or use regular text messages.`);
      }
      
      // If not using saved template, get A/B variant
      if (!useSavedTemplate) {
        const abMode = settings?.abMode || false;
        const abModeType = settings?.abModeType || 'single';
        const abLastVariant = settings?.abLastVariant || 'A';
        
        broadcastMessage = await messageService.selectMessageVariant(
          accountId,
          abMode,
          abModeType,
          abLastVariant
        );
        
        // Update last variant if using rotate mode
        if (abMode && abModeType === 'rotate' && broadcastMessage) {
          const nextVariant = abLastVariant === 'A' ? 'B' : 'A';
          await configService.updateABLastVariant(accountId, nextVariant);
        }
        
        if (!broadcastMessage && !useSavedTemplate) {
          return { success: false, error: 'No message set. Please set a message first.' };
        }
      }
    }
    
    // Create broadcast data FIRST before sending initial message
    const intervals = this.generateRandomIntervals();
    const timeouts = [];
    
    // broadcastKey is already declared above (line 66)
    const broadcastData = {
      isRunning: true,
      message: broadcastMessage,
      useSavedTemplate,
      savedTemplateData,
      timeouts: [],
      accountId,
      userId,
      messageCount: 0,
      manuallyStarted: true, // Track if broadcast was manually started by user (bypasses schedule)
    };

    // Set broadcast data BEFORE sending initial message (so sendSingleMessageToAllGroups can find it)
    this.activeBroadcasts.set(broadcastKey, broadcastData);
    
    // Schedule 5 messages across the hour at random intervals
    intervals.forEach((intervalMs, index) => {
      const timeoutId = setTimeout(async () => {
        const broadcast = this.activeBroadcasts.get(broadcastKey);
        if (!broadcast || !broadcast.isRunning) {
          return;
        }
        
        console.log(`[BROADCAST] Scheduled message ${index + 1}/5 triggered for account ${accountId} (user ${userId}) after ${(intervalMs / 60000).toFixed(1)} minutes`);
        
        // Get message with A/B variant selection and saved template for this send
        const settings = await configService.getAccountSettings(broadcast.accountId);
        const savedTemplateSlot = settings?.savedTemplateSlot;
        let messageToSend = null;
        let useTemplate = false;
        let templateData = null;
        
        console.log(`[BROADCAST] Scheduled message check - saved template slot: ${savedTemplateSlot === null ? 'null (none)' : savedTemplateSlot}`);
        
        // Check if saved template slot is active (must be explicitly 1, 2, or 3, not null/undefined)
        if (savedTemplateSlot !== null && savedTemplateSlot !== undefined && [1, 2, 3].includes(savedTemplateSlot)) {
          const template = await savedTemplatesService.getSavedTemplate(broadcast.accountId, savedTemplateSlot);
          if (template && template.messageId) {
            useTemplate = true;
            templateData = template;
            console.log(`[BROADCAST] Scheduled message using saved template slot ${savedTemplateSlot}`);
          } else {
            console.log(`[BROADCAST] Scheduled message - saved template slot ${savedTemplateSlot} set but template not found, using normal message`);
          }
        } else {
          console.log(`[BROADCAST] Scheduled message - no saved template slot active, using normal message`);
        }
        
        // If not using saved template, get A/B variant
        if (!useTemplate) {
          const abMode = settings?.abMode || false;
          const abModeType = settings?.abModeType || 'single';
          const abLastVariant = settings?.abLastVariant || 'A';
          
          messageToSend = await messageService.selectMessageVariant(
            broadcast.accountId,
            abMode,
            abModeType,
            abLastVariant
          );
          
          // Update last variant if using rotate mode
          if (abMode && abModeType === 'rotate' && messageToSend) {
            const nextVariant = abLastVariant === 'A' ? 'B' : 'A';
            await configService.updateABLastVariant(broadcast.accountId, nextVariant);
          }
        }
        
        if (useTemplate || messageToSend) {
          await this.sendSingleMessageToAllGroups(userId, broadcast.accountId, messageToSend, useTemplate, templateData);
        }
        
        // Schedule next hour's messages (check again if broadcast is still running)
        const stillRunning = this.activeBroadcasts.get(broadcastKey);
        if (stillRunning && stillRunning.isRunning) {
          await this.scheduleNextHourMessages(userId, accountId);
        }
      }, intervalMs);
      
      timeouts.push(timeoutId);
    });

    // Update broadcast data with timeouts atomically (check broadcast still exists)
    const currentBroadcast = this.activeBroadcasts.get(broadcastKey);
    if (currentBroadcast && currentBroadcast.isRunning) {
      currentBroadcast.timeouts = timeouts;
      this.activeBroadcasts.set(broadcastKey, currentBroadcast);
    } else {
      // Broadcast was stopped before we could set timeouts, clear them
      timeouts.forEach(timeoutId => clearTimeout(timeoutId));
      console.log(`[BROADCAST] Broadcast stopped before scheduling completed, cleared ${timeouts.length} timeouts for account ${accountId}`);
    }

      // Send initial 1 message to all groups AFTER broadcast data is set
      // Initial message is sent regardless of schedule (user explicitly started broadcast)
      console.log(`[BROADCAST] Starting broadcast for user ${userId}, sending initial 1 message`);
      await this.sendSingleMessageToAllGroups(userId, accountId, broadcastMessage, useSavedTemplate, savedTemplateData, true);

      console.log(`[BROADCAST] Scheduled ${intervals.length} messages across the hour for user ${userId}`);
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

  scheduleNextHourMessages(userId, accountId) {
    const broadcastKey = this._getBroadcastKey(userId, accountId);
    const broadcast = this.activeBroadcasts.get(broadcastKey);
    if (!broadcast || !broadcast.isRunning) {
      return;
    }

    // Clear old timeouts
    if (broadcast.timeouts) {
      broadcast.timeouts.forEach(timeoutId => clearTimeout(timeoutId));
    }

    // Double-check broadcast is still running after clearing timeouts (race condition protection)
    const currentBroadcast = this.activeBroadcasts.get(broadcastKey);
    if (!currentBroadcast || !currentBroadcast.isRunning) {
      console.log(`[BROADCAST] Broadcast stopped while scheduling next hour's messages for account ${accountId}`);
      return;
    }

    // Generate new random intervals for next hour
    const intervals = this.generateRandomIntervals();
    const timeouts = [];
    
    intervals.forEach((intervalMs, index) => {
      const timeoutId = setTimeout(async () => {
        const broadcast = this.activeBroadcasts.get(broadcastKey);
        if (!broadcast || !broadcast.isRunning) {
          return;
        }
        
        console.log(`[BROADCAST] Scheduled message ${index + 1}/5 triggered for account ${accountId} (user ${userId}) after ${(intervalMs / 60000).toFixed(1)} minutes`);
        
        // Get message with A/B variant selection and saved template for this send
        const settings = await configService.getAccountSettings(broadcast.accountId);
        const savedTemplateSlot = settings?.savedTemplateSlot;
        let messageToSend = null;
        let useTemplate = false;
        let templateData = null;
        
        console.log(`[BROADCAST] Scheduled message check - saved template slot: ${savedTemplateSlot === null ? 'null (none)' : savedTemplateSlot}`);
        
        // Check if saved template slot is active (must be explicitly 1, 2, or 3, not null/undefined)
        if (savedTemplateSlot !== null && savedTemplateSlot !== undefined && [1, 2, 3].includes(savedTemplateSlot)) {
          const template = await savedTemplatesService.getSavedTemplate(broadcast.accountId, savedTemplateSlot);
          if (template && template.messageId) {
            useTemplate = true;
            templateData = template;
            console.log(`[BROADCAST] Scheduled message using saved template slot ${savedTemplateSlot}`);
          } else {
            console.log(`[BROADCAST] Scheduled message - saved template slot ${savedTemplateSlot} set but template not found, using normal message`);
          }
        } else {
          console.log(`[BROADCAST] Scheduled message - no saved template slot active, using normal message`);
        }
        
        // If not using saved template, get A/B variant
        if (!useTemplate) {
          const abMode = settings?.abMode || false;
          const abModeType = settings?.abModeType || 'single';
          const abLastVariant = settings?.abLastVariant || 'A';
          
          messageToSend = await messageService.selectMessageVariant(
            broadcast.accountId,
            abMode,
            abModeType,
            abLastVariant
          );
          
          // Update last variant if using rotate mode
          if (abMode && abModeType === 'rotate' && messageToSend) {
            const nextVariant = abLastVariant === 'A' ? 'B' : 'A';
            await configService.updateABLastVariant(broadcast.accountId, nextVariant);
          }
        }
        
        if (useTemplate || messageToSend) {
          await this.sendSingleMessageToAllGroups(userId, broadcast.accountId, messageToSend, useTemplate, templateData);
        }
        
        // Schedule next hour's messages (check again if broadcast is still running)
        const stillRunning = this.activeBroadcasts.get(broadcastKey);
        if (stillRunning && stillRunning.isRunning) {
          await this.scheduleNextHourMessages(userId, accountId);
        }
      }, intervalMs);
      
      timeouts.push(timeoutId);
    });

    // Update timeouts atomically
    const finalBroadcast = this.activeBroadcasts.get(broadcastKey);
    if (finalBroadcast && finalBroadcast.isRunning) {
      finalBroadcast.timeouts = timeouts;
      console.log(`[BROADCAST] Scheduled next hour's ${intervals.length} messages for account ${accountId}`);
    } else {
      // Broadcast was stopped, clear the timeouts we just created
      timeouts.forEach(timeoutId => clearTimeout(timeoutId));
      console.log(`[BROADCAST] Broadcast stopped while scheduling, cleared ${timeouts.length} timeouts for account ${accountId}`);
    }
  }

  async stopBroadcast(userId, accountId = null) {
    // If accountId is not provided, get the active account's broadcast
    if (!accountId) {
      accountId = accountLinker.getActiveAccountId(userId);
    }
    
    if (!accountId) {
      return { success: false, error: 'No active account found' };
    }
    
    const broadcastKey = this._getBroadcastKey(userId, accountId);
    const broadcast = this.activeBroadcasts.get(broadcastKey);
    if (!broadcast) {
      return { success: false, error: 'No active broadcast found for this account' };
    }

    // Check if account has required tags before allowing stop
    if (accountId) {
      const tagsCheck = await accountLinker.checkAccountTags(accountId);
      if (!tagsCheck.hasTags) {
        return { 
          success: false, 
          error: 'TAGS_REQUIRED',
          tagsCheck 
        };
      }
    }

    // Clear all scheduled timeouts
    if (broadcast.timeouts && broadcast.timeouts.length > 0) {
      broadcast.timeouts.forEach(timeoutId => {
        clearTimeout(timeoutId);
      });
      console.log(`[BROADCAST] Cleared ${broadcast.timeouts.length} scheduled messages for user ${userId}`);
    }

    broadcast.isRunning = false;
    this.activeBroadcasts.delete(broadcastKey);

    console.log(`[BROADCAST] Broadcast stopped for account ${accountId} (user ${userId})`);
    return { success: true };
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

  async checkAndResetDailyCap(accountId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const result = await db.query(
        'SELECT daily_sent, daily_cap, cap_reset_date FROM accounts WHERE account_id = $1',
        [accountIdNum]
      );
      
      if (result.rows.length === 0) return { canSend: true, dailySent: 0, dailyCap: 50 };
      
      const account = result.rows[0];
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD in IST
      const capResetDate = account.cap_reset_date ? new Date(account.cap_reset_date).toISOString().split('T')[0] : null;
      
      // Reset if it's a new day
      if (capResetDate !== today) {
        await db.query(
          'UPDATE accounts SET daily_sent = 0, cap_reset_date = CURRENT_DATE WHERE account_id = $1',
          [accountIdNum]
        );
        loggingService.logInfo(accountIdNum, `Daily cap reset - new day started`, null);
        return { canSend: true, dailySent: 0, dailyCap: account.daily_cap || 50 };
      }
      
      const dailySent = parseInt(account.daily_sent) || 0;
      const dailyCap = parseInt(account.daily_cap) || 50;
      const canSend = dailySent < dailyCap;
      
      return { canSend, dailySent, dailyCap };
    } catch (error) {
      logError(`[CAP ERROR] Error checking daily cap for account ${accountId}:`, error);
      return { canSend: true, dailySent: 0, dailyCap: 50 }; // Default to allowing sends on error
    }
  }

  async incrementDailySent(accountId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      await db.query(
        'UPDATE accounts SET daily_sent = daily_sent + 1 WHERE account_id = $1',
        [accountIdNum]
      );
    } catch (error) {
      logError(`[CAP ERROR] Error incrementing daily sent for account ${accountId}:`, error);
    }
  }

  async sendSingleMessageToAllGroups(userId, accountId, message, useSavedTemplate = false, savedTemplateData = null, bypassSchedule = false) {
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

      // Get Saved Messages entity for forwarding if using saved template
      let savedMessagesEntity = null;
      if (useSavedTemplate && savedTemplateData) {
        try {
          const me = await client.getMe();
          savedMessagesEntity = await client.getEntity(me);
          console.log(`[BROADCAST] Using saved template slot ${savedTemplateData.slot} (message ID: ${savedTemplateData.messageId})`);
        } catch (error) {
          logError(`[BROADCAST ERROR] Failed to get Saved Messages entity:`, error);
          useSavedTemplate = false; // Fallback to normal message
        }
      }

      // Get all dialogs (chats)
      const dialogs = await client.getDialogs();
      console.log(`[BROADCAST] Retrieved ${dialogs.length} total dialogs for account ${accountId}`);
      
      // Filter only groups and channels (exclude private chats)
      // dialog.isGroup = true for regular groups and supergroups
      // dialog.isChannel = true for channels (both broadcast and megagroup channels)
      const groups = dialogs.filter((dialog) => {
        const isGroup = dialog.isGroup || false;
        const isChannel = dialog.isChannel || false;
        
        // Primary filter: use dialog properties (most reliable)
        if (isGroup || isChannel) {
          const entity = dialog.entity;
          const groupType = isGroup ? 'Group' : 'Channel';
          const entityType = entity?.className || 'Unknown';
          const groupId = entity?.id?.toString() || entity?.id || 'unknown';
          const groupName = dialog.name || 'Unknown';
          
          // Log each group being included for transparency
          console.log(`[BROADCAST] ✅ Including ${groupType}: "${groupName}" (Entity: ${entityType}, ID: ${groupId})`);
          return true;
        }
        
        return false;
      });

      console.log(`[BROADCAST] ✅ Filtered ${groups.length} groups/channels from ${dialogs.length} dialogs for user ${userId}`);
      console.log(`[BROADCAST] Starting to send 1 message to each of ${groups.length} groups...`);

      let successCount = 0;
      let errorCount = 0;

      // Send 1 message to each group with delays to avoid spam detection
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const groupName = group.name || 'Unknown Group';
        const groupId = group.entity?.id?.toString() || group.entity?.id || 'unknown';
        const groupType = group.isGroup ? 'Group' : (group.isChannel ? 'Channel' : 'Unknown');
        
        console.log(`[BROADCAST] [${i + 1}/${groups.length}] Processing ${groupType}: "${groupName}" (ID: ${groupId})`);
        
        if (!broadcast.isRunning) {
          console.log(`[BROADCAST] ⚠️ Broadcast stopped by user, aborting send. Processed ${i}/${groups.length} groups.`);
          break;
        }

        try {
          console.log(`[BROADCAST] Attempting to send message to group ${i + 1}/${groups.length}: "${groupName}"`);
          if (useSavedTemplate && savedTemplateData && savedMessagesEntity) {
            // Forward message from Saved Messages (preserves premium emoji and entities)
            // Note: Mentions cannot be added to forwarded messages
            console.log(`[BROADCAST] Forwarding saved template - mentions not supported for forwarded messages`);
            await client.forwardMessages(group.entity, {
              messages: [savedTemplateData.messageId],
              fromPeer: savedMessagesEntity,
            });
            console.log(`[BROADCAST] Forwarded saved template (slot ${savedTemplateData.slot}) to group ${i + 1}/${groups.length}: ${group.name}`);
          } else if (message) {
            // Check if auto-mention is enabled
            const settings = await configService.getAccountSettings(accountId);
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
            
            // Add mentions if enabled
            if (autoMention) {
              console.log(`[BROADCAST] Auto-mention is ENABLED, attempting to add mentions...`);
              try {
                // Get the account's own user ID to exclude it from mentions
                let excludeUserId = null;
                try {
                  const me = await client.getMe();
                  if (me && me.id) {
                    excludeUserId = typeof me.id === 'object' && me.id.value ? Number(me.id.value) :
                                   typeof me.id === 'number' ? me.id :
                                   typeof me.id === 'bigint' ? Number(me.id) : parseInt(me.id);
                    console.log(`[BROADCAST] Excluding own user ID from mentions: ${excludeUserId}`);
                  }
                } catch (meError) {
                  console.log(`[BROADCAST] Could not get own user ID: ${meError.message}`);
                }
                
                const mentionResult = await mentionService.addMentionsToMessage(
                  client,
                  group.entity,
                  message,
                  mentionCount,
                  excludeUserId // Pass account's own user ID to exclude
                );
                messageToSend = mentionResult.message;
                entities = mentionResult.entities || [];
                console.log(`[BROADCAST] Added ${entities.length} mentions to message for group ${group.name}`);
              } catch (error) {
                console.log(`[BROADCAST] Failed to add mentions, sending without mentions: ${error.message}`);
                console.log(`[BROADCAST] Mention error stack:`, error.stack);
                // Continue with original message if mention fails
              }
            } else {
              console.log(`[BROADCAST] Auto-mention is DISABLED for group ${group.name}`);
            }
            
            // Send message with mentions using HTML parsing (BEST METHOD)
            // GramJS supports HTML parsing which automatically converts <a href="tg://user?id=..."> to entities
            // This is more reliable than manually creating entities
            if (entities.length > 0) {
              try {
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
                
                try {
                  const result = await client.sendMessage(group.entity, { 
                    message: htmlMessage,
                    parseMode: 'html' // Use HTML parsing mode
                  });
                  
                  console.log(`[BROADCAST] Message sent successfully with HTML mentions. Message ID: ${result.id}`);
                  
                  // Check if entities were actually included in the sent message
                  const resultEntities = result.entities || result._entities || [];
                  if (resultEntities.length > 0) {
                    console.log(`[BROADCAST] ✅ Entities confirmed in sent message: ${resultEntities.length} entities`);
                    resultEntities.forEach((ent, idx) => {
                      console.log(`[BROADCAST] Entity ${idx}: ${ent.className || ent.constructor?.name}, offset=${ent.offset}, length=${ent.length}`);
                      if (ent.url) {
                        console.log(`[BROADCAST] Entity ${idx} URL: ${ent.url}`);
                      }
                    });
                  } else {
                    console.log(`[BROADCAST] ⚠️ WARNING: No entities found in sent message result!`);
                    console.log(`[BROADCAST] result.entities:`, result.entities);
                    console.log(`[BROADCAST] result._entities:`, result._entities);
                    console.log(`[BROADCAST] ⚠️ Telegram rejected the HTML mentions. Possible reasons:`);
                    console.log(`[BROADCAST]   1. User privacy settings prevent mentions`);
                    console.log(`[BROADCAST]   2. User hasn't interacted with the account`);
                    console.log(`[BROADCAST]   3. Group permissions restrict mentions`);
                    console.log(`[BROADCAST]   4. tg://user?id= may not work in groups via MTProto`);
                  }
                } catch (sendError) {
                  console.log(`[BROADCAST] Error sending message with HTML: ${sendError.message}`);
                  console.log(`[BROADCAST] Send error details:`, sendError);
                  // Fallback: send without mentions
                  console.log(`[BROADCAST] Falling back to sending without mentions`);
                  await client.sendMessage(group.entity, { message: messageToSend });
                }
              } catch (htmlError) {
                console.log(`[BROADCAST] Error creating HTML message: ${htmlError.message}`);
                console.log(`[BROADCAST] HTML error details:`, htmlError);
                // Fallback: send without mentions
                await client.sendMessage(group.entity, { message: messageToSend });
              }
            } else {
              await client.sendMessage(group.entity, { message: messageToSend });
            }
            console.log(`[BROADCAST] ✅ Successfully sent message to group ${i + 1}/${groups.length}: "${groupName}" (ID: ${groupId})`);
          } else {
            console.log(`[BROADCAST] ⚠️ No message available, skipping group "${groupName}" (ID: ${groupId})`);
            continue;
          }
          
          successCount++;
          loggingService.logBroadcast(accountId, `Sent message to group: ${groupName}`, 'success');
          
          // Record analytics
          analyticsService.recordGroupAnalytics(accountId, groupId, groupName, true).catch(err => {
            console.log(`[SILENT_FAIL] Analytics recording failed: ${err.message}`);
          });
          
          // Random delay between groups: 3-8 seconds to avoid spam detection
          const baseDelay = 3000; // 3 seconds base
          const randomDelay = Math.random() * 5000; // 0-5 seconds random
          const delay = Math.round(baseDelay + randomDelay);
          
          // Don't delay after last group
          if (i < groups.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        } catch (error) {
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
          const errorCode = error.code || error.errorCode || '';
          const isBanned = errorMessage.includes('USER_BANNED_IN_CHANNEL') || 
                          errorMessage.includes('USER_BANNED') ||
                          errorMessage.includes('CHAT_ADMIN_REQUIRED') ||
                          errorMessage.includes('CHAT_WRITE_FORBIDDEN') ||
                          (errorCode === 400 && (errorMessage.includes('BANNED') || errorMessage.includes('ADMIN_REQUIRED')));
          
          if (isBanned) {
            // User is banned or doesn't have permission - mark group as inactive and try to leave
            // Get group ID from entity (group.entity.id.toString() or group.entity.id)
            const groupId = group.entity?.id?.toString() || group.entity?.id;
            console.log(`[BROADCAST] User banned from group "${group.name}" (${groupId || 'unknown'}), marking as inactive...`);
            
            if (groupId) {
              await groupService.markGroupInactive(accountId, groupId);
              loggingService.logError(accountId, `User banned from group: ${group.name} - marked as inactive`, userId);
            } else {
              console.log(`[BROADCAST] Warning: Could not get group ID for "${group.name}", skipping database update`);
              loggingService.logError(accountId, `User banned from group: ${group.name} - could not get group ID`, userId);
            }
            
            // Try to leave the group/channel using the entity directly
            try {
              const groupEntity = group.entity;
              if (groupEntity) {
                if (groupEntity.broadcast || groupEntity.megagroup) {
                  // It's a channel or supergroup - leave it
                  await client.invoke(
                    new Api.channels.LeaveChannel({
                      channel: groupEntity,
                    })
                  );
                  console.log(`[GROUPS] Left channel/supergroup "${group.name}" (${groupId || 'unknown'})`);
                  loggingService.logInfo(accountId, `Left banned channel: ${group.name}`, userId);
                } else {
                  // It's a regular group - delete dialog (leave)
                  await client.deleteDialog(groupEntity);
                  console.log(`[GROUPS] Left group "${group.name}" (${groupId || 'unknown'})`);
                  loggingService.logInfo(accountId, `Left banned group: ${group.name}`, userId);
                }
              } else {
                console.log(`[GROUPS] Could not leave group "${group.name}": group entity not available`);
              }
            } catch (leaveError) {
              // If we can't leave, that's okay - we've already marked it as inactive
              console.log(`[GROUPS] Could not leave group "${group.name}": ${leaveError.message}`);
              loggingService.logWarning(accountId, `Could not leave banned group ${group.name}: ${leaveError.message}`, userId);
            }
            
            errorCount++;
            // Continue to next group
            continue;
          }
          
          errorCount++;
          const errorGroupName = group.name || 'Unknown Group';
          const errorGroupId = group.entity?.id?.toString() || group.entity?.id || 'unknown';
          console.log(`[BROADCAST] ❌ Failed to send to group "${errorGroupName}" (ID: ${errorGroupId}): ${error.message}`);
          logError(`[BROADCAST ERROR] Error sending to ${errorGroupName}:`, error);
          loggingService.logError(accountId, `Error sending to ${errorGroupName}: ${error.message}`, userId);
          
          // Record analytics for failure
          analyticsService.recordGroupAnalytics(accountId, errorGroupId, errorGroupName, false, error.message).catch(err => {
            console.log(`[SILENT_FAIL] Analytics recording failed: ${err.message}`);
          });
          
          // If rate limited, wait longer before continuing
          if (error.message.includes('FLOOD') || error.message.includes('rate') || error.code === 429) {
            console.log(`[BROADCAST] Rate limit detected, waiting 30 seconds before continuing...`);
            await new Promise((resolve) => setTimeout(resolve, 30000));
          } else {
            // For other errors, wait a bit before continuing
            await new Promise((resolve) => setTimeout(resolve, 2000));
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
      console.log(`[BROADCAST] 📊 Summary: Total groups: ${groups.length}, Success: ${successCount}, Errors: ${errorCount}, Success rate: ${groups.length > 0 ? ((successCount / groups.length) * 100).toFixed(1) : 0}%`);
      
      // Record broadcast statistics
      broadcastStatsService.recordStats(accountId, groups.length, successCount, errorCount).catch(err => {
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
