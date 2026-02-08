/**
 * Channel Verification Service
 * Monitors verified users to ensure they remain in the updates channel(s)
 * Revokes verification if they leave
 */

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import db from '../database/db.js';
import userService from './userService.js';
import automationService from './automationService.js';
import logger from '../utils/logger.js';
import accountLinker from './accountLinker.js';
import { isFloodWaitError, extractWaitTime, waitForFloodError, safeBotApiCall } from '../utils/floodWaitHandler.js';

class ChannelVerificationService {
  constructor() {
    this.bot = null;
    this.checkInterval = null;
    this.isRunning = false;
    this.isChecking = false; // Prevent concurrent checks
    this.checkIntervalMs = 5 * 60 * 1000; // Check every 5 minutes
    this.batchSize = 10; // Check 10 users at a time to avoid rate limits
    this.delayBetweenBatches = 2000; // 2 seconds between batches
    this.delayBetweenChecks = 500; // 500ms between individual user checks
  }

  /**
   * Initialize the service with bot instance
   */
  initialize(botInstance) {
    if (!botInstance) {
      console.log('[CHANNEL_VERIFICATION] Bot instance not provided, service not started');
      return;
    }
    
    this.bot = botInstance;
    
    // Only start if updates channels are configured
    const updatesChannels = config.getUpdatesChannels();
    if (updatesChannels.length === 0) {
      console.log('[CHANNEL_VERIFICATION] No updates channels configured, service not started');
      return;
    }
    
    this.start();
    console.log('[CHANNEL_VERIFICATION] Service initialized and started');
  }

  /**
   * Start periodic checking
   */
  start() {
    if (this.isRunning) {
      console.log('[CHANNEL_VERIFICATION] Service already running');
      return;
    }

    if (!this.bot) {
      console.error('[CHANNEL_VERIFICATION] Cannot start: bot instance not set');
      return;
    }

    this.isRunning = true;
    
    // Run initial check after 30 seconds (to let bot fully initialize)
    setTimeout(() => {
      this.checkAllVerifiedUsers();
    }, 30000);

    // Then check periodically
    this.checkInterval = setInterval(() => {
      this.checkAllVerifiedUsers();
    }, this.checkIntervalMs);

    console.log(`[CHANNEL_VERIFICATION] Started periodic checks (every ${this.checkIntervalMs / 1000 / 60} minutes)`);
  }

  /**
   * Stop periodic checking
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isRunning = false;
    // Note: Don't set isChecking to false here - let current check finish
    console.log('[CHANNEL_VERIFICATION] Service stopped (current check will finish)');
  }

  /**
   * Check all verified users to see if they're still in the channel(s)
   * Uses batching to avoid rate limits
   */
  async checkAllVerifiedUsers() {
    // Prevent concurrent checks
    if (this.isChecking) {
      console.log('[CHANNEL_VERIFICATION] Check already in progress, skipping...');
      return;
    }

    if (!this.bot) {
      return;
    }

    const updatesChannels = config.getUpdatesChannels();
    if (updatesChannels.length === 0) {
      return;
    }

    this.isChecking = true;

    try {
      // Check if service is still running (might have been stopped)
      if (!this.isRunning && this.checkInterval === null) {
        console.log('[CHANNEL_VERIFICATION] Service stopped, aborting check');
        this.isChecking = false;
        return;
      }

      // Get all verified users
      // SQLite uses INTEGER (0/1) for booleans
      const verifiedUsers = await db.query(
        'SELECT user_id FROM users WHERE is_verified = 1 AND is_active = 1'
      );

      if (verifiedUsers.rows.length === 0) {
        this.isChecking = false;
        return;
      }

      console.log(`[CHANNEL_VERIFICATION] Checking ${verifiedUsers.rows.length} verified users...`);

      let revokedCount = 0;
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));

      // Process users in batches to avoid rate limits
      const userIds = verifiedUsers.rows.map(row => {
        if (!row || row.user_id === null || row.user_id === undefined) {
          return null;
        }
        // Handle BigInt, string, or number
        let userId = row.user_id;
        if (typeof userId === 'bigint') {
          userId = Number(userId);
        } else if (typeof userId === 'string') {
          userId = parseInt(userId, 10);
        }
        return userId;
      }).filter(id => id !== null && !isNaN(id) && id > 0);

      // Process in batches
      for (let i = 0; i < userIds.length; i += this.batchSize) {
        // Check if service is still running (might have been stopped)
        if (!this.isRunning && this.checkInterval === null) {
          console.log('[CHANNEL_VERIFICATION] Service stopped during batch processing, aborting');
          break;
        }

        const batch = userIds.slice(i, i + this.batchSize);
        
        // Process batch
        for (const userId of batch) {
          try {
            const isStillMember = await this.checkUserMembership(userId, channelUsernames);
            
            if (!isStillMember) {
              // User left the channel, revoke verification
              await this.revokeVerification(userId);
              revokedCount++;
            }
            
            // Small delay between individual checks
            if (i + batch.indexOf(userId) < userIds.length - 1) {
              await new Promise(resolve => setTimeout(resolve, this.delayBetweenChecks));
            }
          } catch (error) {
            // Handle rate limiting with proper FloodWaitError handling
            if (isFloodWaitError(error)) {
              const waitSeconds = extractWaitTime(error);
              if (waitSeconds !== null && waitSeconds > 0) {
                console.warn(`[CHANNEL_VERIFICATION] Rate limited, waiting ${waitSeconds + 1} seconds...`);
                await waitForFloodError(error, 1);
                // Retry this user
                i--; // Decrement to retry this batch
                break;
              } else {
                // Fallback: wait 60 seconds if we can't extract wait time
                console.warn(`[CHANNEL_VERIFICATION] Rate limited (couldn't extract wait time), waiting 60 seconds...`);
                await new Promise(resolve => setTimeout(resolve, 60000));
                i--; // Decrement to retry this batch
                break;
              }
            }
            
            // Log error but continue checking other users
            console.error(`[CHANNEL_VERIFICATION] Error checking user ${userId}:`, error.message);
            logger.logError('CHANNEL_VERIFICATION', userId, error, 'Error checking user channel membership');
          }
        }
        
        // Delay between batches (except for last batch)
        if (i + this.batchSize < userIds.length) {
          await new Promise(resolve => setTimeout(resolve, this.delayBetweenBatches));
        }
      }

      if (revokedCount > 0) {
        console.log(`[CHANNEL_VERIFICATION] Revoked verification for ${revokedCount} user(s) who left the channel`);
      }
    } catch (error) {
      console.error('[CHANNEL_VERIFICATION] Error checking verified users:', error);
      logger.logError('CHANNEL_VERIFICATION', null, error, 'Error in periodic channel verification check');
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Check if a user is a member of ALL required updates channels
   * User must be in ALL channels to be verified (not just one)
   */
  async checkUserMembership(userId, channelUsernames) {
    if (!this.bot) {
      return false;
    }

    if (!userId || isNaN(userId)) {
      console.error(`[CHANNEL_VERIFICATION] Invalid userId: ${userId}`);
      return false;
    }

    if (!channelUsernames || channelUsernames.length === 0) {
      return false;
    }

    // Check each channel - user needs to be in ALL channels
    for (const channelUsername of channelUsernames) {
      if (!channelUsername || typeof channelUsername !== 'string') {
        continue; // Skip invalid channel names
      }

      try {
        // CRITICAL: Use safeBotApiCall to prevent rate limiting and bot deletion
        // getChat and getChatMember can trigger rate limits if called too frequently
        const chat = await safeBotApiCall(
          () => this.bot.getChat(`@${channelUsername}`),
          { maxRetries: 3, bufferSeconds: 1, throwOnFailure: false }
        );
        
        // Validate chat response
        if (!chat || !chat.id) {
          console.warn(`[CHANNEL_VERIFICATION] Invalid chat response for @${channelUsername}`);
          return false; // Can't verify this channel, so user is not verified
        }

        const channelId = chat.id;
        
        // CRITICAL: Use safeBotApiCall for getChatMember to prevent rate limiting
        const member = await safeBotApiCall(
          () => this.bot.getChatMember(channelId, userId),
          { maxRetries: 3, bufferSeconds: 1, throwOnFailure: false }
        );
        
        // If API call failed, return false
        if (!member) {
          console.warn(`[CHANNEL_VERIFICATION] Failed to get chat member for user ${userId} in @${channelUsername}`);
          return false;
        }
        
        // Validate member response
        if (!member || !member.status) {
          console.warn(`[CHANNEL_VERIFICATION] Invalid member response for user ${userId} in @${channelUsername}`);
          return false; // Can't verify membership, so user is not verified
        }
        
        // User is a member if status is 'member', 'administrator', or 'creator'
        const isMember = member.status === 'member' || 
                        member.status === 'administrator' || 
                        member.status === 'creator';
        
        if (!isMember) {
          // User is not in this channel - they must be in ALL channels
          console.log(`[CHANNEL_VERIFICATION] User ${userId} is not a member of @${channelUsername} (required channel)`);
          return false;
        }
      } catch (checkError) {
        const errorMessage = checkError.message || checkError.toString() || '';
        const errorCode = checkError.response?.error_code || checkError.code;
        
        // Handle different error types
        if (errorCode === 429 || isFloodWaitError(checkError)) {
          // Rate limited - rethrow to be handled by caller
          throw checkError;
        } else if (errorCode === 400 && errorMessage.includes('chat not found')) {
          // Channel doesn't exist or bot doesn't have access
          console.warn(`[CHANNEL_VERIFICATION] Channel @${channelUsername} not found or inaccessible`);
          return false; // Can't verify this channel, so user is not verified
        } else if (errorCode === 403 && errorMessage.includes('not enough rights')) {
          // Bot is not admin of the channel
          console.warn(`[CHANNEL_VERIFICATION] Bot is not admin of @${channelUsername} - cannot verify membership`);
          return false; // Can't verify this channel, so user is not verified
        } else if (errorCode === 400 && (errorMessage.includes('user not found') || errorMessage.includes('chat not found'))) {
          // User is likely not a member
          console.log(`[CHANNEL_VERIFICATION] User ${userId} not found in @${channelUsername} (likely not a member)`);
          return false; // User is not in this required channel
        } else {
          // Other errors - log and return false (can't verify)
          console.log(`[CHANNEL_VERIFICATION] Could not check membership for user ${userId} in @${channelUsername}: ${errorMessage}`);
          return false;
        }
      }
    }

    // User is a member of ALL channels
    return true;
  }

  /**
   * Revoke verification for a user who left the channel
   */
  async revokeVerification(userId) {
    if (!userId || isNaN(userId)) {
      console.error(`[CHANNEL_VERIFICATION] Invalid userId for revocation: ${userId}`);
      return;
    }

    try {
      // Double-check user is still verified (avoid race condition with concurrent verification)
      const isCurrentlyVerified = await userService.isUserVerified(userId);
      if (!isCurrentlyVerified) {
        console.log(`[CHANNEL_VERIFICATION] User ${userId} already unverified, skipping revocation`);
        return;
      }

      console.log(`[CHANNEL_VERIFICATION] Revoking verification for user ${userId} - left channel`);

      // Update verification status
      await userService.updateUserVerification(userId, false);

      // Stop any active broadcasts for this user
      try {
        const activeAccountIds = automationService.getBroadcastingAccountIds(userId);
        if (activeAccountIds && activeAccountIds.length > 0) {
          console.log(`[CHANNEL_VERIFICATION] Stopping ${activeAccountIds.length} active broadcast(s) for user ${userId}`);
          
          for (const accountId of activeAccountIds) {
            try {
              await automationService.stopBroadcast(userId, accountId);
            } catch (error) {
              console.error(`[CHANNEL_VERIFICATION] Error stopping broadcast for account ${accountId}:`, error.message);
              logger.logError('CHANNEL_VERIFICATION', userId, error, `Error stopping broadcast for account ${accountId}`);
            }
          }
        }
      } catch (error) {
        // Log but don't fail revocation if broadcast stopping fails
        console.error(`[CHANNEL_VERIFICATION] Error getting/stopping broadcasts for user ${userId}:`, error.message);
      }

      // Notify the user (don't fail revocation if notification fails)
      try {
        await this.notifyUserLeftChannel(userId);
      } catch (error) {
        console.error(`[CHANNEL_VERIFICATION] Error notifying user ${userId}:`, error.message);
        // Don't throw - notification failure shouldn't prevent revocation
      }

      logger.logChange('CHANNEL_VERIFICATION', userId, 'Verification revoked - user left updates channel');
    } catch (error) {
      console.error(`[CHANNEL_VERIFICATION] Error revoking verification for user ${userId}:`, error);
      logger.logError('CHANNEL_VERIFICATION', userId, error, 'Error revoking verification');
      // Don't throw - allow other users to be checked
    }
  }

  /**
   * Notify user that they've been unverified due to leaving the channel
   * CRITICAL: Only sends to users who have used /start (are in users table)
   */
  async notifyUserLeftChannel(userId) {
    if (!this.bot) {
      return;
    }

    try {
      // CRITICAL: Verify user exists in users table (has used /start) before sending
      // This ensures ToS compliance - only send to users who have interacted with bot
      const userCheck = await db.query('SELECT user_id FROM users WHERE user_id = $1', [userId]);
      if (!userCheck.rows || userCheck.rows.length === 0) {
        console.log(`[CHANNEL_VERIFICATION] User ${userId} not in users table (never used /start), skipping notification to prevent ToS violation`);
        return; // Don't send to users who haven't used /start
      }

      const updatesChannels = config.getUpdatesChannels();
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
      const channelList = channelUsernames.map(ch => `📢 @${ch}`).join('\n');

      const notificationMessage = `
⚠️ <b>Verification Revoked</b>

You have been removed from our updates channel(s), so your verification has been revoked.

To continue using the bot, please rejoin:

${channelList}

After rejoining, use /start and click "✅ Verify" to restore access.
      `;

      // Create keyboard with channel buttons
      const keyboard = [
        [{ text: '✅ Verify', callback_data: 'btn_verify_channel' }]
      ];
      
      for (const channelUsername of channelUsernames) {
        keyboard.push([{ text: `📢 Join @${channelUsername}`, url: `https://t.me/${channelUsername}` }]);
      }

      await this.bot.sendMessage(userId, notificationMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: keyboard
        }
      });

      console.log(`[CHANNEL_VERIFICATION] Notified user ${userId} about verification revocation`);
    } catch (error) {
      const errorMessage = error.message || error.toString() || '';
      const errorCode = error.response?.error_code || error.code;
      
      // Handle different error types gracefully
      if (errorMessage.includes('blocked') || errorCode === 403) {
        console.log(`[CHANNEL_VERIFICATION] Could not notify user ${userId} - bot blocked or user privacy settings`);
      } else if (errorCode === 400 && errorMessage.includes('chat not found')) {
        console.log(`[CHANNEL_VERIFICATION] Could not notify user ${userId} - chat not found`);
      } else if (errorCode === 429 || isFloodWaitError(error)) {
        const waitSeconds = extractWaitTime(error);
        if (waitSeconds !== null && waitSeconds > 0) {
          console.warn(`[CHANNEL_VERIFICATION] Rate limited while notifying user ${userId}, waiting ${waitSeconds + 1}s...`);
          await waitForFloodError(error, 1);
          // Could implement retry logic here if needed
        } else {
          console.warn(`[CHANNEL_VERIFICATION] Rate limited while notifying user ${userId}`);
        }
      } else {
        console.error(`[CHANNEL_VERIFICATION] Error notifying user ${userId}:`, errorMessage);
      }
    }
  }

  /**
   * Manually check a specific user (useful for real-time checks)
   */
  async checkUser(userId) {
    const updatesChannels = config.getUpdatesChannels();
    if (updatesChannels.length === 0) {
      return { isMember: true }; // No channels configured, allow access
    }

    const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
    const isMember = await this.checkUserMembership(userId, channelUsernames);
    
    return { isMember };
  }

  /**
   * Fast method to handle when user leaves a required channel
   * Since user must be in ALL channels, leaving any one means they're not verified
   * This is called from real-time chat_member updates - optimized for speed
   * @param {number} userId - User ID who left the channel
   * @param {string} channelUsername - Username of the channel they left (for logging)
   */
  async handleUserLeftChannel(userId, channelUsername = null) {
    if (!userId || isNaN(userId)) {
      console.error(`[CHANNEL_LEAVE] Invalid userId: ${userId}`);
      return;
    }

    try {
      // Quick check if user is verified (fast DB query only)
      const isVerified = await userService.isUserVerified(userId);
      
      if (!isVerified) {
        // User already not verified, nothing to do
        return;
      }

      const channelInfo = channelUsername ? `@${channelUsername}` : 'a required channel';
      console.log(`[CHANNEL_LEAVE] Verified user ${userId} left ${channelInfo} - revoking verification immediately`);

      // Since user must be in ALL channels, leaving any one means they're not verified
      // No need for slow API calls to check other channels - revoke immediately
      await this.revokeVerification(userId);
    } catch (error) {
      console.error(`[CHANNEL_LEAVE] Error handling user leave for ${userId}:`, error.message);
      logger.logError('CHANNEL_LEAVE', userId, error, `Error handling user left channel ${channelUsername || 'unknown'}`);
    }
  }
}

export default new ChannelVerificationService();
