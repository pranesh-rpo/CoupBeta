/**
 * Smart Scheduler Service
 * Intelligent scheduling based on best times
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';
import broadcastStatsService from './broadcastStatsService.js';

class SmartSchedulerService {
  /**
   * Analyze best times for sending
   */
  async analyzeBestTimes(accountId, days = 30) {
    try {
      // Get statistics for different hours
      const result = await db.query(
        `SELECT 
           EXTRACT(HOUR FROM timestamp) as hour,
           COUNT(*) as total_sent,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count
         FROM logs
         WHERE account_id = ? 
           AND log_type = 'broadcast'
           AND timestamp >= datetime('now', '-${days} days')
         GROUP BY hour
         ORDER BY (CAST(success_count AS REAL) / NULLIF(total_sent, 0)) DESC, total_sent DESC
         LIMIT 5`,
        [accountId]
      );

      const bestHours = result.rows.map(row => ({
        hour: parseInt(row.hour),
        successRate: row.total_sent > 0 ? (row.success_count / row.total_sent * 100).toFixed(1) : 0,
        totalSent: parseInt(row.total_sent)
      }));

      return { success: true, bestHours };
    } catch (error) {
      logger.logError('SMART_SCHEDULER', accountId, error, 'Failed to analyze best times');
      return { success: false, error: error.message, bestHours: [] };
    }
  }

  /**
   * Suggest best time for next broadcast
   */
  async suggestBestTime(accountId) {
    try {
      const analysis = await this.analyzeBestTimes(accountId);
      if (!analysis.success || analysis.bestHours.length === 0) {
        // Default to 10 AM if no data
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(10, 0, 0, 0);
        return { success: true, suggestedTime: tomorrow };
      }

      const bestHour = analysis.bestHours[0].hour;
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(bestHour, 0, 0, 0);

      return { success: true, suggestedTime: tomorrow, bestHour };
    } catch (error) {
      logger.logError('SMART_SCHEDULER', accountId, error, 'Failed to suggest best time');
      return { success: false, error: error.message };
    }
  }
}

export default new SmartSchedulerService();
