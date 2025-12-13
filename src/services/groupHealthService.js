/**
 * Group Health Service
 * Monitors group health and status
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';
import analyticsService from './analyticsService.js';

class GroupHealthService {
  /**
   * Get group health score
   */
  async getGroupHealth(accountId, groupId) {
    try {
      const analytics = await analyticsService.getGroupAnalytics(accountId, groupId);
      
      if (!analytics.analytics || analytics.analytics.length === 0) {
        return { success: true, health: 'unknown', score: 0 };
      }

      const group = analytics.analytics[0];
      const total = (group.messages_sent || 0) + (group.messages_failed || 0);
      const successRate = total > 0 ? (group.messages_sent / total) * 100 : 0;
      
      let health = 'good';
      let score = successRate;

      if (successRate < 50) {
        health = 'critical';
      } else if (successRate < 70) {
        health = 'poor';
      } else if (successRate < 90) {
        health = 'fair';
      }

      // Check last message sent
      if (group.last_message_sent) {
        const daysSinceLastMessage = (Date.now() - new Date(group.last_message_sent).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceLastMessage > 30) {
          score -= 20;
          if (health === 'good') health = 'fair';
        }
      }

      return {
        success: true,
        health,
        score: Math.max(0, Math.min(100, score)),
        successRate,
        lastMessageSent: group.last_message_sent,
        lastError: group.last_error
      };
    } catch (error) {
      logger.logError('HEALTH', accountId, error, 'Failed to get group health');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all groups health
   */
  async getAllGroupsHealth(accountId) {
    try {
      const analytics = await analyticsService.getGroupAnalytics(accountId);
      const healthScores = [];

      for (const group of analytics.analytics || []) {
        const health = await this.getGroupHealth(accountId, group.group_id);
        if (health.success) {
          healthScores.push({
            groupId: group.group_id,
            groupTitle: group.group_title,
            ...health
          });
        }
      }

      return { success: true, healthScores };
    } catch (error) {
      logger.logError('HEALTH', accountId, error, 'Failed to get all groups health');
      return { success: false, error: error.message, healthScores: [] };
    }
  }
}

export default new GroupHealthService();
