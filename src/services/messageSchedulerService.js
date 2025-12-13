/**
 * Message Scheduler Service
 * Manages scheduled messages
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class MessageSchedulerService {
  /**
   * Schedule a message
   */
  async scheduleMessage(accountId, messageText, scheduledTime, timezone = 'Asia/Kolkata', repeatType = 'once', repeatUntil = null) {
    try {
      const result = await db.query(
        `INSERT INTO scheduled_messages (account_id, message_text, scheduled_time, timezone, repeat_type, repeat_until)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [accountId, messageText, scheduledTime, timezone, repeatType, repeatUntil]
      );
      logger.logChange('SCHEDULER', accountId, `Scheduled message for ${scheduledTime}`);
      return { success: true, scheduledMessage: result.rows[0] };
    } catch (error) {
      logger.logError('SCHEDULER', accountId, error, 'Failed to schedule message');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get pending scheduled messages
   */
  async getPendingMessages(accountId = null) {
    try {
      let query = `SELECT * FROM scheduled_messages WHERE is_sent = FALSE AND scheduled_time <= NOW()`;
      const params = [];
      
      if (accountId) {
        query += ` AND account_id = $1`;
        params.push(accountId);
      }
      
      query += ` ORDER BY scheduled_time ASC`;
      
      const result = await db.query(query, params);
      return { success: true, messages: result.rows };
    } catch (error) {
      logger.logError('SCHEDULER', null, error, 'Failed to get pending messages');
      return { success: false, error: error.message, messages: [] };
    }
  }

  /**
   * Mark message as sent
   */
  async markAsSent(scheduledMessageId) {
    try {
      await db.query(
        `UPDATE scheduled_messages SET is_sent = TRUE, sent_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [scheduledMessageId]
      );
      return { success: true };
    } catch (error) {
      logger.logError('SCHEDULER', null, error, 'Failed to mark as sent');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all scheduled messages for account
   */
  async getScheduledMessages(accountId) {
    try {
      const result = await db.query(
        `SELECT * FROM scheduled_messages 
         WHERE account_id = $1 
         ORDER BY scheduled_time ASC`,
        [accountId]
      );
      return { success: true, messages: result.rows };
    } catch (error) {
      logger.logError('SCHEDULER', accountId, error, 'Failed to get scheduled messages');
      return { success: false, error: error.message, messages: [] };
    }
  }

  /**
   * Delete scheduled message
   */
  async deleteScheduledMessage(accountId, messageId) {
    try {
      await db.query(
        `DELETE FROM scheduled_messages WHERE id = $1 AND account_id = $2`,
        [messageId, accountId]
      );
      logger.logChange('SCHEDULER', accountId, `Deleted scheduled message ${messageId}`);
      return { success: true };
    } catch (error) {
      logger.logError('SCHEDULER', accountId, error, 'Failed to delete scheduled message');
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle repeat scheduling
   */
  async handleRepeat(scheduledMessage) {
    try {
      if (scheduledMessage.repeat_type === 'once') {
        return { success: true, shouldReschedule: false };
      }

      const now = new Date();
      const scheduledTime = new Date(scheduledMessage.scheduled_time);
      let nextScheduledTime = null;

      switch (scheduledMessage.repeat_type) {
        case 'daily':
          nextScheduledTime = new Date(scheduledTime);
          nextScheduledTime.setDate(nextScheduledTime.getDate() + 1);
          break;
        case 'weekly':
          nextScheduledTime = new Date(scheduledTime);
          nextScheduledTime.setDate(nextScheduledTime.getDate() + 7);
          break;
        case 'monthly':
          nextScheduledTime = new Date(scheduledTime);
          nextScheduledTime.setMonth(nextScheduledTime.getMonth() + 1);
          break;
      }

      if (nextScheduledTime && (!scheduledMessage.repeat_until || nextScheduledTime <= new Date(scheduledMessage.repeat_until))) {
        await db.query(
          `UPDATE scheduled_messages 
           SET scheduled_time = $1, is_sent = FALSE, sent_at = NULL 
           WHERE id = $2`,
          [nextScheduledTime, scheduledMessage.id]
        );
        return { success: true, shouldReschedule: true, nextTime: nextScheduledTime };
      }

      return { success: true, shouldReschedule: false };
    } catch (error) {
      logger.logError('SCHEDULER', null, error, 'Failed to handle repeat');
      return { success: false, error: error.message };
    }
  }
}

export default new MessageSchedulerService();
