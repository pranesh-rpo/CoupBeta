/**
 * Content Moderation Service
 * Handles content moderation rules
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class ModerationService {
  /**
   * Create moderation rule
   */
  async createRule(accountId, ruleType, ruleValue, action) {
    try {
      const result = await db.query(
        `INSERT INTO moderation_rules (account_id, rule_type, rule_value, action, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING *`,
        [accountId, ruleType, ruleValue, action]
      );
      logger.logChange('MODERATION', accountId, `Created moderation rule: ${ruleType}`);
      return { success: true, rule: result.rows[0] };
    } catch (error) {
      logger.logError('MODERATION', accountId, error, 'Failed to create moderation rule');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all rules
   */
  async getRules(accountId) {
    try {
      const result = await db.query(
        `SELECT * FROM moderation_rules WHERE account_id = $1 AND is_active = TRUE ORDER BY created_at DESC`,
        [accountId]
      );
      return { success: true, rules: result.rows };
    } catch (error) {
      logger.logError('MODERATION', accountId, error, 'Failed to get rules');
      return { success: false, error: error.message, rules: [] };
    }
  }

  /**
   * Check if content should be moderated
   */
  async checkModeration(accountId, messageText, userId = null) {
    try {
      const rules = await this.getRules(accountId);
      if (!rules.success) return { shouldModerate: false };

      for (const rule of rules.rules) {
        if (!rule.is_active) continue;

        switch (rule.rule_type) {
          case 'keyword':
            if (rule.rule_value && messageText && messageText.toLowerCase().includes(rule.rule_value.toLowerCase())) {
              return { shouldModerate: true, action: rule.action, rule };
            }
            break;
          
          case 'user':
            if (rule.rule_value && userId && String(userId) === String(rule.rule_value)) {
              return { shouldModerate: true, action: rule.action, rule };
            }
            break;
          
          case 'spam':
            // Basic spam detection (can be enhanced)
            if (messageText && this.detectSpam(messageText)) {
              return { shouldModerate: true, action: rule.action, rule };
            }
            break;
        }
      }

      return { shouldModerate: false };
    } catch (error) {
      logger.logError('MODERATION', accountId, error, 'Failed to check moderation');
      return { shouldModerate: false };
    }
  }

  /**
   * Basic spam detection
   */
  detectSpam(messageText) {
    if (!messageText) return false;
    
    const spamIndicators = [
      /(.)\1{4,}/, // Repeated characters (aaaaa)
      /[A-Z]{10,}/, // All caps
      /http[s]?:\/\/[^\s]{20,}/, // Long URLs
    ];
    
    return spamIndicators.some(pattern => pattern.test(messageText));
  }

  /**
   * Delete rule
   */
  async deleteRule(accountId, ruleId) {
    try {
      await db.query(
        `UPDATE moderation_rules SET is_active = FALSE WHERE id = $1 AND account_id = $2`,
        [ruleId, accountId]
      );
      logger.logChange('MODERATION', accountId, `Deleted moderation rule ${ruleId}`);
      return { success: true };
    } catch (error) {
      logger.logError('MODERATION', accountId, error, 'Failed to delete rule');
      return { success: false, error: error.message };
    }
  }
}

export default new ModerationService();
