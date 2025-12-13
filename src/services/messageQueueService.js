/**
 * Message Queue Service
 * Manages message queue for prioritized sending
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class MessageQueueService {
  /**
   * Add message to queue
   */
  async addToQueue(accountId, messageText, priority = 5, scheduledFor = null) {
    try {
      const result = await db.query(
        `INSERT INTO message_queue (account_id, message_text, priority, scheduled_for, status)
         VALUES ($1, $2, $3, $4, 'pending')
         RETURNING *`,
        [accountId, messageText, priority, scheduledFor]
      );
      logger.logChange('QUEUE', accountId, `Added message to queue (priority: ${priority})`);
      return { success: true, queueItem: result.rows[0] };
    } catch (error) {
      logger.logError('QUEUE', accountId, error, 'Failed to add to queue');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get next message from queue
   */
  async getNextMessage(accountId = null) {
    try {
      let query = `SELECT * FROM message_queue WHERE status = 'pending'`;
      const params = [];
      
      if (accountId) {
        query += ` AND account_id = $1`;
        params.push(accountId);
      }
      
      query += ` AND (scheduled_for IS NULL OR scheduled_for <= NOW())
                 ORDER BY priority DESC, created_at ASC
                 LIMIT 1`;
      
      const result = await db.query(query, params);
      return { success: true, message: result.rows[0] || null };
    } catch (error) {
      logger.logError('QUEUE', accountId, error, 'Failed to get next message');
      return { success: false, error: error.message, message: null };
    }
  }

  /**
   * Mark message as processing
   */
  async markAsProcessing(queueId) {
    try {
      await db.query(
        `UPDATE message_queue SET status = 'processing', processed_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [queueId]
      );
      return { success: true };
    } catch (error) {
      logger.logError('QUEUE', null, error, 'Failed to mark as processing');
      return { success: false, error: error.message };
    }
  }

  /**
   * Mark message as sent
   */
  async markAsSent(queueId) {
    try {
      await db.query(
        `UPDATE message_queue SET status = 'sent' WHERE id = $1`,
        [queueId]
      );
      return { success: true };
    } catch (error) {
      logger.logError('QUEUE', null, error, 'Failed to mark as sent');
      return { success: false, error: error.message };
    }
  }

  /**
   * Mark message as failed
   */
  async markAsFailed(queueId, errorMessage) {
    try {
      await db.query(
        `UPDATE message_queue SET status = 'failed', error_message = $1, attempts = attempts + 1 WHERE id = $2`,
        [errorMessage, queueId]
      );
      return { success: true };
    } catch (error) {
      logger.logError('QUEUE', null, error, 'Failed to mark as failed');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get queue status
   */
  async getQueueStatus(accountId) {
    try {
      const result = await db.query(
        `SELECT 
           COUNT(*) FILTER (WHERE status = 'pending') as pending,
           COUNT(*) FILTER (WHERE status = 'processing') as processing,
           COUNT(*) FILTER (WHERE status = 'sent') as sent,
           COUNT(*) FILTER (WHERE status = 'failed') as failed
         FROM message_queue
         WHERE account_id = $1`,
        [accountId]
      );
      return { success: true, status: result.rows[0] };
    } catch (error) {
      logger.logError('QUEUE', accountId, error, 'Failed to get queue status');
      return { success: false, error: error.message, status: null };
    }
  }

  /**
   * Clear queue
   */
  async clearQueue(accountId, status = null) {
    try {
      let query = `DELETE FROM message_queue WHERE account_id = $1`;
      const params = [accountId];
      
      if (status) {
        query += ` AND status = $2`;
        params.push(status);
      }
      
      await db.query(query, params);
      logger.logChange('QUEUE', accountId, `Cleared queue${status ? ` (status: ${status})` : ''}`);
      return { success: true };
    } catch (error) {
      logger.logError('QUEUE', accountId, error, 'Failed to clear queue');
      return { success: false, error: error.message };
    }
  }
}

export default new MessageQueueService();
