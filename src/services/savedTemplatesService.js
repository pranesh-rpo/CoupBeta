/**
 * Saved Templates Service
 * Manages Saved Messages templates (sync, select slot, clear)
 * Following project rules: always log changes and errors
 */

import db from '../database/db.js';
import accountLinker from './accountLinker.js';
import logger from '../utils/logger.js';
import { Api } from 'telegram/tl/index.js';

class SavedTemplatesService {
  /**
   * Sync last 3 messages from Saved Messages
   * @param {number} accountId - Account ID
   * @returns {Promise<{success: boolean, synced: number, error?: string}>}
   */
  async syncSavedMessages(accountId) {
    let client = null;
    try {
      // Ensure client is connected before use
      client = await accountLinker.ensureConnected(accountId);
      if (!client) {
        return { success: false, error: 'Account client not available' };
      }
      
      console.log(`[SAVED_TEMPLATES] Connected client for account ${accountId} to sync saved messages`);
      
      // Get Saved Messages entity - it's the "me" user
      let savedMessagesEntity;
      try {
        const me = await client.getMe();
        savedMessagesEntity = await client.getEntity(me);
      } catch (error) {
        // Try alternative: get from dialogs
        const dialogs = await client.getDialogs();
        const savedDialog = dialogs.find(d => d.isUser && d.name === 'Saved Messages');
        if (savedDialog) {
          savedMessagesEntity = savedDialog.entity;
        } else {
          return { success: false, error: 'Saved Messages not found' };
        }
      }

      // Get last 3 messages from Saved Messages
      const messages = await client.getMessages(savedMessagesEntity, {
        limit: 3,
      });

      if (!messages || messages.length === 0) {
        return { success: false, error: 'No messages found in Saved Messages' };
      }

      let synced = 0;
      
      // Save messages to slots (slot 1 = most recent, slot 2 = second, slot 3 = third)
      for (let i = 0; i < Math.min(messages.length, 3); i++) {
        const message = messages[i];
        const slot = i + 1;
        
        const messageText = message.text || '';
        const messageId = message.id;
        
        // Serialize entities (for premium emoji support)
        let messageEntities = null;
        if (message.entities && message.entities.length > 0) {
          messageEntities = JSON.stringify(message.entities.map(e => ({
            _: e.className,
            offset: e.offset,
            length: e.length,
            language: e.language,
            url: e.url,
            userId: e.userId,
            // Add other entity properties as needed
          })));
        }

        await db.query(
          `INSERT INTO saved_templates (account_id, slot, message_text, message_entities, message_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
           ON CONFLICT (account_id, slot) 
           DO UPDATE SET 
             message_text = $3,
             message_entities = $4,
             message_id = $5,
             updated_at = CURRENT_TIMESTAMP`,
          [accountId, slot, messageText, messageEntities, messageId]
        );
        
        synced++;
        logger.logChange('SAVED_TEMPLATES', accountId, `Synced message to slot ${slot}`);
      }

      logger.logSuccess('SAVED_TEMPLATES', accountId, `Synced ${synced} messages from Saved Messages`);
      return { success: true, synced };
    } catch (error) {
      logger.logError('SAVED_TEMPLATES', accountId, error, 'Failed to sync Saved Messages');
      return { success: false, error: error.message };
    } finally {
      // Disconnect client after operation
      if (client && client.connected) {
        try {
          await client.disconnect();
          console.log(`[SAVED_TEMPLATES] Disconnected client for account ${accountId} after sync`);
        } catch (disconnectError) {
          logger.logError('SAVED_TEMPLATES', accountId, disconnectError, 'Failed to disconnect client after sync');
        }
      }
    }
  }

  /**
   * Get saved templates for an account
   * @param {number} accountId - Account ID
   * @returns {Promise<Array>}
   */
  async getSavedTemplates(accountId) {
    try {
      const result = await db.query(
        `SELECT slot, message_text, message_entities, message_id, updated_at
         FROM saved_templates
         WHERE account_id = $1
         ORDER BY slot`,
        [accountId]
      );
      
      return result.rows.map(row => ({
        slot: row.slot,
        messageText: row.message_text,
        messageEntities: row.message_entities ? JSON.parse(row.message_entities) : null,
        messageId: row.message_id,
        updatedAt: row.updated_at,
      }));
    } catch (error) {
      logger.logError('SAVED_TEMPLATES', accountId, error, 'Failed to get saved templates');
      return [];
    }
  }

  /**
   * Get saved template for a specific slot
   * @param {number} accountId - Account ID
   * @param {number} slot - Slot number (1, 2, or 3)
   * @returns {Promise<Object|null>}
   */
  async getSavedTemplate(accountId, slot) {
    try {
      const result = await db.query(
        `SELECT slot, message_text, message_entities, message_id, updated_at
         FROM saved_templates
         WHERE account_id = $1 AND slot = $2`,
        [accountId, slot]
      );
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const row = result.rows[0];
      return {
        slot: row.slot,
        messageText: row.message_text,
        messageEntities: row.message_entities ? JSON.parse(row.message_entities) : null,
        messageId: row.message_id,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      logger.logError('SAVED_TEMPLATES', accountId, error, `Failed to get saved template slot ${slot}`);
      return null;
    }
  }

  /**
   * Clear a saved template slot
   * @param {number} accountId - Account ID
   * @param {number} slot - Slot number (1, 2, or 3)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async clearSlot(accountId, slot) {
    try {
      if (![1, 2, 3].includes(slot)) {
        return { success: false, error: 'Invalid slot number' };
      }

      await db.query(
        'DELETE FROM saved_templates WHERE account_id = $1 AND slot = $2',
        [accountId, slot]
      );

      logger.logChange('SAVED_TEMPLATES', accountId, `Cleared slot ${slot}`);
      return { success: true };
    } catch (error) {
      logger.logError('SAVED_TEMPLATES', accountId, error, `Failed to clear slot ${slot}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get message from saved template (for forwarding with entities)
   * @param {number} accountId - Account ID
   * @param {number} slot - Slot number
   * @returns {Promise<{messageId: number, entities: Array|null}|null>}
   */
  async getTemplateForForward(accountId, slot) {
    try {
      const template = await this.getSavedTemplate(accountId, slot);
      if (!template || !template.messageId) {
        return null;
      }

      return {
        messageId: template.messageId,
        entities: template.messageEntities,
      };
    } catch (error) {
      logger.logError('SAVED_TEMPLATES', accountId, error, `Failed to get template for forward slot ${slot}`);
      return null;
    }
  }
}

export default new SavedTemplatesService();
