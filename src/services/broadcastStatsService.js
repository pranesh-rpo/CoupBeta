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
      // Validate account exists before recording stats (prevents foreign key constraint errors)
      const accountCheck = await db.query('SELECT 1 FROM accounts WHERE account_id = $1', [accountId]);
      if (accountCheck.rows.length === 0) {
        console.log(`[STATS] Account ${accountId} not found, skipping stats recording`);
        return { success: false, error: 'Account not found' };
      }

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
      // Calculate start date
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startDateStr = startDate.toISOString().split('T')[0];
      
      const result = await db.query(
        `SELECT 
           COUNT(*) as total_broadcasts,
           SUM(messages_sent) as total_sent,
           SUM(messages_failed) as total_failed,
           AVG(success_rate) as avg_success_rate,
           MAX(broadcast_date) as last_broadcast,
           MIN(broadcast_date) as first_broadcast
         FROM broadcast_stats
         WHERE account_id = ? AND broadcast_date >= ?`,
        [accountId, startDateStr]
      );
      return { success: true, summary: result.rows[0] };
    } catch (error) {
      logger.logError('STATS', accountId, error, 'Failed to get summary');
      return { success: false, error: error.message, summary: null };
    }
  }

  /**
   * Get statistics for a specific period (week, month, etc.)
   */
  async getPeriodStats(accountId, days) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startDateStr = startDate.toISOString().split('T')[0];
      
      const result = await db.query(
        `SELECT 
           COUNT(*) as total_broadcasts,
           SUM(messages_sent) as total_sent,
           SUM(messages_failed) as total_failed,
           AVG(success_rate) as avg_success_rate,
           MAX(success_rate) as max_success_rate,
           MIN(success_rate) as min_success_rate,
           SUM(total_groups) as total_groups_reached
         FROM broadcast_stats
         WHERE account_id = ? AND broadcast_date >= ?`,
        [accountId, startDateStr]
      );
      return { success: true, stats: result.rows[0] };
    } catch (error) {
      logger.logError('STATS', accountId, error, 'Failed to get period stats');
      return { success: false, error: error.message, stats: null };
    }
  }

  /**
   * Get comparison with previous period
   */
  async getPeriodComparison(accountId, days) {
    try {
      const currentStart = new Date();
      currentStart.setDate(currentStart.getDate() - days);
      const currentStartStr = currentStart.toISOString().split('T')[0];
      
      const previousStart = new Date();
      previousStart.setDate(previousStart.getDate() - (days * 2));
      const previousStartStr = previousStart.toISOString().split('T')[0];
      const previousEndStr = currentStartStr;
      
      const currentPeriod = await db.query(
        `SELECT 
           SUM(messages_sent) as total_sent,
           SUM(messages_failed) as total_failed,
           AVG(success_rate) as avg_success_rate
         FROM broadcast_stats
         WHERE account_id = ? AND broadcast_date >= ?`,
        [accountId, currentStartStr]
      );

      const previousPeriod = await db.query(
        `SELECT 
           SUM(messages_sent) as total_sent,
           SUM(messages_failed) as total_failed,
           AVG(success_rate) as avg_success_rate
         FROM broadcast_stats
         WHERE account_id = ? AND broadcast_date >= ? AND broadcast_date < ?`,
        [accountId, previousStartStr, previousEndStr]
      );

      return {
        success: true,
        current: currentPeriod.rows[0] || { total_sent: 0, total_failed: 0, avg_success_rate: 0 },
        previous: previousPeriod.rows[0] || { total_sent: 0, total_failed: 0, avg_success_rate: 0 }
      };
    } catch (error) {
      logger.logError('STATS', accountId, error, 'Failed to get period comparison');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get daily trend for the last N days
   */
  async getDailyTrend(accountId, days = 7) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startDateStr = startDate.toISOString().split('T')[0];
      
      const result = await db.query(
        `SELECT 
           broadcast_date,
           messages_sent,
           messages_failed,
           success_rate,
           total_groups
         FROM broadcast_stats
         WHERE account_id = ? AND broadcast_date >= ?
         ORDER BY broadcast_date ASC`,
        [accountId, startDateStr]
      );
      return { success: true, trend: result.rows };
    } catch (error) {
      logger.logError('STATS', accountId, error, 'Failed to get daily trend');
      return { success: false, error: error.message, trend: [] };
    }
  }

  /**
   * Get all-time statistics
   */
  async getAllTimeStats(accountId) {
    try {
      const result = await db.query(
        `SELECT 
           COUNT(*) as total_broadcasts,
           SUM(messages_sent) as total_sent,
           SUM(messages_failed) as total_failed,
           AVG(success_rate) as avg_success_rate,
           MAX(broadcast_date) as last_broadcast,
           MIN(broadcast_date) as first_broadcast,
           MAX(success_rate) as best_day_rate,
           MIN(success_rate) as worst_day_rate
         FROM broadcast_stats
         WHERE account_id = ?`,
        [accountId]
      );
      return { success: true, stats: result.rows[0] };
    } catch (error) {
      logger.logError('STATS', accountId, error, 'Failed to get all-time stats');
      return { success: false, error: error.message, stats: null };
    }
  }
}

export default new BroadcastStatsService();
