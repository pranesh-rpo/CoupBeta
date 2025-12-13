/**
 * Message Rotation Service
 * Rotates through multiple messages
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class MessageRotationService {
  /**
   * Create rotation pool
   */
  async createRotationPool(accountId, poolName, messages) {
    try {
      // Store rotation pool in a JSON structure
      const poolData = {
        poolName,
        messages: messages.map((msg, idx) => ({
          id: idx + 1,
          text: msg,
          sentCount: 0
        })),
        currentIndex: 0,
        createdAt: new Date().toISOString()
      };

      // Store in a settings table or create rotation_pools table
      await db.query(
        `INSERT INTO message_templates (account_id, template_name, template_text, variables, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (account_id, template_name) DO UPDATE
         SET template_text = EXCLUDED.template_text,
             variables = EXCLUDED.variables`,
        [accountId, `rotation_${poolName}`, JSON.stringify(poolData), JSON.stringify({ type: 'rotation' })]
      );

      logger.logChange('ROTATION', accountId, `Created rotation pool: ${poolName}`);
      return { success: true };
    } catch (error) {
      logger.logError('ROTATION', accountId, error, 'Failed to create rotation pool');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get next message from rotation
   */
  async getNextMessage(accountId, poolName) {
    try {
      const result = await db.query(
        `SELECT template_text, variables FROM message_templates 
         WHERE account_id = $1 AND template_name = $2 AND is_active = TRUE`,
        [accountId, `rotation_${poolName}`]
      );

      if (result.rows.length === 0) {
        return { success: false, error: 'Rotation pool not found' };
      }

      const poolData = JSON.parse(result.rows[0].template_text);
      const currentIndex = poolData.currentIndex || 0;
      const message = poolData.messages[currentIndex];

      // Update index for next time
      const nextIndex = (currentIndex + 1) % poolData.messages.length;
      poolData.currentIndex = nextIndex;
      message.sentCount = (message.sentCount || 0) + 1;

      // Update in database
      await db.query(
        `UPDATE message_templates SET template_text = $1 
         WHERE account_id = $2 AND template_name = $3`,
        [JSON.stringify(poolData), accountId, `rotation_${poolName}`]
      );

      return { success: true, message: message.text, nextIndex };
    } catch (error) {
      logger.logError('ROTATION', accountId, error, 'Failed to get next message');
      return { success: false, error: error.message };
    }
  }
}

export default new MessageRotationService();
