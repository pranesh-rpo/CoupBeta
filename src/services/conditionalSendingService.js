/**
 * Conditional Sending Service
 * If/then logic for message sending
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';
import analyticsService from './analyticsService.js';

class ConditionalSendingService {
  /**
   * Create conditional rule
   */
  async createRule(accountId, condition, action, messageText) {
    try {
      // Store in a JSON structure
      const ruleData = {
        condition,
        action,
        messageText,
        createdAt: new Date().toISOString()
      };

      await db.query(
        `INSERT INTO message_templates (account_id, template_name, template_text, variables, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (account_id, template_name) DO UPDATE
         SET template_text = EXCLUDED.template_text`,
        [accountId, `conditional_${Date.now()}`, JSON.stringify(ruleData), JSON.stringify({ type: 'conditional' })]
      );

      logger.logChange('CONDITIONAL', accountId, 'Created conditional rule');
      return { success: true };
    } catch (error) {
      logger.logError('CONDITIONAL', accountId, error, 'Failed to create conditional rule');
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if condition is met
   */
  async checkCondition(accountId, groupId, condition) {
    try {
      switch (condition.type) {
        case 'group_has_failures':
          const analytics = await analyticsService.getGroupAnalytics(accountId, groupId);
          if (analytics.analytics && analytics.analytics.length > 0) {
            const group = analytics.analytics[0];
            const failureRate = group.messages_sent + group.messages_failed > 0
              ? (group.messages_failed / (group.messages_sent + group.messages_failed)) * 100
              : 0;
            return failureRate >= (condition.threshold || 50);
          }
          return false;

        case 'group_success_rate':
          const analytics2 = await analyticsService.getGroupAnalytics(accountId, groupId);
          if (analytics2.analytics && analytics2.analytics.length > 0) {
            const group = analytics2.analytics[0];
            const successRate = group.messages_sent + group.messages_failed > 0
              ? (group.messages_sent / (group.messages_sent + group.messages_failed)) * 100
              : 0;
            return successRate >= (condition.threshold || 80);
          }
          return false;

        case 'time_of_day':
          const hour = new Date().getHours();
          return hour >= (condition.startHour || 0) && hour <= (condition.endHour || 23);

        default:
          return false;
      }
    } catch (error) {
      logger.logError('CONDITIONAL', accountId, error, 'Failed to check condition');
      return false;
    }
  }
}

export default new ConditionalSendingService();
