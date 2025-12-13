/**
 * Scheduled Message Processor
 * Background task that processes scheduled messages
 */

import messageSchedulerService from './messageSchedulerService.js';
import automationService from './automationService.js';
import accountLinker from './accountLinker.js';
import db from '../database/db.js';
import logger from '../utils/logger.js';

class ScheduledMessageProcessor {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
  }

  /**
   * Start the processor
   */
  start() {
    if (this.isRunning) {
      console.log('[SCHEDULER] Processor already running');
      return;
    }

    this.isRunning = true;
    console.log('[SCHEDULER] Started scheduled message processor');

    // Check every minute for pending messages
    this.intervalId = setInterval(async () => {
      await this.processPendingMessages();
    }, 60000); // 1 minute

    // Process immediately on start
    this.processPendingMessages();
  }

  /**
   * Stop the processor
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('[SCHEDULER] Stopped scheduled message processor');
  }

  /**
   * Process pending scheduled messages
   */
  async processPendingMessages() {
    try {
      const pending = await messageSchedulerService.getPendingMessages();
      if (!pending.success || pending.messages.length === 0) {
        return;
      }

      console.log(`[SCHEDULER] Processing ${pending.messages.length} pending messages`);

      for (const scheduledMessage of pending.messages) {
        try {
          const accountId = scheduledMessage.account_id;
          
          // Get user ID for this account from database
          const accountQuery = await db.query(
            'SELECT user_id FROM accounts WHERE account_id = $1',
            [accountId]
          );
          
          if (!accountQuery.rows || accountQuery.rows.length === 0) {
            console.log(`[SCHEDULER] No user found for account ${accountId}`);
            await messageSchedulerService.markAsSent(scheduledMessage.id);
            continue;
          }

          const userId = accountQuery.rows[0].user_id;

          // Check if account is linked and active
          if (!accountLinker.isLinked(userId)) {
            console.log(`[SCHEDULER] Account ${accountId} not linked, skipping`);
            await messageSchedulerService.markAsSent(scheduledMessage.id);
            continue;
          }

          // Start broadcast with scheduled message
          const result = await automationService.startBroadcast(userId, scheduledMessage.message_text);
          
          if (result.success) {
            await messageSchedulerService.markAsSent(scheduledMessage.id);
            
            // Handle repeat scheduling
            const repeatResult = await messageSchedulerService.handleRepeat(scheduledMessage);
            if (repeatResult.success && repeatResult.shouldReschedule) {
              console.log(`[SCHEDULER] Rescheduled message for ${repeatResult.nextTime}`);
            }
          } else {
            console.log(`[SCHEDULER] Failed to send scheduled message: ${result.error}`);
          }
        } catch (error) {
          logger.logError('SCHEDULER', null, error, `Failed to process scheduled message ${scheduledMessage.id}`);
        }
      }
    } catch (error) {
      logger.logError('SCHEDULER', null, error, 'Error in processPendingMessages');
    }
  }
}

export default new ScheduledMessageProcessor();
