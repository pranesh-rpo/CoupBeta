/**
 * Message Service
 * Manages broadcast messages with A/B testing support
 * Following project rules: always log changes and errors
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class MessageService {
  /**
   * Save message for an account (supports A/B variants)
   * @param {number} accountId - Account ID
   * @param {string} messageText - Message text
   * @param {string} variant - 'A' or 'B' (default: 'A')
   */
  async saveMessage(accountId, messageText, variant = 'A') {
    try {
      if (!['A', 'B'].includes(variant)) {
        return { success: false, error: 'Invalid variant. Must be A or B' };
      }

      // Deactivate existing messages for this variant
      await db.query(
        `UPDATE messages 
         SET is_active = FALSE 
         WHERE account_id = $1 AND variant = $2`,
        [accountId, variant]
      );

      // Insert new active message
      await db.query(
        `INSERT INTO messages (account_id, message_text, variant, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [accountId, messageText, variant]
      );

      logger.logChange('MESSAGE', accountId, `Message variant ${variant} saved`);
      return { success: true };
    } catch (error) {
      logger.logError('MESSAGE', accountId, error, `Failed to save message variant ${variant}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get active message for an account
   * @param {number} accountId - Account ID
   * @param {string} variant - 'A' or 'B' (optional, returns first active if not specified)
   * @returns {Promise<string|null>}
   */
  async getActiveMessage(accountId, variant = null) {
    try {
      let query;
      let params;

      if (variant) {
        query = `SELECT message_text FROM messages 
                 WHERE account_id = $1 AND variant = $2 AND is_active = TRUE 
                 ORDER BY updated_at DESC LIMIT 1`;
        params = [accountId, variant];
      } else {
        query = `SELECT message_text FROM messages 
                 WHERE account_id = $1 AND is_active = TRUE 
                 ORDER BY updated_at DESC LIMIT 1`;
        params = [accountId];
      }

      const result = await db.query(query, params);
      return result.rows.length > 0 ? result.rows[0].message_text : null;
    } catch (error) {
      logger.logError('MESSAGE', accountId, error, 'Failed to get active message');
      return null;
    }
  }

  /**
   * Get both A and B messages for an account
   * @param {number} accountId - Account ID
   * @returns {Promise<{messageA: string|null, messageB: string|null}>}
   */
  async getABMessages(accountId) {
    try {
      const result = await db.query(
        `SELECT variant, message_text FROM messages 
         WHERE account_id = $1 AND is_active = TRUE 
         ORDER BY variant, updated_at DESC`,
        [accountId]
      );

      let messageA = null;
      let messageB = null;

      for (const row of result.rows) {
        if (row.variant === 'A' && !messageA) {
          messageA = row.message_text;
        } else if (row.variant === 'B' && !messageB) {
          messageB = row.message_text;
        }
      }

      return { messageA, messageB };
    } catch (error) {
      logger.logError('MESSAGE', accountId, error, 'Failed to get A/B messages');
      return { messageA: null, messageB: null };
    }
  }

  /**
   * Select message variant based on A/B mode and saved template slot
   * @param {number} accountId - Account ID
   * @param {boolean} abMode - A/B testing enabled
   * @param {string} abModeType - 'single', 'rotate', or 'split'
   * @param {string} abLastVariant - Last used variant (for rotate mode)
   * @param {number|null} savedTemplateSlot - Saved template slot (1, 2, 3, or null)
   * @returns {Promise<string|null>}
   */
  async selectMessageVariant(accountId, abMode, abModeType, abLastVariant, savedTemplateSlot = null) {
    try {
      // If saved template slot is set, use that (handled by automationService)
      // This function handles A/B variant selection only
      if (!abMode) {
        // Not using A/B testing, return any active message
        return await this.getActiveMessage(accountId);
      }

      const { messageA, messageB } = await this.getABMessages(accountId);

      if (!messageA && !messageB) {
        return null;
      }

      if (!messageA) {
        return messageB; // Only B exists
      }
      if (!messageB) {
        return messageA; // Only A exists
      }

      // Both exist, select based on mode
      switch (abModeType) {
        case 'single':
          return messageA; // Always use A
        case 'rotate':
          // Alternate between A and B
          const nextVariant = abLastVariant === 'A' ? 'B' : 'A';
          return nextVariant === 'A' ? messageA : messageB;
        case 'split':
          // Random 50/50 split
          return Math.random() < 0.5 ? messageA : messageB;
        default:
          return messageA;
      }
    } catch (error) {
      logger.logError('MESSAGE', accountId, error, 'Failed to select message variant');
      return null;
    }
  }

  /**
   * Check if account has messages set
   * @param {number} accountId - Account ID
   * @returns {Promise<boolean>}
   */
  async hasMessages(accountId) {
    try {
      const result = await db.query(
        `SELECT COUNT(*) as count FROM messages 
         WHERE account_id = $1 AND is_active = TRUE`,
        [accountId]
      );
      return parseInt(result.rows[0].count) > 0;
    } catch (error) {
      logger.logError('MESSAGE', accountId, error, 'Failed to check if messages exist');
      return false;
    }
  }
}

export default new MessageService();
