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
   * @param {Array|null} messageEntities - Message entities (for premium emoji support)
   */
  async saveMessage(accountId, messageText, variant = 'A', messageEntities = null) {
    try {
      if (!['A', 'B'].includes(variant)) {
        return { success: false, error: 'Invalid variant. Must be A or B' };
      }

      // Serialize entities if provided
      let entitiesJson = null;
      if (messageEntities && messageEntities.length > 0) {
        entitiesJson = JSON.stringify(messageEntities.map(e => ({
          type: e.type,
          offset: e.offset,
          length: e.length,
          language: e.language,
          url: e.url,
          user: e.user,
          custom_emoji_id: e.custom_emoji_id, // For premium emojis
        })));
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
        `INSERT INTO messages (account_id, message_text, message_entities, variant, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [accountId, messageText, entitiesJson, variant]
      );

      logger.logChange('MESSAGE', accountId, `Message variant ${variant} saved`);
      return { success: true };
    } catch (error) {
      logger.logError('MESSAGE', accountId, error, `Failed to save message variant ${variant}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get active message for an account (legacy support - uses message pool or first message)
   * @param {number} accountId - Account ID
   * @returns {Promise<{text: string, entities: Array|null}|null>}
   */
  async getActiveMessage(accountId) {
    try {
      const query = `SELECT message_text, message_entities FROM messages 
                     WHERE account_id = $1 AND is_active = TRUE 
                     ORDER BY updated_at DESC LIMIT 1`;
      const result = await db.query(query, [accountId]);
      
      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        text: row.message_text,
        entities: row.message_entities ? JSON.parse(row.message_entities) : null
      };
    } catch (error) {
      logger.logError('MESSAGE', accountId, error, 'Failed to get active message');
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

  // ==================== MESSAGE POOL METHODS ====================

  /**
   * Add message to pool
   * @param {number} accountId - Account ID
   * @param {string} messageText - Message text
   * @param {Array|null} messageEntities - Message entities
   * @returns {Promise<{success: boolean, messageId?: number, error?: string}>}
   */
  async addToMessagePool(accountId, messageText, messageEntities = null) {
    try {
      // Serialize entities if provided
      let entitiesJson = null;
      if (messageEntities && messageEntities.length > 0) {
        entitiesJson = JSON.stringify(messageEntities.map(e => ({
          type: e.type,
          offset: e.offset,
          length: e.length,
          language: e.language,
          url: e.url,
          user: e.user,
          custom_emoji_id: e.custom_emoji_id,
        })));
      }

      // Get max display_order to append at end
      const maxOrderResult = await db.query(
        `SELECT COALESCE(MAX(display_order), -1) as max_order FROM message_pool WHERE account_id = $1`,
        [accountId]
      );
      const nextOrder = (maxOrderResult.rows[0]?.max_order || -1) + 1;

      const result = await db.query(
        `INSERT INTO message_pool (account_id, message_text, message_entities, display_order, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id`,
        [accountId, messageText, entitiesJson, nextOrder]
      );

      logger.logChange('MESSAGE_POOL', accountId, `Message added to pool (ID: ${result.rows[0].id})`);
      return { success: true, messageId: result.rows[0].id };
    } catch (error) {
      logger.logError('MESSAGE_POOL', accountId, error, 'Failed to add message to pool');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all messages from pool
   * @param {number} accountId - Account ID
   * @returns {Promise<Array<{id: number, text: string, entities: Array|null, display_order: number}>>}
   */
  async getMessagePool(accountId) {
    try {
      const result = await db.query(
        `SELECT id, message_text, message_entities, display_order FROM message_pool 
         WHERE account_id = $1 AND is_active = TRUE 
         ORDER BY display_order ASC, created_at ASC`,
        [accountId]
      );

      return result.rows.map(row => ({
        id: row.id,
        text: row.message_text,
        entities: row.message_entities ? JSON.parse(row.message_entities) : null,
        display_order: row.display_order
      }));
    } catch (error) {
      logger.logError('MESSAGE_POOL', accountId, error, 'Failed to get message pool');
      return [];
    }
  }

  /**
   * Get a random message from pool
   * @param {number} accountId - Account ID
   * @returns {Promise<{text: string, entities: Array|null}|null>}
   */
  async getRandomFromPool(accountId) {
    try {
      const pool = await this.getMessagePool(accountId);
      if (pool.length === 0) {
        return null;
      }
      const randomIndex = Math.floor(Math.random() * pool.length);
      return {
        text: pool[randomIndex].text,
        entities: pool[randomIndex].entities
      };
    } catch (error) {
      logger.logError('MESSAGE_POOL', accountId, error, 'Failed to get random message from pool');
      return null;
    }
  }

  /**
   * Get next message from pool (for rotation mode)
   * @param {number} accountId - Account ID
   * @param {number} lastIndex - Last used index
   * @returns {Promise<{text: string, entities: Array|null, nextIndex: number}|null>}
   */
  async getNextFromPool(accountId, lastIndex = 0) {
    try {
      const pool = await this.getMessagePool(accountId);
      if (pool.length === 0) {
        return null;
      }
      const nextIndex = (lastIndex + 1) % pool.length;
      return {
        text: pool[nextIndex].text,
        entities: pool[nextIndex].entities,
        nextIndex: nextIndex
      };
    } catch (error) {
      logger.logError('MESSAGE_POOL', accountId, error, 'Failed to get next message from pool');
      return null;
    }
  }

  /**
   * Get message by index from pool (for sequential mode - one message per group)
   * @param {number} accountId - Account ID
   * @param {number} index - Message index
   * @returns {Promise<{text: string, entities: Array|null}|null>}
   */
  async getMessageByIndex(accountId, index) {
    try {
      const pool = await this.getMessagePool(accountId);
      if (pool.length === 0) {
        return null;
      }
      const actualIndex = index % pool.length;
      return {
        text: pool[actualIndex].text,
        entities: pool[actualIndex].entities
      };
    } catch (error) {
      logger.logError('MESSAGE_POOL', accountId, error, 'Failed to get message by index from pool');
      return null;
    }
  }

  /**
   * Update message order in pool
   * @param {number} accountId - Account ID
   * @param {number} messageId - Message ID
   * @param {number} newOrder - New display order
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async updateMessageOrder(accountId, messageId, newOrder) {
    try {
      await db.query(
        `UPDATE message_pool SET display_order = $1 WHERE account_id = $2 AND id = $3`,
        [newOrder, accountId, messageId]
      );
      logger.logChange('MESSAGE_POOL', accountId, `Message ${messageId} order updated to ${newOrder}`);
      return { success: true };
    } catch (error) {
      logger.logError('MESSAGE_POOL', accountId, error, `Failed to update message order`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete message from pool
   * @param {number} accountId - Account ID
   * @param {number} messageId - Message ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteFromMessagePool(accountId, messageId) {
    try {
      await db.query(
        `UPDATE message_pool SET is_active = FALSE WHERE account_id = $1 AND id = $2`,
        [accountId, messageId]
      );
      logger.logChange('MESSAGE_POOL', accountId, `Message ${messageId} removed from pool`);
      return { success: true };
    } catch (error) {
      logger.logError('MESSAGE_POOL', accountId, error, `Failed to delete message ${messageId} from pool`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if message pool has messages
   * @param {number} accountId - Account ID
   * @returns {Promise<boolean>}
   */
  async hasMessagePool(accountId) {
    try {
      const result = await db.query(
        `SELECT COUNT(*) as count FROM message_pool 
         WHERE account_id = $1 AND is_active = TRUE`,
        [accountId]
      );
      return parseInt(result.rows[0].count) > 0;
    } catch (error) {
      logger.logError('MESSAGE_POOL', accountId, error, 'Failed to check message pool');
      return false;
    }
  }
}

export default new MessageService();
