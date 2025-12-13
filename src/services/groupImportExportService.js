/**
 * Group Import/Export Service
 * Handles importing and exporting group lists
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';
import groupService from './groupService.js';

class GroupImportExportService {
  /**
   * Export groups to JSON
   */
  async exportGroups(accountId) {
    try {
      const groups = await groupService.getGroups(accountId);
      const exportData = {
        accountId,
        exportDate: new Date().toISOString(),
        groups: groups.groups?.map(g => ({
          groupId: g.group_id,
          groupTitle: g.group_title,
          lastMessageSent: g.last_message_sent,
          isActive: g.is_active
        })) || []
      };
      return { success: true, data: exportData, json: JSON.stringify(exportData, null, 2) };
    } catch (error) {
      logger.logError('EXPORT', accountId, error, 'Failed to export groups');
      return { success: false, error: error.message };
    }
  }

  /**
   * Import groups from JSON
   */
  async importGroups(accountId, jsonData) {
    try {
      const importData = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      
      if (!importData.groups || !Array.isArray(importData.groups)) {
        return { success: false, error: 'Invalid import format' };
      }

      let imported = 0;
      let skipped = 0;

      for (const group of importData.groups) {
        try {
          // Check if group already exists
          const existing = await db.query(
            'SELECT id FROM groups WHERE account_id = $1 AND group_id = $2',
            [accountId, group.groupId]
          );

          if (existing.rows.length === 0) {
            await db.query(
              `INSERT INTO groups (account_id, group_id, group_title, last_message_sent, is_active)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (account_id, group_id) DO NOTHING`,
              [accountId, group.groupId, group.groupTitle, group.lastMessageSent, group.isActive !== false]
            );
            imported++;
          } else {
            skipped++;
          }
        } catch (error) {
          logger.logError('IMPORT', accountId, error, `Failed to import group ${group.groupId}`);
          skipped++;
        }
      }

      logger.logChange('IMPORT', accountId, `Imported ${imported} groups, skipped ${skipped}`);
      return { success: true, imported, skipped };
    } catch (error) {
      logger.logError('IMPORT', accountId, error, 'Failed to import groups');
      return { success: false, error: error.message };
    }
  }

  /**
   * Export groups to CSV
   */
  async exportGroupsCSV(accountId) {
    try {
      const groups = await groupService.getGroups(accountId);
      let csv = 'Group ID,Group Title,Last Message Sent,Is Active\n';
      
      groups.groups?.forEach(g => {
        csv += `${g.group_id},"${g.group_title || ''}",${g.last_message_sent || ''},${g.is_active}\n`;
      });

      return { success: true, csv };
    } catch (error) {
      logger.logError('EXPORT', accountId, error, 'Failed to export groups to CSV');
      return { success: false, error: error.message };
    }
  }
}

export default new GroupImportExportService();
