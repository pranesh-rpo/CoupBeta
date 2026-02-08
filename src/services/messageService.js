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
      // IMPORTANT: Preserve custom_emoji_id as string to maintain precision
      let entitiesJson = null;
      
      if (messageEntities && messageEntities.length > 0) {
        const mappedEntities = messageEntities.map(e => {
          const entity = {
            type: e.type,
            offset: e.offset,
            length: e.length,
            language: e.language,
            url: e.url,
            user: e.user,
          };
          
          // Preserve custom_emoji_id as string to avoid precision loss
          if (e.custom_emoji_id !== undefined && e.custom_emoji_id !== null) {
            entity.custom_emoji_id = String(e.custom_emoji_id); // Always store as string
          }
          
          return entity;
        });
        
        entitiesJson = JSON.stringify(mappedEntities);
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
      const query = `SELECT message_text, message_entities, saved_message_id FROM messages 
                     WHERE account_id = $1 AND is_active = TRUE 
                     ORDER BY updated_at DESC LIMIT 1`;
      const result = await db.query(query, [accountId]);
      
      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      
      const entities = row.message_entities ? JSON.parse(row.message_entities) : null;
      
      // Log entity information for debugging
      if (entities && entities.length > 0) {
        const premiumEmojis = entities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
        if (premiumEmojis.length > 0) {
          console.log(`[MESSAGE_SERVICE] Retrieved message with ${premiumEmojis.length} premium emoji entities for account ${accountId}`);
          console.log(`[MESSAGE_SERVICE] Premium emoji IDs: ${premiumEmojis.map(e => e.custom_emoji_id).join(', ')}`);
          if (row.saved_message_id) {
            console.log(`[MESSAGE_SERVICE] ✅ Found saved_message_id: ${row.saved_message_id} - can forward from Saved Messages to preserve emojis`);
          } else {
            console.log(`[MESSAGE_SERVICE] ⚠️ No saved_message_id - emojis may not work (account needs to receive emoji first)`);
          }
        }
      }
      
      return {
        text: row.message_text,
        entities: entities,
        saved_message_id: row.saved_message_id || null
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
      return parseInt(result.rows[0]?.count) > 0;
    } catch (error) {
      logger.logError('MESSAGE', accountId, error, 'Failed to check if messages exist');
      return false;
    }
  }

  /**
   * Select message variant based on A/B testing settings
   * @param {number} accountId - Account ID
   * @param {boolean} abMode - Whether A/B testing is enabled
   * @param {string} abModeType - 'single', 'rotate', or 'split'
   * @param {string} abLastVariant - Last used variant ('A' or 'B')
   * @returns {Promise<{text: string, entities: Array|null, saved_message_id: number|null}|null>}
   */
  async selectMessageVariant(accountId, abMode = false, abModeType = 'single', abLastVariant = 'A') {
    try {
      let variant = 'A'; // Default to variant A
      
      if (abMode) {
        if (abModeType === 'single') {
          // Single mode: always use variant A
          variant = 'A';
        } else if (abModeType === 'rotate') {
          // Rotate mode: alternate between A and B (lastVariant is updated by caller)
          variant = abLastVariant;
        } else if (abModeType === 'split') {
          // Split mode: random 50/50 split
          variant = Math.random() < 0.5 ? 'A' : 'B';
        }
      }
      
      // Get message for selected variant
      const query = `SELECT message_text, message_entities, saved_message_id FROM messages 
                     WHERE account_id = $1 AND variant = $2 AND is_active = TRUE 
                     ORDER BY updated_at DESC LIMIT 1`;
      const result = await db.query(query, [accountId, variant]);
      
      if (result.rows.length === 0) {
        // Fallback to variant A if selected variant doesn't exist
        if (variant !== 'A') {
          const fallbackResult = await db.query(
            `SELECT message_text, message_entities, saved_message_id FROM messages 
             WHERE account_id = $1 AND variant = 'A' AND is_active = TRUE 
             ORDER BY updated_at DESC LIMIT 1`,
            [accountId]
          );
          if (fallbackResult.rows.length > 0) {
            const row = fallbackResult.rows[0];
            const entities = row.message_entities ? JSON.parse(row.message_entities) : null;
            return {
              text: row.message_text,
              entities: entities,
              saved_message_id: row.saved_message_id || null
            };
          }
        }
        return null;
      }

      const row = result.rows[0];
      const entities = row.message_entities ? JSON.parse(row.message_entities) : null;
      
      // Log entity information for debugging
      if (entities && entities.length > 0) {
        const premiumEmojis = entities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
        if (premiumEmojis.length > 0) {
          console.log(`[MESSAGE_SERVICE] Selected variant ${variant} with ${premiumEmojis.length} premium emoji entities for account ${accountId}`);
        }
      }
      
      return {
        text: row.message_text,
        entities: entities,
        saved_message_id: row.saved_message_id || null
      };
    } catch (error) {
      logger.logError('MESSAGE', accountId, error, 'Failed to select message variant');
      return null;
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
      // Check for duplicate message (same text)
      const duplicateCheck = await db.query(
        `SELECT id FROM message_pool 
         WHERE account_id = $1 AND message_text = $2 AND is_active = 1
         LIMIT 1`,
        [accountId, messageText]
      );

      if (duplicateCheck.rows.length > 0) {
        console.log(`[MESSAGE_POOL] Message already exists in pool (ID: ${duplicateCheck.rows[0]?.id})`);
        return { success: false, error: 'This message is already in the pool', isDuplicate: true };
      }

      // Serialize entities if provided
      // IMPORTANT: Preserve custom_emoji_id as string to maintain precision
      let entitiesJson = null;
      if (messageEntities && messageEntities.length > 0) {
        const mappedEntities = messageEntities.map(e => {
          const entity = {
            type: e.type,
            offset: e.offset,
            length: e.length,
            language: e.language,
            url: e.url,
            user: e.user,
          };
          
          // Preserve custom_emoji_id as string to avoid precision loss
          if (e.custom_emoji_id !== undefined && e.custom_emoji_id !== null) {
            entity.custom_emoji_id = String(e.custom_emoji_id); // Always store as string
          }
          
          return entity;
        });
        
        entitiesJson = JSON.stringify(mappedEntities);
        
        // Log premium emoji preservation
        const premiumEmojis = mappedEntities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
        if (premiumEmojis.length > 0) {
          console.log(`[MESSAGE_POOL] ✅ Preserving ${premiumEmojis.length} premium emoji entities with IDs: ${premiumEmojis.map(e => e.custom_emoji_id).join(', ')}`);
        }
      }

      // Get max display_order to append at end
      const maxOrderResult = await db.query(
        `SELECT COALESCE(MAX(display_order), -1) as max_order FROM message_pool WHERE account_id = $1`,
        [accountId]
      );
      const nextOrder = (maxOrderResult.rows[0]?.max_order || -1) + 1;

      const result = await db.query(
        `INSERT INTO message_pool (account_id, message_text, message_entities, display_order, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id`,
        [accountId, messageText, entitiesJson, nextOrder]
      );

      logger.logChange('MESSAGE_POOL', accountId, `Message added to pool (ID: ${result.rows[0]?.id})`);
      return { success: true, messageId: result.rows[0]?.id };
    } catch (error) {
      logger.logError('MESSAGE_POOL', accountId, error, 'Failed to add message to pool');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all messages from pool
   * @param {number} accountId - Account ID
   * @param {boolean} includeInactive - Whether to include inactive messages (default: false)
   * @returns {Promise<Array<{id: number, text: string, entities: Array|null, display_order: number, is_active: boolean}>>}
   */
  async getMessagePool(accountId, includeInactive = false) {
    try {
      let query;
      let params;
      
      if (includeInactive) {
        query = `SELECT id, message_text, message_entities, display_order, is_active FROM message_pool 
                 WHERE account_id = $1 
                 ORDER BY display_order ASC, created_at ASC`;
        params = [accountId];
      } else {
        // Use is_active = 1 (SQLite stores booleans as integers)
        query = `SELECT id, message_text, message_entities, display_order, is_active FROM message_pool 
                 WHERE account_id = $1 AND is_active = 1 
                 ORDER BY display_order ASC, created_at ASC`;
        params = [accountId];
      }

      const result = await db.query(query, params);
      
      console.log(`[MESSAGE_POOL] getMessagePool(${accountId}, includeInactive=${includeInactive}) returned ${result.rows.length} messages`);

      return result.rows.map(row => {
        const entities = row.message_entities ? JSON.parse(row.message_entities) : null;
        
        // Log premium emoji preservation after retrieval
        if (entities && entities.length > 0) {
          const premiumEmojis = entities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
          if (premiumEmojis.length > 0) {
            console.log(`[MESSAGE_POOL] ✅ Retrieved message ${row.id} with ${premiumEmojis.length} premium emoji entities: ${premiumEmojis.map(e => e.custom_emoji_id).join(', ')}`);
          }
        }
        
        // Check both 1 (integer) and true (boolean) for compatibility
        const isActive = row.is_active === 1 || row.is_active === true;
        
        return {
          id: row.id,
          text: row.message_text,
          entities: entities,
          display_order: row.display_order,
          is_active: isActive
        };
      });
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
      const pool = await this.getMessagePool(accountId, false); // Only get active messages
      if (pool.length === 0) {
        return null;
      }
      const randomIndex = Math.floor(Math.random() * pool.length);
      const selected = {
        text: pool[randomIndex].text,
        entities: pool[randomIndex].entities
      };
      
      // Log entity preservation
      if (selected.entities && selected.entities.length > 0) {
        const premiumEmojis = selected.entities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
        if (premiumEmojis.length > 0) {
          console.log(`[MESSAGE_POOL] ✅ Random message selected with ${premiumEmojis.length} premium emoji entities: ${premiumEmojis.map(e => e.custom_emoji_id).join(', ')}`);
        }
      }
      
      return selected;
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
      const pool = await this.getMessagePool(accountId, false); // Only get active messages
      if (pool.length === 0) {
        return null;
      }
      const nextIndex = (lastIndex + 1) % pool.length;
      const selected = {
        text: pool[nextIndex].text,
        entities: pool[nextIndex].entities,
        nextIndex: nextIndex
      };
      
      // Log entity preservation
      if (selected.entities && selected.entities.length > 0) {
        const premiumEmojis = selected.entities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
        if (premiumEmojis.length > 0) {
          console.log(`[MESSAGE_POOL] ✅ Next message (index ${nextIndex}) selected with ${premiumEmojis.length} premium emoji entities: ${premiumEmojis.map(e => e.custom_emoji_id).join(', ')}`);
        }
      }
      
      return selected;
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
      const pool = await this.getMessagePool(accountId, false); // Only get active messages
      if (pool.length === 0) {
        return null;
      }
      const actualIndex = index % pool.length;
      const selected = {
        text: pool[actualIndex].text,
        entities: pool[actualIndex].entities
      };
      
      // Log entity preservation
      if (selected.entities && selected.entities.length > 0) {
        const premiumEmojis = selected.entities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
        if (premiumEmojis.length > 0) {
          console.log(`[MESSAGE_POOL] ✅ Message at index ${actualIndex} selected with ${premiumEmojis.length} premium emoji entities: ${premiumEmojis.map(e => e.custom_emoji_id).join(', ')}`);
        }
      }
      
      return selected;
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
        `DELETE FROM message_pool WHERE account_id = $1 AND id = $2`,
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
   * Toggle active status of a message in pool
   * @param {number} accountId - Account ID
   * @param {number} messageId - Message ID
   * @returns {Promise<{success: boolean, isActive?: boolean, error?: string}>}
   */
  async toggleMessagePoolActive(accountId, messageId) {
    try {
      // First get current status
      const currentResult = await db.query(
        `SELECT is_active FROM message_pool WHERE account_id = $1 AND id = $2`,
        [accountId, messageId]
      );

      if (currentResult.rows.length === 0) {
        return { success: false, error: 'Message not found' };
      }

      const currentActive = currentResult.rows[0]?.is_active === 1;
      const newActive = !currentActive;

      await db.query(
        `UPDATE message_pool SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE account_id = $2 AND id = $3`,
        [newActive ? 1 : 0, accountId, messageId]
      );

      logger.logChange('MESSAGE_POOL', accountId, `Message ${messageId} ${newActive ? 'enabled' : 'disabled'}`);
      return { success: true, isActive: newActive };
    } catch (error) {
      logger.logError('MESSAGE_POOL', accountId, error, `Failed to toggle message ${messageId} active status`);
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
         WHERE account_id = $1 AND is_active = 1`,
        [accountId]
      );
      return parseInt(result.rows[0]?.count) > 0;
    } catch (error) {
      logger.logError('MESSAGE_POOL', accountId, error, 'Failed to check message pool');
      return false;
    }
  }
  /**
   * Forward message to account's Saved Messages (to ensure account receives premium emoji documents)
   * @param {number} accountId - Account ID
   * @param {number} botUserId - Bot user ID (to forward from)
   * @param {number} originalMessageId - Original message ID from Bot API
   * @param {number} originalChatId - Original chat ID from Bot API
   * @returns {Promise<{success: boolean, messageId?: number, error?: string}>}
   */
  async forwardMessageToSavedMessages(accountId, botUserId, originalMessageId, originalChatId) {
    try {
      const accountLinker = (await import('./accountLinker.js')).default;
      const { Api } = await import('telegram/tl/index.js');
      
      // Get client for the account
      const client = await accountLinker.ensureConnected(accountId);
      if (!client) {
        throw new Error('Account client not available');
      }
      
      // Get account's user ID
      const me = await client.getMe();
      const accountUserId = me.id;
      
      // First, forward the message from bot to account (as DM) - this gives account access to emoji documents
      // We need to use Bot API for this, but we don't have bot instance here
      // So we'll use MTProto to get the message from the bot and forward it
      
      // Get Saved Messages entity
      let savedMessagesEntity;
      try {
        savedMessagesEntity = await client.getEntity(me);
      } catch (error) {
        // Try alternative: get from dialogs
        const dialogs = await client.getDialogs();
        const savedDialog = dialogs.find(d => d.isUser && d.name === 'Saved Messages');
        if (savedDialog) {
          savedMessagesEntity = savedDialog.entity;
        } else {
          throw new Error('Saved Messages not found');
        }
      }
      
      // Get the bot entity
      let botEntity;
      try {
        // Try to get bot entity by user ID
        botEntity = await client.getEntity(await client.getInputEntity(botUserId));
      } catch (error) {
        console.log(`[FORWARD_TO_SAVED] Could not get bot entity: ${error?.message}`);
        // Fallback: try to find bot in dialogs
        const dialogs = await client.getDialogs();
        // This is complex, so we'll use a different approach
        throw new Error('Could not get bot entity for forwarding');
      }
      
      // Check if there's an old message in Saved Messages to delete
      try {
        const oldMessageQuery = await db.query(
          `SELECT saved_message_id FROM messages 
           WHERE account_id = $1 AND saved_message_id IS NOT NULL 
           ORDER BY updated_at DESC LIMIT 1`,
          [accountId]
        );
        
        if (oldMessageQuery.rows.length > 0 && oldMessageQuery.rows[0]?.saved_message_id) {
          const oldMessageId = oldMessageQuery.rows[0]?.saved_message_id;
          try {
            await client.deleteMessages(savedMessagesEntity, [oldMessageId], { revoke: false });
            console.log(`[FORWARD_TO_SAVED] Deleted old message (ID: ${oldMessageId}) from Saved Messages`);
            await db.query(
              `UPDATE messages SET saved_message_id = NULL WHERE account_id = $1 AND saved_message_id = $2`,
              [accountId, oldMessageId]
            );
          } catch (deleteError) {
            console.log(`[FORWARD_TO_SAVED] Could not delete old message: ${deleteError?.message}`);
          }
        }
      } catch (queryError) {
        console.log(`[FORWARD_TO_SAVED] Error checking for old message: ${queryError?.message}`);
      }
      
      // Forward the message to Saved Messages
      // First, we need to get the message from the bot
      // Since we can't easily get the bot's message via MTProto, we'll use a different approach:
      // Send the message with entities, but ensure the account has received it first
      
      // For now, we'll use the original sendMessage approach but with better error handling
      throw new Error('Forwarding not yet implemented - using sendMessage fallback');
      
    } catch (error) {
      logger.logError('MESSAGE', accountId, error, 'Failed to forward message to Saved Messages');
      throw error;
    }
  }

  /**
   * Send message to account's Saved Messages (to ensure account receives premium emoji documents)
   * @param {number} accountId - Account ID
   * @param {string} messageText - Message text
   * @param {Array|null} messageEntities - Message entities (for premium emoji support)
   * @param {number} botUserId - Bot user ID (optional, for forwarding)
   * @param {number} originalMessageId - Original message ID (optional, for forwarding)
   * @param {number} originalChatId - Original chat ID (optional, for forwarding)
   * @returns {Promise<{success: boolean, messageId?: number, error?: string}>}
   */
  async sendMessageToSavedMessages(accountId, messageText, messageEntities = null, botUserId = null, originalMessageId = null, originalChatId = null) {
    try {
      const accountLinker = (await import('./accountLinker.js')).default;
      
      // Get client for the account
      const client = await accountLinker.ensureConnected(accountId);
      if (!client) {
        throw new Error('Account client not available');
      }
      
      // Get Saved Messages entity
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
          throw new Error('Saved Messages not found');
        }
      }
      
      // Check if there's an old message in Saved Messages to delete
      // Check for the most recent message with saved_message_id (even if deactivated)
      try {
        const oldMessageQuery = await db.query(
          `SELECT saved_message_id FROM messages 
           WHERE account_id = $1 AND saved_message_id IS NOT NULL 
           ORDER BY updated_at DESC LIMIT 1`,
          [accountId]
        );
        
        if (oldMessageQuery.rows.length > 0 && oldMessageQuery.rows[0]?.saved_message_id) {
          const oldMessageId = oldMessageQuery.rows[0]?.saved_message_id;
          try {
            // Delete the old message from Saved Messages
            await client.deleteMessages(savedMessagesEntity, [oldMessageId], { revoke: false });
            console.log(`[SEND_TO_SAVED] Deleted old message (ID: ${oldMessageId}) from Saved Messages`);
            
            // Clear the saved_message_id from database
            await db.query(
              `UPDATE messages SET saved_message_id = NULL WHERE account_id = $1 AND saved_message_id = $2`,
              [accountId, oldMessageId]
            );
          } catch (deleteError) {
            console.log(`[SEND_TO_SAVED] Could not delete old message (ID: ${oldMessageId}): ${deleteError?.message || 'Unknown error'}`);
            // Continue anyway - try to send new message
          }
        }
      } catch (queryError) {
        console.log(`[SEND_TO_SAVED] Error checking for old message: ${queryError?.message || 'Unknown error'}`);
        // Continue anyway - try to send new message
      }
      
      // Convert Bot API entities to GramJS entities and fetch emoji documents
      const { Api } = await import('telegram');
      let entities = [];
      let premiumEmojiIds = [];
      
      if (messageEntities && messageEntities.length > 0) {
        for (const entity of messageEntities) {
          try {
            if (entity.type === 'custom_emoji' && entity.custom_emoji_id) {
              // Premium emoji entity
              let emojiId;
              if (typeof entity.custom_emoji_id === 'string') {
                emojiId = BigInt(entity.custom_emoji_id);
              } else if (typeof entity.custom_emoji_id === 'number') {
                emojiId = BigInt(entity.custom_emoji_id);
              } else if (typeof entity.custom_emoji_id === 'bigint') {
                emojiId = entity.custom_emoji_id;
              } else {
                continue;
              }
              
              premiumEmojiIds.push(emojiId);
              
              // Create MessageEntityCustomEmoji exactly as per Telegram API docs
              // CRITICAL: Use the exact offset/length from Bot API (they're already in UTF-16 code units)
              // The Bot API provides these values correctly, so we must preserve them exactly
              const emojiEntity = new Api.MessageEntityCustomEmoji({
                offset: entity.offset,
                length: entity.length,
                documentId: emojiId
              });
              entities.push(emojiEntity);
              console.log(`[SEND_TO_SAVED] ✅ Added premium emoji entity: documentId=BigInt("${emojiId.toString()}"), offset=${entity.offset}, length=${entity.length}`);
            } else if (entity.type === 'bold') {
              entities.push(new Api.MessageEntityBold({
                offset: entity.offset,
                length: entity.length
              }));
            } else if (entity.type === 'italic') {
              entities.push(new Api.MessageEntityItalic({
                offset: entity.offset,
                length: entity.length
              }));
            } else if (entity.type === 'code') {
              entities.push(new Api.MessageEntityCode({
                offset: entity.offset,
                length: entity.length
              }));
            } else if (entity.type === 'pre') {
              entities.push(new Api.MessageEntityPre({
                offset: entity.offset,
                length: entity.length,
                language: entity.language || ''
              }));
            }
          } catch (entityError) {
            console.log(`[SEND_TO_SAVED] Error converting entity: ${entityError.message}`);
          }
        }
        
        // CRITICAL: Fetch premium emoji documents BEFORE sending
        // This grants the account access to use these emojis
        if (premiumEmojiIds.length > 0) {
          console.log(`[SEND_TO_SAVED] 🎨 Fetching ${premiumEmojiIds.length} custom emoji documents to grant access...`);
          try {
            const emojiDocs = await client.invoke(
              new Api.messages.GetCustomEmojiDocuments({
                documentId: premiumEmojiIds
              })
            );
            if (emojiDocs && emojiDocs.length > 0) {
              console.log(`[SEND_TO_SAVED] ✅ Successfully fetched ${emojiDocs.length} emoji documents`);
            }
          } catch (fetchError) {
            console.log(`[SEND_TO_SAVED] ⚠️ Error fetching emoji documents: ${fetchError?.message || 'Unknown'}`);
            // Continue anyway - the send might still work
          }
        }
      }
      
      // Send message to Saved Messages with entities
      let sentMessage;
      if (entities.length > 0) {
        sentMessage = await client.sendMessage(savedMessagesEntity, {
          message: messageText,
          entities: entities
        });
        console.log(`[SEND_TO_SAVED] ✅ Sent message with ${entities.length} entities (including ${premiumEmojiIds.length} premium emojis) to Saved Messages`);
      } else {
        sentMessage = await client.sendMessage(savedMessagesEntity, {
          message: messageText
        });
        console.log(`[SEND_TO_SAVED] Sent message to Saved Messages`);
      }
      
      // Store the message ID in the database
      if (sentMessage && sentMessage.id) {
        try {
          // SQLite doesn't support UPDATE with ORDER BY...LIMIT, so use subquery
          await db.query(
            `UPDATE messages 
             SET saved_message_id = $1 
             WHERE id = (
               SELECT id FROM messages 
               WHERE account_id = $2 AND is_active = TRUE 
               ORDER BY updated_at DESC LIMIT 1
             )`,
            [sentMessage.id, accountId]
          );
          console.log(`[SEND_TO_SAVED] Stored Saved Messages message ID: ${sentMessage.id}`);
        } catch (updateError) {
          console.log(`[SEND_TO_SAVED] Could not store message ID: ${updateError?.message || 'Unknown error'}`);
          // Continue anyway - message was sent successfully
        }
      }
      
      logger.logChange('MESSAGE', accountId, 'Message sent to Saved Messages (for premium emoji access)');
      return { success: true, messageId: sentMessage?.id || null };
    } catch (error) {
      logger.logError('MESSAGE', accountId, error, 'Failed to send message to Saved Messages');
      // Throw the error so calling code can catch it
      throw error;
    }
  }
}

export default new MessageService();
