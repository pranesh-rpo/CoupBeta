/**
 * Broadcast Statistics Service
 * Tracks and manages broadcast statistics
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class BroadcastStatsService {
  /**
   * Record broadcast statistics
   */
  async recordStats(accountId, totalGroups, messagesSent, messagesFailed) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const successRate = totalGroups > 0 ? ((messagesSent / totalGroups) * 100).toFixed(2) : 0;
      
      await db.query(
        `INSERT INTO broadcast_stats (account_id, broadcast_date, total_groups, messages_sent, messages_failed, success_rate)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id, broadcast_date) DO UPDATE
         SET total_groups = EXCLUDED.total_groups,
             messages_sent = broadcast_stats.messages_sent + EXCLUDED.messages_sent,
             messages_failed = broadcast_stats.messages_failed + EXCLUDED.messages_failed,
             success_rate = EXCLUDED.success_rate,
             updated_at = CURRENT_TIMESTAMP`,
        [accountId, today, totalGroups, messagesSent, messagesFailed, successRate]
      );
      
      logger.logChange('STATS', accountId, `Recorded stats: ${messagesSent} sent, ${messagesFailed} failed`);
      return { success: true };
    } catch (error) {
      logger.logError('STATS', accountId, error, 'Failed to record stats');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get statistics for date range
   */
  async getStats(accountId, startDate, endDate) {
    try {
      const result = await db.query(
        `SELECT * FROM broadcast_stats 
         WHERE account_id = $1 AND broadcast_date BETWEEN $2 AND $3
         ORDER BY broadcast_date DESC`,
        [accountId, startDate, endDate]
      );
      return { success: true, stats: result.rows };
    } catch (error) {
      logger.logError('STATS', accountId, error, 'Failed to get stats');
      return { success: false, error: error.message, stats: [] };
    }
  }

  /**
   * Get today's statistics
   */
  async getTodayStats(accountId) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const result = await db.query(
        `SELECT * FROM broadcast_stats 
         WHERE account_id = $1 AND broadcast_date = $2`,
        [accountId, today]
      );
      return { success: true, stats: result.rows[0] || null };
    } catch (error) {
      logger.logError('STATS', accountId, error, 'Failed to get today stats');
      return { success: false, error: error.message, stats: null };
    }
  }

  /**
   * Get summary statistics
   */
  async getSummary(accountId, days = 30) {
    try {
      const result = await db.query(
        `SELECT 
           COUNT(*) as total_broadcasts,
           SUM(messages_sent) as total_sent,
           SUM(messages_failed) as total_failed,
           AVG(success_rate) as avg_success_rate,
           MAX(broadcast_date) as last_broadcast
         FROM broadcast_stats
         WHERE account_id = $1 AND broadcast_date >= CURRENT_DATE - INTERVAL '${days} days'`,
        [accountId]
      );
      return { success: true, summary: result.rows[0] };
    } catch (error) {
      logger.logError('STATS', accountId, error, 'Failed to get summary');
      return { success: false, error: error.message, summary: null };
    }
  }
}

export default new BroadcastStatsService();
