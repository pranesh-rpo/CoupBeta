import db from '../database/db.js';
import { logError } from '../utils/logger.js';

class MessageManager {
  constructor() {
    this.userMessages = new Map(); // userId -> { startMessage }
    this.initialized = false;
  }

  async initialize() {
    if (!this.initialized) {
      await this.loadMessages();
      this.initialized = true;
    }
  }

  async loadMessages() {
    try {
      // Check if messages table has user_id (old schema) or account_id (new schema)
      const columnsCheck = await db.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'messages' AND column_name IN ('user_id', 'account_id', 'start_message', 'message_text')
      `);
      
      const hasUserId = columnsCheck.rows.some(r => r.column_name === 'user_id');
      const hasStartMessage = columnsCheck.rows.some(r => r.column_name === 'start_message');
      
      // If old schema exists, load from it
      if (hasUserId && hasStartMessage) {
        const result = await db.query('SELECT user_id, start_message FROM messages');
        
        for (const row of result.rows) {
          this.userMessages.set(row.user_id.toString(), {
            startMessage: row.start_message,
          });
        }
      } else {
        // New schema - messages are account-based, not user-based
        // This manager is legacy, so we'll just skip loading
        console.log('[MESSAGE MANAGER] New schema detected (account-based). Skipping legacy user-based message loading.');
      }
    } catch (error) {
      logError('Error loading messages from database:', error);
    }
  }

  async setStartMessage(userId, message) {
    try {
      // Legacy method - messages are now account-based via messageService
      // This is kept for backward compatibility but doesn't actually save
      // The actual saving is done via messageService.saveMessage()
      const userIdStr = userId.toString();
      
      // Update in-memory cache only (for backward compatibility)
      if (!this.userMessages.has(userIdStr)) {
        this.userMessages.set(userIdStr, {});
      }
      const userData = this.userMessages.get(userIdStr);
      userData.startMessage = message;

      console.log('[MESSAGE MANAGER] Legacy setStartMessage called. Use messageService.saveMessage() for account-based messages.');
      return true;
    } catch (error) {
      logError('Error saving start message to database:', error);
      return false;
    }
  }

  getStartMessage(userId) {
    const userIdStr = userId.toString();
    const userData = this.userMessages.get(userIdStr);
    return userData?.startMessage || 'Broadcast message';
  }

  getUserMessages(userId) {
    const userIdStr = userId.toString();
    return this.userMessages.get(userIdStr) || {};
  }
}

export default new MessageManager();
