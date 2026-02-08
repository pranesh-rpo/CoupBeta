/**
 * Backup Service
 * Handles account backups and restore
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';
import configService from './configService.js';
import messageService from './messageService.js';
import savedTemplatesService from './savedTemplatesService.js';

class BackupService {
  /**
   * Create backup
   */
  async createBackup(accountId, backupName) {
    try {
      // Collect all account data
      const settings = await configService.getAccountSettings(accountId);
      const messages = await messageService.getABMessages(accountId);
      const templates = await savedTemplatesService.getSavedTemplates(accountId);
      
      const backupData = {
        settings,
        messages,
        templates,
        timestamp: new Date().toISOString()
      };
      
      const result = await db.query(
        `INSERT INTO account_backups (account_id, backup_name, backup_data)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id, backup_name) DO UPDATE
         SET backup_data = EXCLUDED.backup_data
         RETURNING *`,
        [accountId, backupName, JSON.stringify(backupData)]
      );
      
      logger.logChange('BACKUP', accountId, `Created backup: ${backupName}`);
      return { success: true, backup: result.rows[0] };
    } catch (error) {
      logger.logError('BACKUP', accountId, error, 'Failed to create backup');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all backups
   */
  async getBackups(accountId) {
    try {
      const result = await db.query(
        `SELECT id, backup_name, created_at FROM account_backups 
         WHERE account_id = $1 ORDER BY created_at DESC`,
        [accountId]
      );
      return { success: true, backups: result.rows };
    } catch (error) {
      logger.logError('BACKUP', accountId, error, 'Failed to get backups');
      return { success: false, error: error.message, backups: [] };
    }
  }

  /**
   * Restore backup
   */
  async restoreBackup(accountId, backupName) {
    try {
      const result = await db.query(
        `SELECT backup_data FROM account_backups 
         WHERE account_id = $1 AND backup_name = $2`,
        [accountId, backupName]
      );
      
      if (result.rows.length === 0) {
        return { success: false, error: 'Backup not found' };
      }
      
      const backupData = typeof result.rows[0]?.backup_data === 'string' 
        ? JSON.parse(result.rows[0]?.backup_data || '{}') 
        : result.rows[0]?.backup_data;
      
      // Restore settings
      if (backupData.settings) {
        // Restore settings logic here
      }
      
      // Restore messages
      if (backupData.messages) {
        if (backupData.messages.messageA) {
          await messageService.saveMessage(accountId, backupData.messages.messageA, 'A');
        }
        if (backupData.messages.messageB) {
          await messageService.saveMessage(accountId, backupData.messages.messageB, 'B');
        }
      }
      
      logger.logChange('BACKUP', accountId, `Restored backup: ${backupName}`);
      return { success: true };
    } catch (error) {
      logger.logError('BACKUP', accountId, error, 'Failed to restore backup');
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete backup
   */
  async deleteBackup(accountId, backupName) {
    try {
      await db.query(
        `DELETE FROM account_backups WHERE account_id = $1 AND backup_name = $2`,
        [accountId, backupName]
      );
      logger.logChange('BACKUP', accountId, `Deleted backup: ${backupName}`);
      return { success: true };
    } catch (error) {
      logger.logError('BACKUP', accountId, error, 'Failed to delete backup');
      return { success: false, error: error.message };
    }
  }
}

export default new BackupService();
