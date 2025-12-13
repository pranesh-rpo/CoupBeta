/**
 * Auto-Reply Service
 * Handles automatic replies to messages
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class AutoReplyService {
  /**
   * Create auto-reply rule
   */
  async createRule(accountId, triggerType, triggerValue, replyMessage) {
    try {
      const result = await db.query(
        `INSERT INTO auto_reply_rules (account_id, trigger_type, trigger_value, reply_message, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING *`,
        [accountId, triggerType, triggerValue, replyMessage]
      );
      logger.logChange('AUTO_REPLY', accountId, `Created auto-reply rule: ${triggerType}`);
      return { success: true, rule: result.rows[0] };
    } catch (error) {
      logger.logError('AUTO_REPLY', accountId, error, 'Failed to create auto-reply rule');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all rules
   */
  async getRules(accountId) {
    try {
      const result = await db.query(
        `SELECT * FROM auto_reply_rules WHERE account_id = $1 AND is_active = TRUE ORDER BY created_at DESC`,
        [accountId]
      );
      return { success: true, rules: result.rows };
    } catch (error) {
      logger.logError('AUTO_REPLY', accountId, error, 'Failed to get rules');
      return { success: false, error: error.message, rules: [] };
    }
  }

  /**
   * Check if message should trigger auto-reply
   */
  async checkAutoReply(accountId, messageText, isMention, isDM) {
    try {
      const rules = await this.getRules(accountId);
      if (!rules.success) return { shouldReply: false };

      for (const rule of rules.rules) {
        if (!rule.is_active) continue;

        switch (rule.trigger_type) {
          case 'all':
            return { shouldReply: true, replyMessage: rule.reply_message };
          
          case 'mention':
            if (isMention) {
              return { shouldReply: true, replyMessage: rule.reply_message };
            }
            break;
          
          case 'dm':
            if (isDM) {
              return { shouldReply: true, replyMessage: rule.reply_message };
            }
            break;
          
          case 'keyword':
            if (rule.trigger_value && messageText && messageText.toLowerCase().includes(rule.trigger_value.toLowerCase())) {
              return { shouldReply: true, replyMessage: rule.reply_message };
            }
            break;
        }
      }

      return { shouldReply: false };
    } catch (error) {
      logger.logError('AUTO_REPLY', accountId, error, 'Failed to check auto-reply');
      return { shouldReply: false };
    }
  }

  /**
   * Delete rule
   */
  async deleteRule(accountId, ruleId) {
    try {
      await db.query(
        `UPDATE auto_reply_rules SET is_active = FALSE WHERE id = $1 AND account_id = $2`,
        [ruleId, accountId]
      );
      logger.logChange('AUTO_REPLY', accountId, `Deleted auto-reply rule ${ruleId}`);
      return { success: true };
    } catch (error) {
      logger.logError('AUTO_REPLY', accountId, error, 'Failed to delete rule');
      return { success: false, error: error.message };
    }
  }
}

export default new AutoReplyService();
