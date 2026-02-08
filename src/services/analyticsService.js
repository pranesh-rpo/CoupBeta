/**
 * Analytics Service
 * Provides analytics and reporting features
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class AnalyticsService {
  /**
   * Record group analytics
   */
  async recordGroupAnalytics(accountId, groupId, groupTitle, success, errorMessage = null) {
    try {
      // SQLite uses INTEGER (0/1) for booleans and EXCLUDED for ON CONFLICT
      const messagesSent = success ? 1 : 0;
      const messagesFailed = success ? 0 : 1;
      const result = await db.query(
        `INSERT INTO group_analytics (account_id, group_id, group_title, messages_sent, messages_failed, last_message_sent, last_error, is_active)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 1)
         ON CONFLICT (account_id, group_id) DO UPDATE
         SET messages_sent = group_analytics.messages_sent + EXCLUDED.messages_sent,
             messages_failed = group_analytics.messages_failed + EXCLUDED.messages_failed,
             last_message_sent = CASE WHEN EXCLUDED.messages_sent > 0 THEN CURRENT_TIMESTAMP ELSE group_analytics.last_message_sent END,
             last_error = CASE WHEN EXCLUDED.last_error IS NOT NULL THEN EXCLUDED.last_error ELSE group_analytics.last_error END,
             updated_at = CURRENT_TIMESTAMP`,
        [accountId, groupId, groupTitle, messagesSent, messagesFailed, errorMessage]
      );
      return { success: true };
    } catch (error) {
      logger.logError('ANALYTICS', accountId, error, 'Failed to record group analytics');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get group analytics
   */
  async getGroupAnalytics(accountId, groupId = null) {
    try {
      let query = `SELECT * FROM group_analytics WHERE account_id = $1`;
      const params = [accountId];
      
      if (groupId) {
        query += ` AND group_id = $2`;
        params.push(groupId);
      }
      
      query += ` ORDER BY messages_sent DESC, updated_at DESC`;
      
      const result = await db.query(query, params);
      return { success: true, analytics: result.rows };
    } catch (error) {
      logger.logError('ANALYTICS', accountId, error, 'Failed to get group analytics');
      return { success: false, error: error.message, analytics: [] };
    }
  }

  /**
   * Get top performing groups
   */
  async getTopGroups(accountId, limit = 10) {
    try {
      // SQLite uses INTEGER (0/1) for booleans and CAST(... AS REAL) instead of ::DECIMAL
      const result = await db.query(
        `SELECT * FROM group_analytics 
         WHERE account_id = ? AND is_active = 1
         ORDER BY messages_sent DESC, (CAST(messages_sent AS REAL) / NULLIF(messages_sent + messages_failed, 0)) DESC
         LIMIT ?`,
        [accountId, limit]
      );
      return { success: true, groups: result.rows };
    } catch (error) {
      logger.logError('ANALYTICS', accountId, error, 'Failed to get top groups');
      return { success: false, error: error.message, groups: [] };
    }
  }

  /**
   * Get problematic groups (high failure rate)
   */
  async getProblematicGroups(accountId, limit = 10) {
    try {
      // SQLite uses INTEGER (0/1) for booleans and CAST(... AS REAL) instead of ::DECIMAL
      const result = await db.query(
        `SELECT *, 
         (CAST(messages_failed AS REAL) / NULLIF(messages_sent + messages_failed, 0)) * 100 as failure_rate
         FROM group_analytics 
         WHERE account_id = ? AND is_active = 1 AND messages_failed > 0
         ORDER BY failure_rate DESC, messages_failed DESC
         LIMIT ?`,
        [accountId, limit]
      );
      return { success: true, groups: result.rows };
    } catch (error) {
      logger.logError('ANALYTICS', accountId, error, 'Failed to get problematic groups');
      return { success: false, error: error.message, groups: [] };
    }
  }

  /**
   * Record A/B testing analytics
   */
  async recordABAnalytics(accountId, variant, groupId, engagementScore = null) {
    try {
      await db.query(
        `INSERT INTO ab_testing_analytics (account_id, variant, group_id, engagement_score)
         VALUES ($1, $2, $3, $4)`,
        [accountId, variant, groupId, engagementScore]
      );
      return { success: true };
    } catch (error) {
      logger.logError('ANALYTICS', accountId, error, 'Failed to record A/B analytics');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get A/B testing results
   */
  async getABResults(accountId) {
    try {
      const result = await db.query(
        `SELECT 
           variant,
           COUNT(*) as total_sent,
           AVG(engagement_score) as avg_engagement,
           SUM(CASE WHEN engagement_score > 0 THEN 1 ELSE 0 END) as engaged_count
         FROM ab_testing_analytics
         WHERE account_id = $1
         GROUP BY variant`,
        [accountId]
      );
      return { success: true, results: result.rows };
    } catch (error) {
      logger.logError('ANALYTICS', accountId, error, 'Failed to get A/B results');
      return { success: false, error: error.message, results: [] };
    }
  }
}

export default new AnalyticsService();
